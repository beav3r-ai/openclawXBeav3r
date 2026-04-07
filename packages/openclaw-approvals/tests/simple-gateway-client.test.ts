import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SimpleGatewayClient } from '../src/runtime/simple-gateway-client';

type ListenerMap = {
  open: Array<() => void>;
  message: Array<(event: { data: string }) => void>;
  error: Array<(event: { error?: Error }) => void>;
  close: Array<(event: { code: number; reason: string }) => void>;
};

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners: ListenerMap = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: keyof ListenerMap, listener: ListenerMap[keyof ListenerMap][number]) {
    this.listeners[type].push(listener as never);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.close) {
      listener({ code, reason });
    }
  }

  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    for (const listener of this.listeners.open) {
      listener();
    }
  }

  emitError(error?: Error) {
    for (const listener of this.listeners.error) {
      listener({ error });
    }
  }

  emitClose(code: number, reason: string) {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.close) {
      listener({ code, reason });
    }
  }
}

describe('SimpleGatewayClient reconnect behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps retrying at a steady interval after the gateway closes', () => {
    const client = new SimpleGatewayClient({
      url: 'ws://gateway.local',
      reconnectIntervalMs: 1000,
    });

    client.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].emitClose(1012, 'service restart');
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].emitClose(1012, 'service restart');
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('retries after connect errors even when the gateway never emits a close first', () => {
    const onConnectError = vi.fn();
    const client = new SimpleGatewayClient({
      url: 'ws://gateway.local',
      reconnectIntervalMs: 1000,
      onConnectError,
    });

    client.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].emitError(new Error('Received network error or non-101 status code.'));
    expect(onConnectError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('ignores stale close events after a replacement reconnect has already started', () => {
    const client = new SimpleGatewayClient({
      url: 'ws://gateway.local',
      reconnectIntervalMs: 1000,
    });

    client.start();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].emitError(new Error('Received network error or non-101 status code.'));
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[0].emitClose(1006, 'late close');
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
