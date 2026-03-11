import express from 'express';
import { Beav3rClient } from './adapters/beav3r-client';
import { chooseRoute, unavailableFallback } from './policy/router';
import { ApprovalRecord, ApprovalStore, InMemoryApprovalStore } from './state/store';
import { BridgeConfig, CallbackDecision, HandoffPayloadV1 } from './types/contracts';
import { logger } from './utils/logger';
import { hmac } from './utils/signature';
import { BridgeHandoffResponse } from '../../openclaw-approvals/src/types/contracts';

type BridgeMetrics = {
  handoffAcceptedTotal: number;
  handoffAcceptedBeav3rTotal: number;
  handoffAcceptedLocalTotal: number;
  fetchDecisionErrorsTotal: number;
  callbackDeliveryFailedTotal: number;
  reconciledPendingTimeoutTotal: number;
  deliveredTerminalTotal: number;
  deliveredByStatus: Record<string, number>;
  reconciliationLatencyMsCount: number;
  reconciliationLatencyMsSum: number;
};

export class OpenClawBeav3rBridge {
  private requestToApproval = new Map<string, string>();
  private approvalToRequest = new Map<string, string>();
  private callbackDedupe = new Set<string>();
  private timer?: NodeJS.Timeout;
  private metrics: BridgeMetrics = {
    handoffAcceptedTotal: 0,
    handoffAcceptedBeav3rTotal: 0,
    handoffAcceptedLocalTotal: 0,
    fetchDecisionErrorsTotal: 0,
    callbackDeliveryFailedTotal: 0,
    reconciledPendingTimeoutTotal: 0,
    deliveredTerminalTotal: 0,
    deliveredByStatus: {},
    reconciliationLatencyMsCount: 0,
    reconciliationLatencyMsSum: 0,
  };

  constructor(private readonly cfg: BridgeConfig, private readonly beav3r: Beav3rClient, private readonly store: ApprovalStore = new InMemoryApprovalStore()) {}

  startStateLoop() {
    this.timer = setInterval(() => this.tick().catch(() => undefined), this.cfg.timeouts.pollMs);
  }

  stopStateLoop() {
    if (this.timer) clearInterval(this.timer);
  }

