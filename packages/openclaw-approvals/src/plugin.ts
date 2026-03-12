import express from 'express';
import { PluginConfig } from './config/types';
import { OpenClawResolverAdapter } from './adapters/resolver';
import { BridgeHandoffResponse, CallbackDecision, ResolveDecision } from './types/contracts';
import { normalizeApprovalPayload, OpenClawApprovalInput } from './normalize';
import { verifyHmac } from './utils/signature';
import { logger } from './utils/logger';
import { ApprovalRequestedEventSource } from './adapters/event-source';
import { computeActionHash } from './utils/canonical';

class HandoffError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
  }
}

class HandoffResponseError extends Error {}

type ApprovalLogContext = {
  approvalId: string;
  idempotencyKey?: string;
  actionHash?: string;
  callbackUrl?: string;
  route?: BridgeHandoffResponse['route'];
  routeReason?: string;
  bridgeUrl?: string;
  riskLevel?: OpenClawApprovalInput['risk']['level'];
  riskScore?: number;
  tool?: string;
  envClass?: string;
  attempt?: number;
  status?: CallbackDecision['status'] | BridgeHandoffResponse['status'];
  decision?: CallbackDecision['decision'] | ResolveDecision;
};

type CallbackValidation =
  | { ok: true; resolveDecision: ResolveDecision }
  | { ok: false; reasonCode: string; message: string };

export function mapCallbackToResolve(decision: CallbackDecision): ResolveDecision {
  const validation = validateCallbackDecision(decision);
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  return validation.resolveDecision;
}

export class OpenClawApprovalsPlugin {
  private seenCallbacks = new Set<string>();
  private handoffRetryTimers = new Map<string, NodeJS.Timeout>();
  private handoffRetryAttempts = new Map<string, number>();

  constructor(private readonly cfg: PluginConfig, private readonly resolver: OpenClawResolverAdapter) {}

  bindApprovalRequested(source: ApprovalRequestedEventSource, callbackUrl: string) {
    source.onApprovalRequested(async (evt) => {
      logger.debug(
        'approval.event_received',
        buildApprovalLogContext(evt, {
          callbackUrl,
          bridgeUrl: this.cfg.bridge.bridgeUrl ?? 'http://localhost:4400',
        })
      );
      await this.processHandoff(evt, callbackUrl);
    });
  }

