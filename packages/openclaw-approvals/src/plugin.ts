import express from 'express';
import { PluginConfig } from './config/types';
import { OpenClawResolverAdapter } from './adapters/resolver';
import { BridgeHandoffResponse, CallbackDecision, ResolveDecision } from './types/contracts';
import { normalizeApprovalPayload, OpenClawApprovalInput } from './normalize';
import { verifyHmac } from './utils/signature';
import { logger } from './utils/logger';
import { ApprovalRequestedEventSource } from './adapters/event-source';

export function mapCallbackToResolve(decision: CallbackDecision): ResolveDecision {
  if (decision.status === 'approved' && decision.decision === 'allow-once') return 'allow_once';
  if (decision.status === 'denied' || decision.decision === 'deny') return 'deny';
  if (decision.status === 'timeout') return 'timeout';
  return 'expired';
}

export class OpenClawApprovalsPlugin {
  private seenCallbacks = new Set<string>();

  constructor(private readonly cfg: PluginConfig, private readonly resolver: OpenClawResolverAdapter) {}

  bindApprovalRequested(source: ApprovalRequestedEventSource, callbackUrl: string) {
    source.onApprovalRequested(async (evt) => {
      logger.debug('approval.event_received', { approvalId: evt.approvalId, risk: evt.risk?.level, score: evt.risk?.score });
      const handoff = await this.handoff(evt, callbackUrl);
      logger.info('approval.route_chosen', {
        approvalId: evt.approvalId,
        status: handoff.status,
        route: handoff.route,
        queued: handoff.queued,
        reason: handoff.reason,
      });
    });
  }

  async handoff(input: OpenClawApprovalInput, callbackUrl: string): Promise<BridgeHandoffResponse> {
    const payload = normalizeApprovalPayload(input, this.cfg, callbackUrl);
    logger.info('approval.handoff_sent', { approvalId: input.approvalId, bridgeUrl: this.cfg.bridge.bridgeUrl ?? 'http://localhost:4400' });
    const res = await fetch(`${this.cfg.bridge.bridgeUrl ?? 'http://localhost:4400'}/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Bridge handoff failed: ${res.status}`);
    return (await res.json()) as BridgeHandoffResponse;
  }

  callbackRouter() {
    const router = express.Router();

    router.post('/callback/openclaw-resolve', express.text({ type: 'application/json' }), async (req, res) => {
      const sig = req.header('x-ocb-signature') ?? '';
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!verifyHmac(raw, this.cfg.bridge.callbackSecret, sig)) {
        return res.status(401).json({ error: 'invalid signature' });
      }

      let body: CallbackDecision;
      try {
        body = JSON.parse(raw) as CallbackDecision;
      } catch {
        return res.status(400).json({ error: 'invalid callback payload' });
      }
      logger.info('approval.callback_received', { approvalId: body.approvalId, status: body.status, decision: body.decision });
      const dedupeKey = `${body.approvalId}:${body.decidedAt}:${body.signature.value}`;
      if (this.seenCallbacks.has(dedupeKey)) {
        logger.debug('approval.callback_duplicate_ignored', { approvalId: body.approvalId, status: body.status });
        return res.status(202).json({ status: 'duplicate_ignored' });
      }
      this.seenCallbacks.add(dedupeKey);

      const mapped = mapCallbackToResolve(body);
      logger.info('approval.resolve_called', { approvalId: body.approvalId, decision: mapped });
      try {
        await this.resolver.resolveApproval({
          approvalId: body.approvalId,
          decision: mapped,
          reason: body.reason,
          metadata: body as unknown as Record<string, unknown>,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('approval.resolve_failed', {
          approvalId: body.approvalId,
          decision: mapped,
          message,
        });
        return res.status(502).json({ error: message });
      }
      logger.info('approval.resolve_result', { approvalId: body.approvalId, status: 'resolved' });
      return res.status(200).json({ status: 'resolved' });
    });

    return router;
  }
}
