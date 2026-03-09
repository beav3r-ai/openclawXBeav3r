import { ResolveDecision } from '../types/contracts';
import { OpenClawResolverAdapter } from './resolver';

export interface OpenClawApprovalsApiLike {
  resolveApproval(input: {
    approvalId: string;
    decision: 'allow_once' | 'deny' | 'expired' | 'timeout';
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export function mapResolveInput(input: { approvalId: string; decision: ResolveDecision; reason?: string; metadata?: Record<string, unknown> }) {
  return {
    approvalId: input.approvalId,
    decision: input.decision,
    reason: input.reason,
    metadata: input.metadata,
  } as const;
}

export class OpenClawRuntimeResolverAdapter implements OpenClawResolverAdapter {
  constructor(private readonly approvalsApi: OpenClawApprovalsApiLike) {}

  async resolveApproval(input: {
    approvalId: string;
    decision: ResolveDecision;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.approvalsApi.resolveApproval(mapResolveInput(input));
  }
}
