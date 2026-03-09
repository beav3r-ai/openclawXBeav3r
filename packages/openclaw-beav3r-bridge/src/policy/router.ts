import { BridgeConfig, HandoffPayloadV1, Route } from '../types/contracts';

export function chooseRoute(payload: HandoffPayloadV1, cfg: BridgeConfig): Route {
  const envRule = cfg.envOverrides[payload.environment.envClass];
  if (envRule) return envRule;
  if (payload.risk.level === 'high' || payload.risk.level === 'critical') return 'beav3r';
  if (payload.risk.score <= cfg.riskThresholds.localMax) return 'local';
  if (payload.risk.score >= cfg.riskThresholds.beav3rMin) return 'beav3r';
  return cfg.fallbackPolicy.medium === 'local' ? 'local' : 'beav3r';
}

export function unavailableFallback(payload: HandoffPayloadV1, cfg: BridgeConfig): 'local' | 'deny' {
  if (payload.risk.level === 'high' || payload.risk.level === 'critical') {
    return cfg.fallbackPolicy.high ?? 'deny';
  }
  return cfg.fallbackPolicy.medium ?? 'local';
}
