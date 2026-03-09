import { OpenClawApprovalInput } from '../normalize';

export interface ApprovalRequestedEventSource {
  onApprovalRequested(handler: (evt: OpenClawApprovalInput) => Promise<void> | void): void;
}

// TODO(ndeto): bind to real OpenClaw event bus (e.g. exec.approval.requested) in runtime integration.
export class InMemoryApprovalEventSource implements ApprovalRequestedEventSource {
  private handlers: Array<(evt: OpenClawApprovalInput) => Promise<void> | void> = [];

  onApprovalRequested(handler: (evt: OpenClawApprovalInput) => Promise<void> | void): void {
    this.handlers.push(handler);
  }

  async emit(evt: OpenClawApprovalInput): Promise<void> {
    for (const h of this.handlers) await h(evt);
  }
}
