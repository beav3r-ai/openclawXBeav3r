export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface HandoffPayloadV1 {
  version: 'v1';
  approvalId: string;
  actionHash: string;
  action: { tool: string; command: string; cwd?: string; host?: string; node: string | null; systemRunPlan: Record<string, unknown> };
  risk: { score: number; level: RiskLevel; reasons: string[] };
  actor: { agentId: string; sessionId: string; senderId: string; channel: string };
  environment: { workspace: string; hostname: string; envClass: string };
  expiry: number;
  nonce: string;
  reason: string;
  callback: { url: string; auth: { type: 'hmac-sha256'; keyId: string } };
  idempotencyKey: string;
}

export interface CallbackDecision {
  approvalId: string;
  status: 'approved' | 'denied' | 'expired' | 'timeout';
  decision: 'allow-once' | 'deny';
  decidedAt: number;
  approver: { deviceId: string; publicKey: string; assurance: 'software' | 'hardware' };
  signature: { scheme: 'ed25519'; value: string };
  reason?: string;
  expiresAt: number;
}

export type Route = 'local' | 'beav3r';
export type ApprovalState = 'accepted' | 'pending' | 'approved' | 'denied' | 'expired' | 'timeout';

export interface BridgeConfig {
  riskThresholds: { localMax: number; beav3rMin: number };
  envOverrides: Record<string, Route>;
  fallbackPolicy: Partial<Record<RiskLevel, 'local' | 'deny'>>;
  beav3r: { baseUrl: string; timeoutMs: number; enabled?: boolean };
  callback: { secret: string; retries: number; backoffMs: number };
  timeouts: { pollMs: number; expireSkewSec: number; pendingTimeoutSec: number };
}
