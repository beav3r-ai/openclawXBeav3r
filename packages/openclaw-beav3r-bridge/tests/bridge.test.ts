import { describe, expect, it } from 'vitest';
import express from 'express';
import { OpenClawBeav3rBridge } from '../src/bridge';
import { Beav3rClient } from '../src/adapters/beav3r-client';
import { chooseRoute } from '../src/policy/router';
import { HandoffPayloadV1 } from '../src/types/contracts';
import { OpenClawApprovalsPlugin } from '../../openclaw-approvals/src/plugin';
import { NoopResolverAdapter } from '../../openclaw-approvals/src/adapters/resolver';

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

const cfg = {
  riskThresholds: { localMax: 30, beav3rMin: 70 },
  envOverrides: {},
  fallbackPolicy: { medium: 'local' as const, high: 'deny' as const },
  beav3r: { baseUrl: 'http://localhost:3000', timeoutMs: 500 },
  callback: { secret: 'secret', retries: 0, backoffMs: 1 },
  timeouts: { pollMs: 20, expireSkewSec: 0 },
};

describe('route local vs beav3r', () => {
  it('routes low local, high beav3r', () => {
    expect(chooseRoute({ ...payload, risk: { ...payload.risk, score: 10, level: 'low' } }, cfg)).toBe('local');
    expect(chooseRoute(payload, cfg)).toBe('beav3r');
  });
});

