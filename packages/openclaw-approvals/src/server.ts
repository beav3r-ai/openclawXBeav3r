import express from 'express';
import { InMemoryApprovalEventSource } from './adapters/event-source';
import { NoopResolverAdapter } from './adapters/resolver';
import { OpenClawApprovalsPlugin } from './plugin';
import { OpenClawApprovalInput } from './normalize';
import { bindOpenClawRuntime, OpenClawRuntimeLike } from './runtime/openclaw-runtime';
import { adaptApprovalInput } from './adapters/schema-adapter';
import { buildPluginConfigFromEnv, resolvePluginServerBinding } from './config/from-env';
import { logger } from './utils/logger';

function parseApprovalInput(value: unknown): OpenClawApprovalInput | null {
  try {
    return adaptApprovalInput(value);
  } catch {
    return null;
  }
}

const binding = resolvePluginServerBinding();
const cfg = buildPluginConfigFromEnv();

const runtime = (globalThis as { __OPENCLAW_RUNTIME__?: OpenClawRuntimeLike }).__OPENCLAW_RUNTIME__;
const resolver = new NoopResolverAdapter();
const eventSource = new InMemoryApprovalEventSource();
const plugin = runtime
  ? bindOpenClawRuntime({ runtime, config: cfg, callbackUrl: `${binding.publicUrl}/callback/openclaw-resolve` })
  : new OpenClawApprovalsPlugin(cfg, resolver);

if (!runtime) {
  plugin.bindApprovalRequested(eventSource, `${binding.publicUrl}/callback/openclaw-resolve`);
}

const app = express();
app.use(plugin.callbackRouter());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', component: 'openclaw-approvals-plugin' });
});

app.post('/events/approval-requested', async (req, res) => {
  const payload = parseApprovalInput(req.body);
  if (!payload) {
    return res.status(400).json({ error: 'invalid approval payload' });
  }

  try {
    await eventSource.emit(payload);
    return res.status(202).json({ status: 'accepted', approvalId: payload.approvalId });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/handoff', async (req, res) => {
  const payload = parseApprovalInput(req.body);
  if (!payload) {
    return res.status(400).json({ error: 'invalid approval payload' });
  }

  try {
    const result = await plugin.handoff(payload, `${binding.publicUrl}/callback/openclaw-resolve`);
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ error: (error as Error).message });
  }
});

app.get('/resolved', (_req, res) => {
  res.json({ resolved: resolver.resolved });
});

const server = app.listen(binding.port, binding.host, () => {
  logger.info('server.started', {
    host: binding.host,
    port: binding.port,
    bridgeUrl: process.env.BRIDGE_URL ?? 'http://127.0.0.1:7772',
    logLevel: logger.getLevel(),
  });
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