  app() {
    const app = express();
    app.use(express.json());

    app.get('/metrics', (_req, res) => {
      res.json(this.metricsSnapshot());
    });

    app.post('/handoff', async (req, res) => {
      const p = req.body as HandoffPayloadV1;
      const required = [p?.version, p?.approvalId, p?.actionHash, p?.idempotencyKey, p?.callback?.url];
      if (required.some((v) => !v)) return res.status(400).json({ error: 'invalid payload' });

      const existing = this.store.getByIdempotency(p.idempotencyKey);
      if (existing) {
        return res.json(this.toHandoffResponse(existing));
      }

      let route = chooseRoute(p, this.cfg);
      let queued = route === 'beav3r';
      const rec: ApprovalRecord = { approvalId: p.approvalId, route, state: 'accepted', payload: p, updatedAt: Date.now() };

      if (route === 'beav3r') {
        try {
          const reqId = await this.beav3r.createDecisionRequest(p);
          this.requestToApproval.set(reqId.requestId, p.approvalId);
          this.approvalToRequest.set(p.approvalId, reqId.requestId);
          rec.state = 'pending';
        } catch (error) {
          const recoverableRequestId = p.approvalId;
          this.requestToApproval.set(recoverableRequestId, p.approvalId);
          this.approvalToRequest.set(p.approvalId, recoverableRequestId);
          logger.warn('handoff.beav3r_request_failed', {
            approvalId: p.approvalId,
            requestId: recoverableRequestId,
            error: error instanceof Error ? error.message : 'unknown error',
          });

          try {
            const recoveredDecision = await this.beav3r.fetchDecision(recoverableRequestId);
            if (recoveredDecision === null) {
              throw new Error('recovery lookup found no action');
            }
            rec.state = 'pending';
            logger.warn('handoff.request_uncertain', {
              approvalId: p.approvalId,
              requestId: recoverableRequestId,
              error: error instanceof Error ? error.message : 'unknown error',
            });
          } catch {
            const fb = unavailableFallback(p, this.cfg);
            if (fb === 'deny') {
              const callback: CallbackDecision = {
                approvalId: p.approvalId,
                status: 'denied',
                decision: 'deny',
                decidedAt: Math.floor(Date.now() / 1000),
                approver: { deviceId: 'bridge', publicKey: 'local', assurance: 'software' },
                signature: { scheme: 'ed25519', value: 'fallback-deny' },
                reason: 'Beav3r unavailable fallback deny',
                expiresAt: p.expiry,
              };
              await this.sendCallback(p.callback.url, callback);
              rec.state = 'denied';
              rec.terminal = callback;
              rec.updatedAt = Date.now();
              logger.warn('handoff.fallback_denied', {
                approvalId: p.approvalId,
                route,
                reason: callback.reason,
              });
            } else {
              route = 'local';
              queued = false;
              rec.route = 'local';
              rec.updatedAt = Date.now();
              logger.warn('handoff.fallback_local', {
                approvalId: p.approvalId,
                reason: 'Beav3r unavailable fallback local',
              });
            }
          }
        }
      }

      this.store.putIdempotency(p.idempotencyKey, rec);
      this.metrics.handoffAcceptedTotal += 1;
      if (route === 'beav3r') this.metrics.handoffAcceptedBeav3rTotal += 1;
      if (route === 'local') this.metrics.handoffAcceptedLocalTotal += 1;
      const response = this.toHandoffResponse(rec);
      logger.info('handoff.accepted', {
        approvalId: p.approvalId,
        route: response.route,
        queued: response.queued,
        status: response.status,
        reason: response.reason,
      });
      return res.json(response);
    });

    app.post('/beav3r/webhook', async (req, res) => {
      logger.debug('beav3r.webhook.received', {
        body: req.body as Record<string, unknown>,
      });
      const body = req.body as { requestId: string; status: 'approved' | 'denied'; reason?: string; signature?: string; approver?: CallbackDecision['approver'] };
      const approvalId = this.requestToApproval.get(body.requestId);
      if (!approvalId) {
        logger.warn('beav3r.webhook.unknown_request', {
          requestId: body.requestId,
          status: body.status,
          reason: body.reason,
        });
        return res.status(404).json({ error: 'unknown request' });
      }
      const rec = this.store.get(approvalId);
      if (!rec) {
        logger.warn('beav3r.webhook.missing_approval', {
          approvalId,
          requestId: body.requestId,
        });
        return res.status(404).json({ error: 'missing approval' });
      }
      if (['approved', 'denied', 'expired', 'timeout'].includes(rec.state)) {
        logger.debug('beav3r.webhook.duplicate_ignored', {
          approvalId,
          requestId: body.requestId,
          state: rec.state,
        });
        return res.status(202).json({ status: 'duplicate_ignored' });
      }

      const callback: CallbackDecision = {
        approvalId,
        status: body.status,
        decision: body.status === 'approved' ? 'allow-once' : 'deny',
        decidedAt: Math.floor(Date.now() / 1000),
        approver: body.approver ?? { deviceId: 'beav3r', publicKey: 'base64', assurance: 'software' },
        signature: { scheme: 'ed25519', value: body.signature ?? 'base64_sig_over_actionHash' },
        reason: body.reason,
        expiresAt: rec.payload.expiry,
      };

      logger.info('beav3r.webhook.forwarding_terminal_callback', {
        approvalId,
        requestId: body.requestId,
        status: body.status,
        callbackUrl: rec.payload.callback.url,
      });
      await this.deliverTerminal(rec.payload.callback.url, callback);
      return res.json({ status: 'ok' });
    });

    return app;
  }

