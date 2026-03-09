import { PluginConfig } from './config/types';
import { computeActionHash } from './utils/canonical';
import { HandoffPayloadV1 } from './types/contracts';

export interface OpenClawApprovalInput {
  approvalId: string;
  action: {
    tool: string;
    command: string;
    cwd?: string;
    host?: string;
    node?: string | null;
    systemRunPlan?: Record<string, unknown>;
  };
  risk: { score: number; level: HandoffPayloadV1['risk']['level']; reasons?: string[] };
  actor: HandoffPayloadV1['actor'];
  environment: HandoffPayloadV1['environment'];
  expiry: number;
  nonce: string;
  reason: string;
  idempotencyKey: string;
}

export function normalizeApprovalPayload(
  input: OpenClawApprovalInput,
  cfg: PluginConfig,
  callbackUrl: string
): HandoffPayloadV1 {
  const action = {
    tool: input.action.tool,
    command: input.action.command,
    cwd: input.action.cwd,
    host: input.action.host,
    node: input.action.node ?? null,
    systemRunPlan: input.action.systemRunPlan ?? {},
  };

  const actionHash = computeActionHash({
    action,
    actor: input.actor,
    environment: input.environment,
    expiry: input.expiry,
    nonce: input.nonce,
  });

  return {
    version: 'v1',
    approvalId: input.approvalId,
    actionHash,
    action,
    risk: { ...input.risk, reasons: input.risk.reasons ?? [] },
    actor: input.actor,
    environment: input.environment,
    expiry: input.expiry,
    nonce: input.nonce,
    reason: input.reason,
    callback: {
      url: callbackUrl,
      auth: { type: 'hmac-sha256', keyId: cfg.bridge.callbackKeyId ?? 'k1' },
    },
    idempotencyKey: input.idempotencyKey,
  };
}
