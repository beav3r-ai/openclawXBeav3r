import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandoffPayloadV1 } from '../src/types/contracts';
import { HttpBeav3rClient } from '../src/adapters/beav3r-client';

const payload: HandoffPayloadV1 = {
  version: 'v1',
  approvalId: 'oc_appr_123',
  actionHash: 'a'.repeat(64),
  action: { tool: 'exec', command: 'echo hi', cwd: '/w', host: 'gateway', node: null, systemRunPlan: {} },
  risk: { score: 86, level: 'high', reasons: ['prod_env'] },
  actor: { agentId: 'main', sessionId: 's', senderId: 'u', channel: 'telegram' },
  environment: { workspace: '/w', hostname: 'h', envClass: 'prod' },
  expiry: Math.floor(Date.now() / 1000) + 3600,
  nonce: 'n',
  reason: 'r',
  callback: { url: 'http://127.0.0.1:6553/callback/openclaw-resolve', auth: { type: 'hmac-sha256', keyId: 'k1' } },
  idempotencyKey: 'oc_appr_123:1',
};

describe('HttpBeav3rClient (beaver endpoint contract)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps handoff payload to /actions/relay and returns actionId as requestId', async () => {
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const headers = init?.headers as Record<string, string> | undefined;
      expect(body.reason).toBe('r');
      expect(body.action.actionId).toBe('oc_appr_123');
      expect(body.action.agentId).toBe('main');
      expect(body.action.actionType).toBe('openclaw.exec_approval_requested');
      expect(body.action.payload.command).toBe('echo hi');
      expect(headers?.authorization).toBe('Bearer test-key');
      expect(body.source).toMatchObject({
        type: 'openclaw',
        originLabel: 'OpenClaw h',
        metadata: {
          integration: 'openclaw',
          agentId: 'main',
          sessionId: 's',
          senderId: 'u',
          channel: 'telegram',
          hostname: 'h',
          envClass: 'prod',
          workspace: '/w',
          host: 'gateway',
          node: null,
          tool: 'exec',
        },
      });
      expect(body.action.attributes).toMatchObject({
        tool: 'exec',
        risk_score: 86,
        risk_level: 'high',
        environment: 'prod',
      });
      return new Response(JSON.stringify({ status: 'pending', actionId: 'oc_appr_123', actionHash: 'h', reason: 'approval required' }), { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new HttpBeav3rClient('http://localhost:3000', 1000, 'test-key');
    const out = await client.createDecisionRequest(payload);
    expect(out).toEqual({ requestId: 'oc_appr_123' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/actions/relay');
  });

  it('falls back to approvalId when nonce is missing', async () => {
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.action.nonce).toBe('oc_appr_123');
      return new Response(JSON.stringify({ status: 'pending', actionId: 'oc_appr_123', actionHash: 'h', reason: 'approval required' }), { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new HttpBeav3rClient('http://localhost:3000', 1000);
    const out = await client.createDecisionRequest({ ...payload, nonce: undefined as unknown as string });
    expect(out).toEqual({ requestId: 'oc_appr_123' });
  });

  it('allows overriding the origin label with env', async () => {
    process.env.BEAV3R_ORIGIN_LABEL = 'Ndeto MacBook';
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.source.originLabel).toBe('Ndeto MacBook');
      return new Response(JSON.stringify({ status: 'pending', actionId: 'oc_appr_123', actionHash: 'h', reason: 'approval required' }), { status: 200 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new HttpBeav3rClient('http://localhost:3000', 1000);
    await expect(client.createDecisionRequest(payload)).resolves.toEqual({ requestId: 'oc_appr_123' });
    delete process.env.BEAV3R_ORIGIN_LABEL;
  });

  it('includes beav3r error body when action request fails', async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Action oc_appr_123 already exists' }), { status: 400 }));
    vi.stubGlobal('fetch', mockFetch);

    const client = new HttpBeav3rClient('http://localhost:3000', 1000);
    await expect(client.createDecisionRequest(payload)).rejects.toThrow(
      'beaver relay request failed: 400 Action oc_appr_123 already exists'
    );
  });

  it('maps /actions/:id/status to approved/denied/expired decision states', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ actionId: 'x', status: 'executed' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ actionId: 'x', status: 'denied', reason: 'policy' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ actionId: 'x', status: 'expired' }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const client = new HttpBeav3rClient('http://localhost:3000', 1000);
    await expect(client.fetchDecision('x')).resolves.toEqual({ status: 'approved', reason: undefined });
    await expect(client.fetchDecision('x')).resolves.toEqual({ status: 'denied', reason: 'policy' });
    await expect(client.fetchDecision('x')).resolves.toEqual({ status: 'expired', reason: undefined });
  });

  it('calls approvals submit/reject endpoints with expected payloads', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'executed', actionId: 'a1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'rejected', actionId: 'a1' }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const client = new HttpBeav3rClient('http://localhost:3000', 1000);

    await expect(client.submitApproval({ actionHash: 'h', deviceId: 'd1', signature: 'sig', expiry: 1 })).resolves.toEqual({ status: 'executed', actionId: 'a1' });
    await expect(client.rejectApproval({ actionHash: 'h', deviceId: 'd1' })).resolves.toEqual({ status: 'rejected', actionId: 'a1' });

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/approvals/submit');
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3000/approvals/reject');
  });
});
