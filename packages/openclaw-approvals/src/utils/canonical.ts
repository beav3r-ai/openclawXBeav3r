import crypto from 'node:crypto';
import { CanonicalAction, HandoffPayloadV1 } from '../types/contracts';

export function stableStringify(input: unknown): string {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(stableStringify).join(',')}]`;
  const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function canonicalActionHashParts(payload: {
  action: CanonicalAction;
  actor: HandoffPayloadV1['actor'];
  environment: HandoffPayloadV1['environment'];
  expiry: number;
  nonce: string;
}) {
  return {
    tool: payload.action.tool,
    command: payload.action.command,
    cwd: payload.action.cwd ?? '',
    host: payload.action.host ?? '',
    node: payload.action.node,
    systemRunPlan: payload.action.systemRunPlan ?? {},
    actor: payload.actor,
    environment: payload.environment,
    expiry: payload.expiry,
    nonce: payload.nonce,
  };
}

export function computeActionHash(input: Parameters<typeof canonicalActionHashParts>[0]): string {
  const canonical = stableStringify(canonicalActionHashParts(input));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
