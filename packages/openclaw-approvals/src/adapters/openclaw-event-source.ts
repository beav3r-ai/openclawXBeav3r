import { OpenClawApprovalInput } from '../normalize';
import { ApprovalRequestedEventSource } from './event-source';
import { adaptApprovalInput } from './schema-adapter';

export interface OpenClawEventBusLike {
  on(event: 'exec.approval.requested', handler: (payload: unknown) => void | Promise<void>): void;
}

export function mapOpenClawApprovalRequestedEvent(payload: unknown): OpenClawApprovalInput {
  return adaptApprovalInput(payload);
}

export class OpenClawRuntimeApprovalEventSource implements ApprovalRequestedEventSource {
  constructor(private readonly bus: OpenClawEventBusLike) {}

  onApprovalRequested(handler: (evt: OpenClawApprovalInput) => Promise<void> | void): void {
    this.bus.on('exec.approval.requested', async (payload) => {
      const mapped = mapOpenClawApprovalRequestedEvent(payload);
      await handler(mapped);
    });
  }
}
