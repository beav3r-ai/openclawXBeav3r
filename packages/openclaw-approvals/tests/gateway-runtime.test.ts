import { describe, expect, it, vi } from 'vitest';

import { createGatewayRuntime } from '../src/runtime/gateway-runtime';

describe('gateway runtime', () => {
  it('forwards real gateway events into the runtime event bus and resolves approvals back through gateway', async () => {
    let capturedEventHandler: ((evt: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (_method?: string, _params?: unknown) => undefined);
    const start = vi.fn();
    const stop = vi.fn();

    class FakeGatewayClient {
      constructor(opts: { onEvent?: (evt: { event: string; payload?: unknown }) => void }) {
        capturedEventHandler = opts.onEvent;
      }

      start() {
        start();
      }

      stop() {
        stop();
      }

      async request(method: string, params?: unknown) {
        return request(method, params);
      }
    }

    const runtimeHandle = createGatewayRuntime({
      url: 'ws://127.0.0.1:18789',
      clientCtor: FakeGatewayClient as unknown as new (opts: {
        url?: string;
        token?: string;
        password?: string;
        clientName?: string;
        clientDisplayName?: string;
        mode?: string;
        scopes?: string[];
        onEvent?: (evt: { event: string; payload?: unknown }) => void;
        onHelloOk?: () => void;
        onConnectError?: (err: Error) => void;
        onClose?: (code: number, reason: string) => void;
      }) => {
        start(): void;
        stop(): void;
        request<T = Record<string, unknown>>(method: string, params?: unknown, opts?: { expectFinal?: boolean }): Promise<T>;
      },
    });

    const seen: unknown[] = [];
    runtimeHandle.runtime.events.on('exec.approval.requested', async (payload) => {
      seen.push(payload);
    });

    runtimeHandle.start();
    capturedEventHandler?.({
      event: 'exec.approval.requested',
      payload: { id: 'ap1', request: { command: 'echo hi' } },
    });

    await runtimeHandle.runtime.approvals.resolveApproval({
      approvalId: 'ap1',
      decision: 'allow_once',
      reason: 'approved',
    });

    expect(start).toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'ap1',
      decision: 'allow-once',
    });

    runtimeHandle.stop();
    expect(stop).toHaveBeenCalled();
  });
});
