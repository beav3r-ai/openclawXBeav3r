import express from 'express';
import { Beav3rClient } from './adapters/beav3r-client';
import { chooseRoute, unavailableFallback } from './policy/router';
import { ApprovalRecord, ApprovalStore, InMemoryApprovalStore } from './state/store';
import { BridgeConfig, CallbackDecision, HandoffPayloadV1 } from './types/contracts';
import { hmac } from './utils/signature';

export class OpenClawBeav3rBridge {
  private requestToApproval = new Map<string, string>();
  private approvalToRequest = new Map<string, string>();
  private callbackDedupe = new Set<string>();
  private timer?: NodeJS.Timeout;

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

    app.post('/handoff', async (req, res) => {
      const p = req.body as HandoffPayloadV1;
      const required = [p?.version, p?.approvalId, p?.actionHash, p?.idempotencyKey, p?.callback?.url];
      if (required.some((v) => !v)) return res.status(400).json({ error: 'invalid payload' });

      const existing = this.store.getByIdempotency(p.idempotencyKey);
      if (existing) {
        return res.json({ approvalId: existing.approvalId, status: 'accepted', route: existing.route, queued: existing.route === 'beav3r' });
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

          try {
            await this.beav3r.fetchDecision(recoverableRequestId);
            rec.state = 'pending';
            this.log('handoff.request_uncertain', {
              approvalId: p.approvalId,
              requestId: recoverableRequestId,
              error: error instanceof Error ? error.message : 'unknown error',
            });
          } catch {
            const fb = unavailableFallback(p, this.cfg);
            if (fb === 'deny') {
              await this.sendCallback(p.callback.url, {
                approvalId: p.approvalId,
                status: 'denied',
                decision: 'deny',
                decidedAt: Math.floor(Date.now() / 1000),
                approver: { deviceId: 'bridge', publicKey: 'local', assurance: 'software' },
                signature: { scheme: 'ed25519', value: 'fallback-deny' },
                reason: 'Beav3r unavailable fallback deny',
                expiresAt: p.expiry,
              });
              rec.state = 'denied';
            } else {
              route = 'local';
              queued = false;
              rec.route = 'local';
            }
          }
        }
      }

      this.store.putIdempotency(p.idempotencyKey, rec);
      this.log('handoff.accepted', { approvalId: p.approvalId, route, queued });
      return res.json({ approvalId: p.approvalId, status: 'accepted', route, queued });
    });

    app.post('/beav3r/webhook', async (req, res) => {
      const body = req.body as { requestId: string; status: 'approved' | 'denied'; reason?: string; signature?: string; approver?: CallbackDecision['approver'] };
      const approvalId = this.requestToApproval.get(body.requestId);
      if (!approvalId) return res.status(404).json({ error: 'unknown request' });
      const rec = this.store.get(approvalId);
      if (!rec) return res.status(404).json({ error: 'missing approval' });
      if (['approved', 'denied', 'expired', 'timeout'].includes(rec.state)) return res.status(202).json({ status: 'duplicate_ignored' });

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
        this.log('beav3r.fetch_failed', { approvalId, requestId });
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
        this.log('approval.stuck_reconciled', { approvalId, pendingForSec, requestId });
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
    await this.sendCallback(url, cb);
  }

  private async sendCallback(url: string, cb: CallbackDecision) {
    const raw = JSON.stringify(cb);
    const sig = hmac(raw, this.cfg.callback.secret);

    for (let i = 0; i <= this.cfg.callback.retries; i++) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ocb-signature': sig }, body: raw });
        if (res.ok || res.status === 202) return;
      } catch {
        // noop
      }
      await new Promise((r) => setTimeout(r, this.cfg.callback.backoffMs * (i + 1)));
    }
    this.log('callback.delivery_failed', { approvalId: cb.approvalId });
  }

  private log(event: string, data: Record<string, unknown>) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'openclaw-beav3r-bridge', event, ...data }));
  }
}
