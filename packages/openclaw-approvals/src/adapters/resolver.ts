import { ResolveDecision } from '../types/contracts';

export interface OpenClawResolverAdapter {
  resolveApproval(input: {
    approvalId: string;
    decision: ResolveDecision;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export class NoopResolverAdapter implements OpenClawResolverAdapter {
  public resolved: Array<{ approvalId: string; decision: ResolveDecision; reason?: string }> = [];

  async resolveApproval(input: { approvalId: string; decision: ResolveDecision; reason?: string }): Promise<void> {
    this.resolved.push(input);
  }
}
