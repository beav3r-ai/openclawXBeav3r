import { ApprovalState, CallbackDecision, HandoffPayloadV1, Route } from '../types/contracts';

export interface ApprovalRecord {
  approvalId: string;
  route: Route;
  state: ApprovalState;
  payload: HandoffPayloadV1;
  callbackSent?: boolean;
  terminal?: CallbackDecision;
  updatedAt: number;
}

export interface ApprovalStore {
  getByIdempotency(key: string): ApprovalRecord | undefined;
  putIdempotency(key: string, rec: ApprovalRecord): void;
  get(approvalId: string): ApprovalRecord | undefined;
  set(rec: ApprovalRecord): void;
  markTerminal(approvalId: string, decision: CallbackDecision): ApprovalRecord | undefined;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private byId = new Map<string, ApprovalRecord>();
  private byIdempotency = new Map<string, string>();

  getByIdempotency(key: string): ApprovalRecord | undefined {
    const approvalId = this.byIdempotency.get(key);
    return approvalId ? this.byId.get(approvalId) : undefined;
  }

  putIdempotency(key: string, rec: ApprovalRecord): void {
    this.byIdempotency.set(key, rec.approvalId);
    this.byId.set(rec.approvalId, rec);
  }

  get(approvalId: string): ApprovalRecord | undefined {
    return this.byId.get(approvalId);
  }

  set(rec: ApprovalRecord): void {
    this.byId.set(rec.approvalId, rec);
  }

  markTerminal(approvalId: string, decision: CallbackDecision): ApprovalRecord | undefined {
    const r = this.byId.get(approvalId);
    if (!r) return undefined;
    r.state = decision.status;
    r.terminal = decision;
    r.updatedAt = Date.now();
    this.byId.set(approvalId, r);
    return r;
  }
}