  async handoff(input: OpenClawApprovalInput, callbackUrl: string): Promise<BridgeHandoffResponse> {
    const payload = normalizeApprovalPayload(input, this.cfg, callbackUrl);
    logger.info(
      'approval.handoff_sent',
      buildApprovalLogContext(input, {
        actionHash: payload.actionHash,
        callbackUrl,
        bridgeUrl: this.cfg.bridge.bridgeUrl ?? 'http://localhost:4400',
      })
    );
    const res = await fetch(`${this.cfg.bridge.bridgeUrl ?? 'http://localhost:4400'}/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new HandoffError(`Bridge handoff failed: ${res.status}`, res.status);
    try {
      return (await res.json()) as BridgeHandoffResponse;
    } catch (error) {
      throw new HandoffResponseError(error instanceof Error ? error.message : String(error));
    }
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
      logger.info('approval.callback_received', {
        approvalId: body.approvalId,
        status: body.status,
        decision: body.decision,
        decidedAt: body.decidedAt,
        signature: body.signature.value,
      });
      const validation = validateCallbackDecision(body);
      if (!validation.ok) {
        logger.warn('approval.callback_rejected', {
          approvalId: body.approvalId,
          status: body.status,
          decision: body.decision,
          reasonCode: validation.reasonCode,
          message: validation.message,
        });
        return res.status(400).json({ error: validation.message });
      }
      const dedupeKey = `${body.approvalId}:${body.decidedAt}:${body.signature.value}`;
      if (this.seenCallbacks.has(dedupeKey)) {
        logger.debug('approval.callback_duplicate_ignored', { approvalId: body.approvalId, status: body.status });
        return res.status(202).json({ status: 'duplicate_ignored' });
      }
      const mapped = validation.resolveDecision;
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
      this.seenCallbacks.add(dedupeKey);
      logger.info('approval.resolve_result', { approvalId: body.approvalId, status: 'resolved', decision: mapped });
      return res.status(200).json({ status: 'resolved' });
    });

    return router;
  }

  private async processHandoff(input: OpenClawApprovalInput, callbackUrl: string): Promise<void> {
    try {
      const handoff = await this.handoff(input, callbackUrl);
      this.clearHandoffRetry(input.approvalId);
      logger.info('approval.route_chosen', {
        ...buildApprovalLogContext(input, {
          callbackUrl,
          bridgeUrl: this.cfg.bridge.bridgeUrl ?? 'http://localhost:4400',
          route: handoff.route,
          routeReason: handoff.routeReason,
        }),
        status: handoff.status,
        queued: handoff.queued,
        reason: handoff.reason,
      });
    } catch (error) {
      logger.warn('approval.handoff_failed', {
        ...buildApprovalLogContext(input, {
          callbackUrl,
          bridgeUrl: this.cfg.bridge.bridgeUrl ?? 'http://localhost:4400',
        }),
        message: error instanceof Error ? error.message : String(error),
      });
      if (this.shouldRetryHandoff(error)) {
        this.scheduleHandoffRetry(input, callbackUrl);
      }
    }
  }

  private shouldRetryHandoff(error: unknown): boolean {
    if (!(error instanceof HandoffError)) {
      return !(error instanceof HandoffResponseError);
    }

    if (error.statusCode === undefined) {
      return true;
    }

    return error.statusCode >= 500;
  }

  private scheduleHandoffRetry(input: OpenClawApprovalInput, callbackUrl: string): void {
    if (this.handoffRetryTimers.has(input.approvalId)) {
      return;
    }

    const attempt = this.handoffRetryAttempts.get(input.approvalId) ?? 0;
    const delayMs = Math.min(1000 * 2 ** attempt, 15000);
    this.handoffRetryAttempts.set(input.approvalId, attempt + 1);
    logger.info('approval.handoff_retry_scheduled', {
      ...buildApprovalLogContext(input, {
        callbackUrl,
        bridgeUrl: this.cfg.bridge.bridgeUrl ?? 'http://localhost:4400',
        attempt: attempt + 1,
      }),
      delayMs,
    });
    const timer = setTimeout(() => {
      this.handoffRetryTimers.delete(input.approvalId);
      void this.processHandoff(input, callbackUrl);
    }, delayMs);
    this.handoffRetryTimers.set(input.approvalId, timer);
  }

  private clearHandoffRetry(approvalId: string): void {
    const timer = this.handoffRetryTimers.get(approvalId);
    if (timer) {
      clearTimeout(timer);
      this.handoffRetryTimers.delete(approvalId);
    }
    this.handoffRetryAttempts.delete(approvalId);
  }
}

function buildApprovalLogContext(input: OpenClawApprovalInput, extra: Partial<ApprovalLogContext> = {}): ApprovalLogContext {
  return {
    approvalId: input.approvalId,
    idempotencyKey: input.idempotencyKey,
    actionHash: extra.actionHash ?? computeActionHash({
      action: {
        tool: input.action.tool,
        command: input.action.command,
        cwd: input.action.cwd,
        host: input.action.host,
        node: input.action.node ?? null,
        systemRunPlan: input.action.systemRunPlan ?? {},
      },
      actor: input.actor,
      environment: input.environment,
      expiry: input.expiry,
      nonce: input.nonce,
    }),
    callbackUrl: extra.callbackUrl,
    route: extra.route,
    routeReason: extra.routeReason,
    bridgeUrl: extra.bridgeUrl,
    riskLevel: input.risk.level,
    riskScore: input.risk.score,
    tool: input.action.tool,
    envClass: input.environment.envClass,
    attempt: extra.attempt,
    status: extra.status,
    decision: extra.decision,
  };
}

function validateCallbackDecision(decision: CallbackDecision): CallbackValidation {
  switch (decision.status) {
    case 'approved':
      if (decision.decision !== 'allow-once') {
        return {
          ok: false,
          reasonCode: 'invalid_decision_for_status',
          message: 'approved callbacks must use allow-once decision',
        };
      }
      return { ok: true, resolveDecision: 'allow_once' };
    case 'denied':
      if (decision.decision !== 'deny') {
        return {
          ok: false,
          reasonCode: 'invalid_decision_for_status',
          message: 'denied callbacks must use deny decision',
        };
      }
      return { ok: true, resolveDecision: 'deny' };
    case 'expired':
      if (decision.decision !== 'deny') {
        return {
          ok: false,
          reasonCode: 'invalid_decision_for_status',
          message: 'expired callbacks must use deny decision',
        };
      }
      return { ok: true, resolveDecision: 'expired' };
    case 'timeout':
      if (decision.decision !== 'deny') {
        return {
          ok: false,
          reasonCode: 'invalid_decision_for_status',
          message: 'timeout callbacks must use deny decision',
        };
      }
      return { ok: true, resolveDecision: 'timeout' };
  }
}
