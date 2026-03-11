export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface CanonicalAction {
  tool: string;
  command: string;
  cwd?: string;
  host?: string;
  node: string | null;
  systemRunPlan: Record<string, unknown>;
}

export interface HandoffPayloadV1 {
  version: 'v1';
  approvalId: string;
  actionHash: string;
  action: CanonicalAction;
  risk: { score: number; level: RiskLevel; reasons: string[] };
  actor: { agentId: string; sessionId: string; senderId: string; channel: string };
  environment: { workspace: string; hostname: string; envClass: string };
  expiry: number;
  nonce: string;
  reason: string;
  callback: { url: string; auth: { type: 'hmac-sha256'; keyId: string } };
  idempotencyKey: string;
}

export interface BridgeHandoffResponse {
  approvalId: string;
  status: 'accepted' | 'denied';
  route: 'beav3r' | 'local';
  queued: boolean;
  reason?: string;
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

export type ResolveDecision = 'allow_once' | 'deny' | 'expired' | 'timeout';
