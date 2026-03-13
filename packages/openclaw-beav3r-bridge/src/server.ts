import { HttpBeav3rClient } from './adapters/beav3r-client';
import { OpenClawBeav3rBridge } from './bridge';
import { FileApprovalStore } from './state/store';
import { logger } from './utils/logger';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw ? Number(raw) : fallback;
}

const port = intEnv('BRIDGE_PORT', 7772);
const host = process.env.BRIDGE_HOST ?? '127.0.0.1';
const publicUrl = (process.env.BRIDGE_PUBLIC_URL ?? `http://${host}:${port}`).replace(/\/+$/, '');
const stateDir = process.env.BRIDGE_STATE_DIR ?? '/tmp/openclaw-beav3r-bridge';
const pollMs = intEnv('BRIDGE_POLL_MS', 1500);
const timeoutMs = intEnv('BEAV3R_TIMEOUT_MS', 3000);

const bridge = new OpenClawBeav3rBridge(
  {
    riskThresholds: {
      localMax: intEnv('RISK_LOCAL_MAX', 30),
      beav3rMin: intEnv('RISK_BEAV3R_MIN', 70),
    },
    envOverrides: process.env.PROD_ROUTE_BEAV3R === 'false' ? {} : { prod: 'beav3r' },
    fallbackPolicy: {
      medium: (process.env.FALLBACK_MEDIUM as 'local' | 'deny' | undefined) ?? 'local',
      high: (process.env.FALLBACK_HIGH as 'local' | 'deny' | undefined) ?? 'deny',
    },
    beav3r: {
      baseUrl: process.env.BEAV3R_URL ?? 'https://api.beav3r.ai',
      timeoutMs,
    },
    callback: {
      secret: process.env.CALLBACK_SECRET ?? 'secret',
      retries: intEnv('CALLBACK_RETRIES', 2),
      backoffMs: intEnv('CALLBACK_BACKOFF_MS', 100),
    },
    timeouts: {
      pollMs,
      expireSkewSec: intEnv('EXPIRE_SKEW_SEC', 0),
      pendingTimeoutSec: intEnv('PENDING_TIMEOUT_SEC', 300),
    },
  },
  new HttpBeav3rClient(
    process.env.BEAV3R_URL ?? 'https://api.beav3r.ai',
    timeoutMs,
    process.env.BEAV3R_API_KEY,
    `${publicUrl}/beav3r/webhook`
  ),
  new FileApprovalStore(`${stateDir.replace(/\/+$/, '')}/approvals.json`)
);

const app = bridge.app();
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', component: 'openclaw-beav3r-bridge' });
});

const server = app.listen(port, host, () => {
  logger.info('server.started', {
    host,
    port,
    publicUrl,
    stateDir,
    beav3rUrl: process.env.BEAV3R_URL ?? 'https://api.beav3r.ai',
    pollMs,
    logLevel: logger.getLevel(),
  });
});

bridge.startStateLoop();

function shutdown() {
  bridge.stopStateLoop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
