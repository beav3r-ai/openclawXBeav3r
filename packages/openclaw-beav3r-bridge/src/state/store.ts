import fs from 'node:fs';
import path from 'node:path';
import { ApprovalState, CallbackDecision, HandoffPayloadV1, Route, RouteReason } from '../types/contracts';

export interface ApprovalRecord {
  approvalId: string;
  route: Route;
  routeReason?: RouteReason;
  state: ApprovalState;
  payload: HandoffPayloadV1;
  requestId?: string;
  callbackSent?: boolean;
  terminal?: CallbackDecision;
  updatedAt: number;
}

export interface ApprovalStore {
  getByIdempotency(key: string): ApprovalRecord | undefined;
  getByRequestId(requestId: string): ApprovalRecord | undefined;
  putIdempotency(key: string, rec: ApprovalRecord): void;
  get(approvalId: string): ApprovalRecord | undefined;
  set(rec: ApprovalRecord): void;
  listPending(): ApprovalRecord[];
  markTerminal(approvalId: string, decision: CallbackDecision, callbackSent?: boolean): ApprovalRecord | undefined;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private byId = new Map<string, ApprovalRecord>();
  private byIdempotency = new Map<string, string>();

  getByIdempotency(key: string): ApprovalRecord | undefined {
    const approvalId = this.byIdempotency.get(key);
    return approvalId ? this.byId.get(approvalId) : undefined;
  }

  getByRequestId(requestId: string): ApprovalRecord | undefined {
    return Array.from(this.byId.values()).find((record) => record.requestId === requestId);
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

  listPending(): ApprovalRecord[] {
    return Array.from(this.byId.values()).filter((record) => record.state === 'pending' || record.callbackSent === false);
  }

  markTerminal(approvalId: string, decision: CallbackDecision, callbackSent = true): ApprovalRecord | undefined {
    const r = this.byId.get(approvalId);
    if (!r) return undefined;
    r.terminal = decision;
    r.callbackSent = callbackSent;
    if (callbackSent) {
      r.state = decision.status;
    }
    r.updatedAt = Date.now();
    this.byId.set(approvalId, r);
    return r;
  }
}

type FileApprovalStoreState = {
  version: 1;
  records: ApprovalRecord[];
  idempotency: Record<string, string>;
};

export class FileApprovalStore implements ApprovalStore {
  private readonly byId = new Map<string, ApprovalRecord>();
  private readonly byIdempotency = new Map<string, string>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  getByIdempotency(key: string): ApprovalRecord | undefined {
    const approvalId = this.byIdempotency.get(key);
    return approvalId ? this.byId.get(approvalId) : undefined;
  }

  getByRequestId(requestId: string): ApprovalRecord | undefined {
    return Array.from(this.byId.values()).find((record) => record.requestId === requestId);
  }

  putIdempotency(key: string, rec: ApprovalRecord): void {
    this.byIdempotency.set(key, rec.approvalId);
    this.byId.set(rec.approvalId, rec);
    this.persist();
  }

  get(approvalId: string): ApprovalRecord | undefined {
    return this.byId.get(approvalId);
  }

  set(rec: ApprovalRecord): void {
    this.byId.set(rec.approvalId, rec);
    this.persist();
  }

  listPending(): ApprovalRecord[] {
    return Array.from(this.byId.values()).filter((record) => record.state === 'pending' || record.callbackSent === false);
  }

  markTerminal(approvalId: string, decision: CallbackDecision, callbackSent = true): ApprovalRecord | undefined {
    const record = this.byId.get(approvalId);
    if (!record) return undefined;
    record.terminal = decision;
    record.callbackSent = callbackSent;
    if (callbackSent) {
      record.state = decision.status;
    }
    record.updatedAt = Date.now();
    this.byId.set(approvalId, record);
    this.persist();
    return record;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as FileApprovalStoreState;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported approval store version: ${String((parsed as { version?: unknown }).version)}`);
    }

    this.byId.clear();
    this.byIdempotency.clear();
    for (const record of parsed.records) {
      this.byId.set(record.approvalId, record);
    }
    for (const [key, approvalId] of Object.entries(parsed.idempotency)) {
      this.byIdempotency.set(key, approvalId);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: FileApprovalStoreState = {
      version: 1,
      records: Array.from(this.byId.values()),
      idempotency: Object.fromEntries(this.byIdempotency.entries()),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}
