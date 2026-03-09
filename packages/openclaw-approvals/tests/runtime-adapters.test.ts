import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mapOpenClawApprovalRequestedEvent, OpenClawRuntimeApprovalEventSource } from '../src/adapters/openclaw-event-source';
import { mapResolveInput, OpenClawRuntimeResolverAdapter } from '../src/adapters/openclaw-resolver';
import { adaptApprovalInput } from '../src/adapters/schema-adapter';
import { bindOpenClawRuntime } from '../src/runtime/openclaw-runtime';
import { computeHmacSha256 } from '../src/utils/signature';

const cfg = {
  enabled: true,
  mode: 'optional' as const,
  targets: ['gateway'] as const,
  riskThresholds: { localMax: 30, beav3rMin: 70 },
  envOverrides: { prod: 'beav3r' as const },
  fallbackPolicy: { medium: 'local' as const, high: 'deny' as const },
  beav3r: { baseUrl: 'http://localhost:3000', timeoutMs: 3000 },
  bridge: { callbackSecret: 'secret', callbackKeyId: 'k1', bridgeUrl: 'http://127.0.0.1:19070' },
};

describe('real-event payload mapping', () => {
  it('maps runtime event payload into canonical OpenClawApprovalInput', () => {
    const mapped = mapOpenClawApprovalRequestedEvent({
      approvalId: 'ap1',
      action: { tool: 'exec', command: 'ls -la', node: null, systemRunPlan: { p: 1 } },
      risk: { score: 90, level: 'high', reasons: ['prod'] },
      actor: { agentId: 'main', sessionId: 's1', senderId: 'u1', channel: 'discord' },
      environment: { workspace: '/w', hostname: 'h', envClass: 'prod' },
      expiry: 1773076400,
      nonce: 'n1',
      reason: 'need approval',
      idempotencyKey: 'ap1:1',
    });

    expect(mapped.approvalId).toBe('ap1');
    expect(mapped.action.tool).toBe('exec');
    expect(mapped.risk.level).toBe('high');
  });

  it('maps real OpenClaw gateway-style payload into canonical OpenClawApprovalInput', () => {
    const mapped = adaptApprovalInput({
      id: 'ap-gw-1',
      request: {
        command: 'kubectl apply -f prod.yaml',
        cwd: '/workspace',
        host: 'gateway',
        nodeId: null,
        agentId: 'main',
        sessionKey: 'agent:main:test',
        turnSourceChannel: 'telegram',
        turnSourceAccountId: 'telegram:12345',
        systemRunPlan: {
          argv: ['kubectl', 'apply', '-f', 'prod.yaml'],
          cwd: '/workspace',
          rawCommand: 'kubectl apply -f prod.yaml',
          agentId: 'main',
          sessionKey: 'agent:main:test',
        },
      },
      expiresAtMs: 1773076400000,
    });

    expect(mapped.approvalId).toBe('ap-gw-1');
    expect(mapped.action.tool).toBe('exec');
    expect(mapped.action.command).toBe('kubectl apply -f prod.yaml');
    expect(mapped.actor.agentId).toBe('main');
    expect(mapped.actor.channel).toBe('telegram');
    expect(mapped.risk.level).toBe('high');
    expect(mapped.idempotencyKey).toBe('ap-gw-1:1');
  });

  it('rejects malformed runtime payload', () => {
    expect(() => mapOpenClawApprovalRequestedEvent({ approvalId: 'broken' })).toThrow(/invalid/);
  });
});

describe('real-resolve adapter mapping', () => {
  it('maps resolve payload and calls OpenClaw approvals API', async () => {
    const resolveApproval = vi.fn(async () => undefined);
    const adapter = new OpenClawRuntimeResolverAdapter({ resolveApproval });

    const mapped = mapResolveInput({ approvalId: 'ap2', decision: 'allow_once', reason: 'ok' });
    expect(mapped).toMatchObject({ approvalId: 'ap2', decision: 'allow_once' });

    await adapter.resolveApproval({ approvalId: 'ap2', decision: 'allow_once', reason: 'ok', metadata: { from: 'test' } });
    expect(resolveApproval).toHaveBeenCalledWith({
      approvalId: 'ap2',
      decision: 'allow_once',
      reason: 'ok',
      metadata: { from: 'test' },
    });
  });
});

describe('event->handoff->callback->resolve integration', () => {
  it('wires runtime event source through plugin and resolves via runtime approvals API', async () => {
    const handlers: Array<(payload: unknown) => void | Promise<void>> = [];
    const events = { on: (_event: 'exec.approval.requested', handler: (payload: unknown) => void | Promise<void>) => handlers.push(handler) };
    const resolved: any[] = [];
    const approvals = {
      resolveApproval: async (input: any): Promise<void> => {
        resolved.push(input);
      },
    };

    const bridge = express();
    bridge.use(express.json());
    bridge.post('/handoff', (req, res) => {
      res.json({ approvalId: req.body.approvalId, status: 'accepted', route: 'beav3r', queued: true });
    });
    const bridgeServer = bridge.listen(19070);

    const plugin = bindOpenClawRuntime({ runtime: { events, approvals }, config: cfg, callbackUrl: 'http://127.0.0.1:19071/callback/openclaw-resolve' });
    const app = express();
    app.use(plugin.callbackRouter());
    const pluginServer = app.listen(19071);

    await handlers[0]({
      approvalId: 'ap3',
      action: { tool: 'exec', command: 'echo hi', node: null, systemRunPlan: {} },
      risk: { score: 81, level: 'high', reasons: ['prod'] },
      actor: { agentId: 'main', sessionId: 's1', senderId: 'u1', channel: 'webchat' },
      environment: { workspace: '/w', hostname: 'h', envClass: 'prod' },
      expiry: 1773076400,
      nonce: 'n1',
      reason: 'approval',
      idempotencyKey: 'ap3:1',
    });

    const callback = {
      approvalId: 'ap3',
      status: 'approved',
      decision: 'allow-once',
      decidedAt: 1773072800,
      approver: { deviceId: 'd', publicKey: 'k', assurance: 'software' },
      signature: { scheme: 'ed25519', value: 'sig' },
      reason: 'approved',
      expiresAt: 1773076400,
    };
    const raw = JSON.stringify(callback);
    const sig = computeHmacSha256(raw, 'secret');
    const callbackRes = await fetch('http://127.0.0.1:19071/callback/openclaw-resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ocb-signature': sig },
      body: raw,
    });

    expect(callbackRes.status).toBe(200);
    expect(resolved[0]).toMatchObject({ approvalId: 'ap3', decision: 'allow_once' });

    bridgeServer.close();
    pluginServer.close();
  });

  it('uses existing event source adapter surface', () => {
    const bus = { on: vi.fn() };
    const src = new OpenClawRuntimeApprovalEventSource(bus);
    src.onApprovalRequested(() => undefined);
    expect(bus.on).toHaveBeenCalledWith('exec.approval.requested', expect.any(Function));
  });
});
