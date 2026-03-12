import { describe, it, expect, vi } from 'vitest';
import { computeActionHash } from '../src/utils/canonical';
import { mapCallbackToResolve } from '../src/plugin';
import { normalizeApprovalPayload } from '../src/normalize';
import { OpenClawApprovalsPlugin } from '../src/plugin';
import { InMemoryApprovalEventSource } from '../src/adapters/event-source';

const cfg = {
  enabled: true,
  mode: 'optional' as const,
  targets: ['gateway'] as const,
  riskThresholds: { localMax: 30, beav3rMin: 70 },
  envOverrides: { prod: 'beav3r' as const },
  fallbackPolicy: { medium: 'local' as const, high: 'deny' as const },
  beav3r: { baseUrl: 'http://localhost:3000', timeoutMs: 3000 },
  bridge: { callbackSecret: 'secret', callbackKeyId: 'k1', bridgeUrl: 'http://localhost:4400' },
};

describe('payload normalization', () => {
  it('produces canonical v1 handoff shape', () => {
    const p = normalizeApprovalPayload(
      {
        approvalId: 'a1',
        action: { tool: 'exec', command: 'ls -la', node: null, systemRunPlan: { x: 1 } },
        risk: { score: 86, level: 'high' },
        actor: { agentId: 'main', sessionId: 's1', senderId: 'u1', channel: 'telegram' },
        environment: { workspace: '/tmp', hostname: 'mac', envClass: 'prod' },
        expiry: 1773076400,
        nonce: 'abc',
        reason: 'need approval',
        idempotencyKey: 'oc_appr_123:1',
      },
      cfg,
      'http://plugin.local/callback/openclaw-resolve'
    );

    expect(p.version).toBe('v1');
    expect(p.callback.auth.type).toBe('hmac-sha256');
    expect(p.actionHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('canonical hash determinism', () => {
  it('hashes deterministically independent of key order', () => {
    const a = computeActionHash({
      action: { tool: 'exec', command: 'echo ok', node: null, host: 'h', cwd: '/w', systemRunPlan: { b: 2, a: 1 } },
      actor: { agentId: 'main', sessionId: 's', senderId: 'u', channel: 'telegram' },
      environment: { workspace: '/w', hostname: 'h1', envClass: 'prod' },
      expiry: 1773076400,
      nonce: 'n',
    });
    const b = computeActionHash({
      action: { tool: 'exec', command: 'echo ok', node: null, host: 'h', cwd: '/w', systemRunPlan: { a: 1, b: 2 } },
      actor: { channel: 'telegram', senderId: 'u', sessionId: 's', agentId: 'main' },
      environment: { envClass: 'prod', hostname: 'h1', workspace: '/w' },
      expiry: 1773076400,
      nonce: 'n',
    });
    expect(a).toBe(b);
  });
});

describe('callback mapping', () => {
  it('maps allow-once to allow_once', () => {
    expect(
      mapCallbackToResolve({
        approvalId: 'a1',
        status: 'approved',
        decision: 'allow-once',
        decidedAt: 1,
        approver: { deviceId: 'd', publicKey: 'k', assurance: 'software' },
        signature: { scheme: 'ed25519', value: 'sig' },
        expiresAt: 2,
      })
    ).toBe('allow_once');
  });
});

describe('handoff retry', () => {
  it('retries bridge handoff after transient failure', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('bridge down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'accepted', route: 'beav3r', queued: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const source = new InMemoryApprovalEventSource();
    const plugin = new OpenClawApprovalsPlugin(cfg, { resolveApproval: async () => undefined });
    plugin.bindApprovalRequested(source, 'http://plugin.local/callback/openclaw-resolve');

    const emitPromise = source.emit({
      approvalId: 'retry-1',
      action: { tool: 'exec', command: 'ls -la', node: null, systemRunPlan: { x: 1 } },
      risk: { score: 86, level: 'high' },
      actor: { agentId: 'main', sessionId: 's1', senderId: 'u1', channel: 'telegram' },
      environment: { workspace: '/tmp', hostname: 'mac', envClass: 'prod' },
      expiry: 1773076400,
      nonce: 'abc',
      reason: 'need approval',
      idempotencyKey: 'retry-1:1',
    });
    await emitPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});
