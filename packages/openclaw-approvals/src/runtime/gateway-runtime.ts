import { OpenClawApprovalsApiLike } from '../adapters/openclaw-resolver';
import { OpenClawEventBusLike } from '../adapters/openclaw-event-source';
import { OpenClawRuntimeLike } from './openclaw-runtime';
import { ResolveDecision } from '../types/contracts';
import { SimpleGatewayClient } from './simple-gateway-client';

const HARDCODED_OPENCLAW_GATEWAY_URL = 'ws://127.0.0.1:18789';

type GatewayEventFrameLike = {
  event: string;
  payload?: unknown;
};

type GatewayClientLike = {
  start(): void;
  stop(): void;
  request<T = Record<string, unknown>>(method: string, params?: unknown, opts?: { expectFinal?: boolean }): Promise<T>;
};

type GatewayClientCtor = new (opts: ConstructorParameters<typeof SimpleGatewayClient>[0]) => GatewayClientLike;

type GatewayRuntimeOptions = {
  url?: string;
  token?: string;
  password?: string;
  reconnectIntervalMs?: number;
  onEventLog?: (event: string, data: Record<string, unknown>) => void;
  clientCtor?: GatewayClientCtor;
};

class GatewayEventBus implements OpenClawEventBusLike {
  private handlers = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();

  on(event: 'exec.approval.requested', handler: (payload: unknown) => void | Promise<void>): void {
    const current = this.handlers.get(event) ?? [];
    current.push(handler);
    this.handlers.set(event, current);
  }

  async emit(frame: GatewayEventFrameLike): Promise<void> {
    const handlers = this.handlers.get(frame.event);
    if (!handlers?.length) return;
    for (const handler of handlers) {
      await handler(frame.payload);
    }
  }
}

function resolveReconnectIntervalMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  const fromEnv = Number(process.env.OPENCLAW_GATEWAY_RECONNECT_INTERVAL_MS ?? '3000');
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }

  return 3000;
}

class GatewayApprovalsApi implements OpenClawApprovalsApiLike {
  constructor(
    private readonly gateway: GatewayClientLike,
    private readonly log?: (event: string, data: Record<string, unknown>) => void
  ) {}

  async resolveApproval(input: {
    approvalId: string;
    decision: ResolveDecision;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const decision = input.decision === 'allow_once' ? 'allow-once' : 'deny';
    this.log?.('gateway.resolve_approval', { approvalId: input.approvalId, decision });
    await this.gateway.request('exec.approval.resolve', {
      id: input.approvalId,
      decision,
    });
  }
}

export function createGatewayRuntime(options: GatewayRuntimeOptions): {
  runtime: OpenClawRuntimeLike;
  start(): void;
  stop(): void;
} {
  const bus = new GatewayEventBus();
  const GatewayClientImpl = options.clientCtor ?? SimpleGatewayClient;
  const gateway = new GatewayClientImpl({
    url: options.url ?? process.env.OPENCLAW_GATEWAY_URL ?? HARDCODED_OPENCLAW_GATEWAY_URL,
    token: options.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
    password: options.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD,
    reconnectIntervalMs: resolveReconnectIntervalMs(options.reconnectIntervalMs),
    clientName: 'gateway-client',
    clientDisplayName: 'Beav3r Approvals',
    mode: 'backend',
    scopes: ['operator.approvals'],
    onEvent: (evt) => {
      if (evt.event === 'exec.approval.requested') {
        options.onEventLog?.('gateway.event_received', { event: evt.event });
        void bus.emit(evt);
      }
    },
    onHelloOk: () =>
      options.onEventLog?.('gateway.connected', {
        url: options.url ?? process.env.OPENCLAW_GATEWAY_URL ?? HARDCODED_OPENCLAW_GATEWAY_URL,
      }),
    onConnectError: (err) => options.onEventLog?.('gateway.connect_error', { message: err.message }),
    onClose: (code, reason) => options.onEventLog?.('gateway.closed', { code, reason }),
  });

  return {
    runtime: {
      events: bus,
      approvals: new GatewayApprovalsApi(gateway, options.onEventLog),
    },
    start() {
      gateway.start();
    },
    stop() {
      gateway.stop();
    },
  };
}
