import { RiskLevel } from '../types/contracts';

export interface PluginConfig {
  enabled: boolean;
  mode: 'optional' | 'required';
  targets: ReadonlyArray<'gateway' | 'node'>;
  riskThresholds: { localMax: number; beav3rMin: number };
  envOverrides: Partial<Record<string, 'beav3r' | 'local'>>;
  fallbackPolicy: Partial<Record<RiskLevel, 'local' | 'deny'>>;
  beav3r: { baseUrl: string; timeoutMs: number };
  bridge: { callbackSecret: string; callbackKeyId?: string; bridgeUrl?: string };
}