  async tick() {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const rec of this.store.listPending()) {
      const approvalId = rec.approvalId;
      const requestId = this.approvalToRequest.get(approvalId) ?? approvalId;

      try {
        const decision = await this.beav3r.fetchDecision(requestId);
        if (decision) {
          await this.deliverTerminal(rec.payload.callback.url, {
            approvalId,
            status: decision.status,
            decision: decision.status === 'approved' ? 'allow-once' : 'deny',
            decidedAt: nowSec,
            approver:
              decision.approver ?? {
                deviceId: 'beav3r',
                publicKey: 'base64',
                assurance: 'software',
              },
            signature: {
              scheme: 'ed25519',
              value: decision.signature ?? `beav3r-${decision.status}`,
            },
            reason: decision.reason,
            expiresAt: rec.payload.expiry,
          });
          continue;
        }
      } catch {
        this.metrics.fetchDecisionErrorsTotal += 1;
        logger.warn('beav3r.fetch_failed', { approvalId, requestId });
      }

      if (nowSec > rec.payload.expiry + this.cfg.timeouts.expireSkewSec) {
        await this.deliverTerminal(rec.payload.callback.url, {
          approvalId,
          status: 'expired',
          decision: 'deny',
          decidedAt: nowSec,
          approver: { deviceId: 'bridge-timeout', publicKey: 'local', assurance: 'software' },
          signature: { scheme: 'ed25519', value: 'expired' },
          reason: 'Approval expired before decision',
          expiresAt: rec.payload.expiry,
        });
        continue;
      }

      const pendingForSec = Math.max(0, nowSec - Math.floor(rec.updatedAt / 1000));
      if (pendingForSec >= this.cfg.timeouts.pendingTimeoutSec) {
        const reconciliationLatencyMs = Date.now() - rec.updatedAt;
        this.metrics.reconciledPendingTimeoutTotal += 1;
        this.metrics.reconciliationLatencyMsCount += 1;
        this.metrics.reconciliationLatencyMsSum += reconciliationLatencyMs;
        logger.warn('approval.stuck_reconciled', { approvalId, pendingForSec, requestId, reconciliationLatencyMs });
        await this.deliverTerminal(rec.payload.callback.url, {
          approvalId,
          status: 'timeout',
          decision: 'deny',
          decidedAt: nowSec,
          approver: { deviceId: 'bridge-reconciler', publicKey: 'local', assurance: 'software' },
          signature: { scheme: 'ed25519', value: 'pending-timeout' },
          reason: `Approval pending longer than ${this.cfg.timeouts.pendingTimeoutSec}s`,
          expiresAt: rec.payload.expiry,
        });
      }
    }
  }

  private async deliverTerminal(url: string, cb: CallbackDecision) {
    const key = `${cb.approvalId}:${cb.status}:${cb.decidedAt}:${cb.signature.value}`;
    if (this.callbackDedupe.has(key)) return;
    this.callbackDedupe.add(key);
    this.store.markTerminal(cb.approvalId, cb);
    this.metrics.deliveredTerminalTotal += 1;
    this.metrics.deliveredByStatus[cb.status] = (this.metrics.deliveredByStatus[cb.status] ?? 0) + 1;
    await this.sendCallback(url, cb);
  }

  private async sendCallback(url: string, cb: CallbackDecision) {
    const raw = JSON.stringify(cb);
    const sig = hmac(raw, this.cfg.callback.secret);

    for (let i = 0; i <= this.cfg.callback.retries; i++) {
      try {
        logger.debug('callback.delivery_attempt', {
          approvalId: cb.approvalId,
          status: cb.status,
          url,
          attempt: i + 1,
        });
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ocb-signature': sig }, body: raw });
        if (res.ok || res.status === 202) {
          logger.info('callback.delivery_succeeded', {
            approvalId: cb.approvalId,
            status: cb.status,
            url,
            httpStatus: res.status,
            attempt: i + 1,
          });
          return;
        }
        logger.warn('callback.delivery_non_ok', {
          approvalId: cb.approvalId,
          status: cb.status,
          url,
          httpStatus: res.status,
          attempt: i + 1,
        });
      } catch {
        logger.warn('callback.delivery_exception', {
          approvalId: cb.approvalId,
          status: cb.status,
          url,
          attempt: i + 1,
        });
      }
      await new Promise((r) => setTimeout(r, this.cfg.callback.backoffMs * (i + 1)));
    }
    this.metrics.callbackDeliveryFailedTotal += 1;
    logger.error('callback.delivery_failed', { approvalId: cb.approvalId });
  }

  private metricsSnapshot() {
    return {
      ...this.metrics,
      reconciliationLatencyMsAvg:
        this.metrics.reconciliationLatencyMsCount > 0
          ? this.metrics.reconciliationLatencyMsSum / this.metrics.reconciliationLatencyMsCount
          : 0,
    };
  }

  private toHandoffResponse(rec: ApprovalRecord): BridgeHandoffResponse {
    const queued = rec.route === 'beav3r' && rec.state === 'pending';
    if (rec.state === 'denied') {
      return {
        approvalId: rec.approvalId,
        status: 'denied',
        route: rec.route,
        queued,
        reason: rec.terminal?.reason ?? 'Approval denied',
      };
    }

    return {
      approvalId: rec.approvalId,
      status: 'accepted',
      route: rec.route,
      queued,
      reason: rec.route === 'local' && !queued ? 'Beav3r unavailable fallback local' : undefined,
    };
  }
}
