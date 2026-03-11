import express from 'express';

import { buildPluginConfigFromEnv, resolvePluginServerBinding } from './config/from-env';
import { bindOpenClawRuntime } from './runtime/openclaw-runtime';
import { createGatewayRuntime } from './runtime/gateway-runtime';
import { logger } from './utils/logger';

const cfg = buildPluginConfigFromEnv();
const binding = resolvePluginServerBinding();
const resolved: Array<Record<string, unknown>> = [];

const gatewayRuntime = createGatewayRuntime({
  onEventLog: (event, data) => logger.info(event, data),
});

const plugin = bindOpenClawRuntime({
  runtime: {
    events: gatewayRuntime.runtime.events,
    approvals: {
      async resolveApproval(input) {
        resolved.push({
          approvalId: input.approvalId,
          decision: input.decision,
          reason: input.reason,
          metadata: input.metadata,
        });
        await gatewayRuntime.runtime.approvals.resolveApproval(input);
      },
    },
  },
  config: cfg,
  callbackUrl: `${binding.publicUrl}/callback/openclaw-resolve`,
});

const app = express();
app.use(plugin.callbackRouter());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', component: 'openclaw-approvals-plugin', mode: 'openclaw-gateway' });
});

app.get('/resolved', (_req, res) => {
  res.json({ resolved });
});

const server = app.listen(binding.port, binding.host, () => {
  logger.info('server.started', {
    host: binding.host,
    port: binding.port,
    bridgeUrl: cfg.bridge.bridgeUrl ?? 'http://127.0.0.1:7772',
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL ?? 'ws://127.0.0.1:18789',
    mode: 'openclaw-gateway',
    logLevel: logger.getLevel(),
  });
  gatewayRuntime.start();
});

function shutdown() {
  gatewayRuntime.stop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