describe('bridge behavior', () => {
  it('handoff returns exact accepted shape and still denies when recovery and beav3r are both unreachable', async () => {
    const failingClient: Beav3rClient = {
      createDecisionRequest: async () => {
        throw new Error('down');
      },
      fetchDecision: async () => {
        throw new Error('still down');
      },
    };

    const receiver = express();
    receiver.use(express.json());
    let callbackSeen = false;
    receiver.post('/callback/openclaw-resolve', (_req, res) => {
      callbackSeen = true;
      res.json({ status: 'resolved' });
    });
    const recvServer = receiver.listen(6553);

    const bridge = new OpenClawBeav3rBridge(cfg, failingClient);
    const app = bridge.app();
    const s = app.listen(6554);

    const r = await fetch('http://127.0.0.1:6554/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await r.json();
    expect(body).toEqual({ approvalId: 'oc_appr_123', status: 'accepted', route: 'beav3r', queued: true });

    await bridge.tick();
    expect(callbackSeen).toBe(true);

    s.close();
    recvServer.close();
  });

  it('timeout transitions to expired callback', async () => {
    const beav3r: Beav3rClient = {
      createDecisionRequest: async () => ({ requestId: 'r1' }),
      fetchDecision: async () => null,
    };
    const results: any[] = [];
    const receiver = express();
    receiver.use(express.json());
    receiver.post('/callback/openclaw-resolve', (req, res) => {
      results.push(req.body);
      res.json({ ok: true });
    });
    const recvServer = receiver.listen(6555);

    const bridge = new OpenClawBeav3rBridge(cfg, beav3r);
    const app = bridge.app();
    const s = app.listen(6556);
    await fetch('http://127.0.0.1:6556/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, approvalId: 'ap2', idempotencyKey: 'ap2:1', expiry: Math.floor(Date.now() / 1000) - 1, callback: { ...payload.callback, url: 'http://127.0.0.1:6555/callback/openclaw-resolve' } }),
    });
    await bridge.tick();
    expect(results[0].status).toBe('expired');

    s.close();
    recvServer.close();
  });

  it('duplicate callback ignored', async () => {
    const beav3r: Beav3rClient = {
      createDecisionRequest: async () => ({ requestId: 'rdup' }),
      fetchDecision: async () => null,
    };
    const receiver = express();
    receiver.use(express.json());
    receiver.post('/callback/openclaw-resolve', (_req, res) => res.json({ ok: true }));
    const recvServer = receiver.listen(6560);

    const bridge = new OpenClawBeav3rBridge(cfg, beav3r);
    const s = bridge.app().listen(6561);
    await fetch('http://127.0.0.1:6561/handoff', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, approvalId: 'dup', idempotencyKey: 'dup:1', callback: { ...payload.callback, url: 'http://127.0.0.1:6560/callback/openclaw-resolve' } }),
    });
    await fetch('http://127.0.0.1:6561/beav3r/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'rdup', status: 'approved' }) });
    const second = await fetch('http://127.0.0.1:6561/beav3r/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'rdup', status: 'approved' }) });
    expect(second.status).toBe(202);

    s.close();
    recvServer.close();
  });

  it('approval resolves correctly after beav3r approval', async () => {
    const resolver = new NoopResolverAdapter();
    const plugin = new OpenClawApprovalsPlugin(
      {
        enabled: true,
        mode: 'optional',
        targets: ['gateway'],
        riskThresholds: { localMax: 30, beav3rMin: 70 },
        envOverrides: { prod: 'beav3r' },
        fallbackPolicy: { medium: 'local', high: 'deny' },
        beav3r: { baseUrl: 'http://localhost:3000', timeoutMs: 3000 },
        bridge: { callbackSecret: 'secret', bridgeUrl: 'http://127.0.0.1:6558' },
      },
      resolver
    );
    const pluginApp = express();
    pluginApp.use(plugin.callbackRouter());
    const pluginServer = pluginApp.listen(6557);

    const beav3r: Beav3rClient = {
      createDecisionRequest: async () => ({ requestId: 'r2' }),
      fetchDecision: async () => null,
    };
    const bridge = new OpenClawBeav3rBridge(cfg, beav3r);
    const s = bridge.app().listen(6558);

    await fetch('http://127.0.0.1:6558/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, approvalId: 'ap3', idempotencyKey: 'ap3:1', callback: { ...payload.callback, url: 'http://127.0.0.1:6557/callback/openclaw-resolve' } }),
    });

    await fetch('http://127.0.0.1:6558/beav3r/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'r2', status: 'approved' }),
    });

    expect(resolver.resolved[0].decision).toBe('allow_once');

    s.close();
    pluginServer.close();
  });

  it('pending approval resolves through fetchDecision polling', async () => {
    const resolver = new NoopResolverAdapter();
    const plugin = new OpenClawApprovalsPlugin(
      {
        enabled: true,
        mode: 'optional',
        targets: ['gateway'],
        riskThresholds: { localMax: 30, beav3rMin: 70 },
        envOverrides: { prod: 'beav3r' },
        fallbackPolicy: { medium: 'local', high: 'deny' },
        beav3r: { baseUrl: 'http://localhost:3000', timeoutMs: 3000 },
        bridge: { callbackSecret: 'secret', bridgeUrl: 'http://127.0.0.1:6563' },
      },
      resolver
    );
    const pluginApp = express();
    pluginApp.use(plugin.callbackRouter());
    const pluginServer = pluginApp.listen(6562);

    let fetches = 0;
    const beav3r: Beav3rClient = {
      createDecisionRequest: async () => ({ requestId: 'r3' }),
      fetchDecision: async () => {
        fetches += 1;
        if (fetches < 2) return null;
        return { status: 'approved', reason: 'Approved by signer' };
      },
    };
    const bridge = new OpenClawBeav3rBridge(cfg, beav3r);
    const s = bridge.app().listen(6563);

    await fetch('http://127.0.0.1:6563/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, approvalId: 'ap4', idempotencyKey: 'ap4:1', callback: { ...payload.callback, url: 'http://127.0.0.1:6562/callback/openclaw-resolve' } }),
    });

    await bridge.tick();
    expect(resolver.resolved).toHaveLength(0);
    await bridge.tick();
    expect(resolver.resolved[0].decision).toBe('allow_once');

    s.close();
    pluginServer.close();
  });

  it('recovers when createDecisionRequest fails but action is later visible by approval id', async () => {
    const resolver = new NoopResolverAdapter();
    const plugin = new OpenClawApprovalsPlugin(
      {
        enabled: true,
        mode: 'optional',
        targets: ['gateway'],
        riskThresholds: { localMax: 30, beav3rMin: 70 },
        envOverrides: { prod: 'beav3r' },
        fallbackPolicy: { medium: 'local', high: 'deny' },
        beav3r: { baseUrl: 'http://localhost:3000', timeoutMs: 3000 },
        bridge: { callbackSecret: 'secret', bridgeUrl: 'http://127.0.0.1:6565' },
      },
      resolver
    );
    const pluginApp = express();
    pluginApp.use(plugin.callbackRouter());
    const pluginServer = pluginApp.listen(6564);

    let fetches = 0;
    const beav3r: Beav3rClient = {
      createDecisionRequest: async () => {
        throw new Error('timeout');
      },
      fetchDecision: async (requestId: string) => {
        expect(requestId).toBe('ap5');
        fetches += 1;
        if (fetches < 3) return null;
        return { status: 'approved', reason: 'Recovered after timeout' };
      },
    };
    const bridge = new OpenClawBeav3rBridge(cfg, beav3r);
    const s = bridge.app().listen(6565);

    const response = await fetch('http://127.0.0.1:6565/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, approvalId: 'ap5', idempotencyKey: 'ap5:1', callback: { ...payload.callback, url: 'http://127.0.0.1:6564/callback/openclaw-resolve' } }),
    });

    expect(response.status).toBe(200);
    await bridge.tick();
    expect(resolver.resolved).toHaveLength(0);
    await bridge.tick();
    expect(resolver.resolved[0].decision).toBe('allow_once');
    expect(resolver.resolved[0].reason).toBe('Recovered after timeout');

    s.close();
    pluginServer.close();
  });
});
