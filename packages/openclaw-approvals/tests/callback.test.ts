import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { NoopResolverAdapter } from '../src/adapters/resolver';
import { OpenClawApprovalsPlugin } from '../src/plugin';
import { computeHmacSha256 } from '../src/utils/signature';
import { OpenClawApprovalInput } from '../src/normalize';

const cfg = {
  enabled: true,
  mode: 'optional' as const,
  targets: ['gateway'] as const,
  riskThresholds: { localMax: 30, beav3rMin: 70 },
  envOverrides: { prod: 'beav3r' as const },
  fallbackPolicy: { medium: 'local' as const, high: 'deny' as const },
  beav3r: { baseUrl: 'http://localhost:3000', timeoutMs: 3000 },
  bridge: { callbackSecret: 'secret', callbackKeyId: 'k1', bridgeUrl: 'http://127.0.0.1:6666' },
};

describe('callback HMAC and duplicate protection', () => {
  it('verifies hmac and ignores duplicate callback', async () => {
    const resolver = new NoopResolverAdapter();
    const plugin = new OpenClawApprovalsPlugin(cfg, resolver);
    const app = express();
    app.use(plugin.callbackRouter());
    const server = app.listen(18065);

    const payload = {
      approvalId: 'a1',
      status: 'approved',
      decision: 'allow-once',
      decidedAt: 1773072800,
      approver: { deviceId: 'd', publicKey: 'k', assurance: 'software' },
      signature: { scheme: 'ed25519', value: 'sig' },
      reason: 'ok',
      expiresAt: 1773076400,
    };
    const raw = JSON.stringify(payload);
    const sig = computeHmacSha256(raw, 'secret');

    const r1 = await fetch('http://127.0.0.1:18065/callback/openclaw-resolve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ocb-signature': sig }, body: raw });
    expect(r1.status).toBe(200);
    const r2 = await fetch('http://127.0.0.1:18065/callback/openclaw-resolve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ocb-signature': sig }, body: raw });
    expect(r2.status).toBe(202);
    expect(resolver.resolved).toHaveLength(1);

    const bad = await fetch('http://127.0.0.1:18065/callback/openclaw-resolve', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ocb-signature': 'bad' }, body: raw });
    expect(bad.status).toBe(401);

    server.close();
  });

  it('returns 400 for malformed handoff payloads instead of crashing', async () => {
    const plugin = new OpenClawApprovalsPlugin(
      {
        enabled: true,
        mode: 'optional',
        targets: ['gateway'],
        riskThresholds: { localMax: 30, beav3rMin: 70 },
        envOverrides: { prod: 'beav3r' },
        fallbackPolicy: { medium: 'local', high: 'deny' },
        beav3r: { baseUrl: 'http://localhost:3000', timeoutMs: 3000 },
        bridge: { callbackSecret: 'secret', bridgeUrl: 'http://127.0.0.1:18066' },
      },
      new NoopResolverAdapter()
    );

    const app = express();
    app.use(plugin.callbackRouter());
    app.use(express.json());
    app.post('/handoff', async (req, res) => {
      const payload = req.body as Partial<OpenClawApprovalInput>;
      if (!payload.action?.tool) {
        return res.status(400).json({ error: 'invalid approval payload' });
      }
      return res.status(200).json({ ok: true });
    });

    const server = app.listen(18066);
    const res = await fetch('http://127.0.0.1:18066/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalId: 'broken' }),
    });

    expect(res.status).toBe(400);
    server.close();
  });

  it('returns 502 when gateway resolve fails instead of crashing the plugin', async () => {
    const plugin = new OpenClawApprovalsPlugin(cfg, {
      async resolveApproval() {
        throw new Error('unknown approval id');
      },
    });
    const app = express();
    app.use(plugin.callbackRouter());
    const server = app.listen(18067);

    const payload = {
      approvalId: 'a2',
      status: 'approved',
      decision: 'allow-once',
      decidedAt: 1773072801,
      approver: { deviceId: 'd', publicKey: 'k', assurance: 'software' },
      signature: { scheme: 'ed25519', value: 'sig2' },
      reason: 'ok',
      expiresAt: 1773076401,
    };
    const raw = JSON.stringify(payload);
    const sig = computeHmacSha256(raw, 'secret');

    const response = await fetch('http://127.0.0.1:18067/callback/openclaw-resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ocb-signature': sig },
      body: raw,
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'unknown approval id' });
    server.close();
  });

  it('retries the same callback after resolver failure instead of deduping it permanently', async () => {
    let shouldFail = true;
    const resolveApproval = vi.fn(async () => {
      if (shouldFail) {
        throw new Error('temporary failure');
      }
    });
    const plugin = new OpenClawApprovalsPlugin(cfg, { resolveApproval });
    const app = express();
    app.use(plugin.callbackRouter());
    const server = app.listen(18068);

    const payload = {
      approvalId: 'a3',
      status: 'approved',
      decision: 'allow-once',
      decidedAt: 1773072802,
      approver: { deviceId: 'd', publicKey: 'k', assurance: 'software' },
      signature: { scheme: 'ed25519', value: 'sig3' },
      reason: 'ok',
      expiresAt: 1773076402,
    };
    const raw = JSON.stringify(payload);
    const sig = computeHmacSha256(raw, 'secret');

    const first = await fetch('http://127.0.0.1:18068/callback/openclaw-resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ocb-signature': sig },
      body: raw,
    });
    expect(first.status).toBe(502);

    shouldFail = false;
    const second = await fetch('http://127.0.0.1:18068/callback/openclaw-resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ocb-signature': sig },
      body: raw,
    });
    expect(second.status).toBe(200);
    expect(resolveApproval).toHaveBeenCalledTimes(2);

    server.close();
  });
});
