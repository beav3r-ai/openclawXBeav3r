import { BridgeConfig, HandoffPayloadV1, Route, RouteReason } from '../types/contracts';

export function chooseRouteWithReason(payload: HandoffPayloadV1, cfg: BridgeConfig): { route: Route; routeReason: RouteReason } {
  const envRule = cfg.envOverrides[payload.environment.envClass];
  if (envRule) {
    return { route: envRule, routeReason: 'env_override' };
  }
  if (payload.risk.level === 'high') {
    return { route: 'beav3r', routeReason: 'risk_level_high' };
  }
  if (payload.risk.level === 'critical') {
    return { route: 'beav3r', routeReason: 'risk_level_critical' };
  }
  if (payload.risk.score <= cfg.riskThresholds.localMax) {
    return { route: 'local', routeReason: 'risk_score_local_threshold' };
  }
  if (payload.risk.score >= cfg.riskThresholds.beav3rMin) {
    return { route: 'beav3r', routeReason: 'risk_score_beav3r_threshold' };
  }
  return cfg.fallbackPolicy.medium === 'local'
    ? { route: 'local', routeReason: 'medium_fallback_local' }
    : { route: 'beav3r', routeReason: 'medium_fallback_beav3r' };
}

export function chooseRoute(payload: HandoffPayloadV1, cfg: BridgeConfig): Route {
  return chooseRouteWithReason(payload, cfg).route;
}

export function unavailableFallback(payload: HandoffPayloadV1, cfg: BridgeConfig): 'local' | 'deny' {
  if (payload.risk.level === 'high' || payload.risk.level === 'critical') {
    return cfg.fallbackPolicy.high ?? 'deny';
  }
  return cfg.fallbackPolicy.medium ?? 'local';
}

export function unavailableFallbackWithReason(
  payload: HandoffPayloadV1,
  cfg: BridgeConfig
): { fallback: 'local' | 'deny'; routeReason: RouteReason } {
  const fallback = unavailableFallback(payload, cfg);
  return {
    fallback,
    routeReason: fallback === 'deny' ? 'beav3r_unavailable_fallback_deny' : 'beav3r_unavailable_fallback_local',
  };
}
