import express from 'express';
import { OpenClawApprovalsPlugin, NoopResolverAdapter } from '../packages/openclaw-approvals/src';
import { HttpBeav3rClient, OpenClawBeav3rBridge } from '../packages/openclaw-beav3r-bridge/src';

async function main() {
  const resolver = new NoopResolverAdapter();
  const beav3rBaseUrl = process.env.BEAV3R_URL ?? 'http://127.0.0.1:3000';
  const plugin = new OpenClawApprovalsPlugin(
    {
      enabled: true,
      mode: 'optional',
      targets: ['gateway'],
      riskThresholds: { localMax: 30, beav3rMin: 70 },
      envOverrides: { prod: 'beav3r' },
      fallbackPolicy: { medium: 'local', high: 'deny' },
      beav3r: { baseUrl: beav3rBaseUrl, timeoutMs: 3000 },
      bridge: { callbackSecret: 'secret', bridgeUrl: 'http://127.0.0.1:7772' },
    },
    resolver
  );

  const pluginApp = express();
  pluginApp.use(plugin.callbackRouter());
  const pluginServer = pluginApp.listen(7771);

  const beav3r = new HttpBeav3rClient(beav3rBaseUrl, 3000);
  const bridge = new OpenClawBeav3rBridge(
    {
      riskThresholds: { localMax: 30, beav3rMin: 70 },
      envOverrides: {},
      fallbackPolicy: { medium: 'local', high: 'deny' },
      beav3r: { baseUrl: beav3rBaseUrl, timeoutMs: 3000 },
      callback: { secret: 'secret', retries: 2, backoffMs: 50 },
      timeouts: { pollMs: 1500, expireSkewSec: 0 },
    },
    beav3r
  );

  const bridgeServer = bridge.app().listen(7772);
  bridge.startStateLoop();

  const handoffRes = await plugin.handoff(
    {
      approvalId: 'oc_appr_demo',
      action: { tool: 'exec', command: 'kubectl apply -f prod.yaml', cwd: '/workspace', host: 'gateway', node: null, systemRunPlan: {} },
      risk: { score: 86, level: 'high', reasons: ['prod_env', 'deploy_action'] },
      actor: { agentId: 'main', sessionId: 'agent:main:demo', senderId: 'telegram:12345', channel: 'telegram' },
      environment: { workspace: '/Users/ndeto/.openclaw/workspace', hostname: 'gateway-host', envClass: 'prod' },
      expiry: Math.floor(Date.now() / 1000) + 300,
      nonce: 'random_128b',
      reason: 'Exec requires approval under policy',
      idempotencyKey: 'oc_appr_demo:1',
    },
    'http://127.0.0.1:7771/callback/openclaw-resolve'
  );

  console.log('beav3r base url:', beav3rBaseUrl);
  console.log('handoff response:', handoffRes);
  console.log('approve or deny the action in your real Beav3r flow, then wait for callback resolution...');

  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    if (resolver.resolved.length > 0) {
      console.log('resolver decisions:', resolver.resolved);
      bridge.stopStateLoop();
      bridgeServer.close();
      pluginServer.close();
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('resolver decisions:', resolver.resolved);
  console.log('timed out waiting for Beav3r decision after 120s');

  bridge.stopStateLoop();
  bridgeServer.close();
  pluginServer.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
