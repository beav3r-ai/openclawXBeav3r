import { PluginConfig } from './types';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw ? Number(raw) : fallback;
}

export function buildPluginConfigFromEnv(): PluginConfig {
  return {
    enabled: true,
    mode: (process.env.PLUGIN_MODE as 'optional' | 'required' | undefined) ?? 'optional',
    targets: ['gateway', 'node'],
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
      baseUrl: process.env.BEAV3R_URL ?? 'https://server.beav3r.ai',
      timeoutMs: intEnv('BEAV3R_TIMEOUT_MS', 3000),
    },
    bridge: {
      callbackSecret: process.env.CALLBACK_SECRET ?? 'secret',
      callbackKeyId: process.env.CALLBACK_KEY_ID ?? 'k1',
      bridgeUrl: process.env.BRIDGE_URL ?? 'http://127.0.0.1:7772',
    },
  };
}

export function resolvePluginServerBinding() {
  const port = intEnv('PLUGIN_PORT', 7771);
  const host = process.env.PLUGIN_HOST ?? '127.0.0.1';
  const publicUrl = process.env.PLUGIN_PUBLIC_URL ?? `http://${host}:${port}`;
  return { port, host, publicUrl };
}
