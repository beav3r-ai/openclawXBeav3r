import type { OpenClawApprovalInput } from '../normalize';

export interface ApprovalSchemaAdapter {
  name: string;
  adapt(payload: unknown): OpenClawApprovalInput | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return asString(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

const canonicalApprovalAdapter: ApprovalSchemaAdapter = {
  name: 'canonical-approval-input',
  adapt(payload) {
    const body = asRecord(payload);
    const action = asRecord(body?.action);
    const risk = asRecord(body?.risk);
    const actor = asRecord(body?.actor);
    const environment = asRecord(body?.environment);

    if (!body || !action || !risk || !actor || !environment) return null;

    const approvalId = asString(body.approvalId);
    const tool = asString(action.tool);
    const command = asString(action.command);
    const expiry = asNumber(body.expiry);
    const nonce = asString(body.nonce);
    const reason = asString(body.reason);
    const idempotencyKey = asString(body.idempotencyKey);

    if (!approvalId || !tool || !command || expiry === undefined || !nonce || !reason || !idempotencyKey) {
      return null;
    }

    return {
      approvalId,
      action: {
        tool,
        command,
        cwd: asString(action.cwd),
        host: asString(action.host),
        node: asNullableString(action.node) ?? null,
        systemRunPlan: asRecord(action.systemRunPlan) ?? {},
      },
      risk: {
        score: asNumber(risk.score) ?? 0,
        level: (asString(risk.level) as OpenClawApprovalInput['risk']['level']) ?? 'medium',
        reasons: asStringArray(risk.reasons) ?? [],
      },
      actor: {
        agentId: asString(actor.agentId) ?? 'unknown',
        sessionId: asString(actor.sessionId) ?? 'unknown',
        senderId: asString(actor.senderId) ?? 'unknown',
        channel: asString(actor.channel) ?? 'unknown',
      },
      environment: {
        workspace: asString(environment.workspace) ?? '',
        hostname: asString(environment.hostname) ?? '',
        envClass: asString(environment.envClass) ?? 'unknown',
      },
      expiry,
      nonce,
      reason,
      idempotencyKey,
    };
  },
};

const openClawGatewayEventAdapter: ApprovalSchemaAdapter = {
  name: 'openclaw-gateway-event',
  adapt(payload) {
    const body = asRecord(payload);
    const request = asRecord(body?.request);
    const risk = asRecord(body?.risk);
    const actor = asRecord(body?.actor);
    const environment = asRecord(body?.environment);

    if (!body || !request) return null;

    const approvalId = asString(body.approvalId) ?? asString(body.id);
    const command = asString(request.command);

    if (!approvalId || !command) return null;

    const expiresAtMs = asNumber(body.expiresAtMs);
    const expiry = asNumber(body.expiry) ?? (expiresAtMs !== undefined ? Math.floor(expiresAtMs / 1000) : Math.floor(Date.now() / 1000) + 300);

    const actorAgentId =
      asString(actor?.agentId) ??
      asString(request.agentId) ??
      asString(asRecord(request.systemRunPlan)?.agentId) ??
      'unknown';
    const actorSessionId =
      asString(actor?.sessionId) ??
      asString(request.sessionKey) ??
      asString(asRecord(request.systemRunPlan)?.sessionKey) ??
      'unknown';

    const workspace =
      asString(environment?.workspace) ??
      asString(request.cwd) ??
      asString(asRecord(request.systemRunPlan)?.cwd) ??
      '';
    const host =
      asString(request.host) ??
      asString(environment?.hostname) ??
      'gateway';
    const node = asNullableString(request.nodeId) ?? asNullableString(request.node) ?? null;
    const envClass =
      asString(environment?.envClass) ??
      (host.toLowerCase().includes('prod') ? 'prod' : node ? 'node' : 'unknown');

    const systemRunPlan = asRecord(request.systemRunPlan) ?? {};
    const actionTool = asString(asRecord(body?.action)?.tool) ?? 'exec';

    return {
      approvalId,
      action: {
        tool: actionTool,
        command,
        cwd: workspace || undefined,
        host,
        node,
        systemRunPlan,
      },
      risk: {
        score: asNumber(risk?.score) ?? 80,
        level: (asString(risk?.level) as OpenClawApprovalInput['risk']['level']) ?? 'high',
        reasons: asStringArray(risk?.reasons) ?? ['approval_requested'],
      },
      actor: {
        agentId: actorAgentId,
        sessionId: actorSessionId,
        senderId:
          asString(actor?.senderId) ??
          asString(request.turnSourceAccountId) ??
          asString(request.turnSourceTo) ??
          'unknown',
        channel: asString(actor?.channel) ?? asString(request.turnSourceChannel) ?? 'unknown',
      },
      environment: {
        workspace,
        hostname: asString(environment?.hostname) ?? host,
        envClass,
      },
      expiry,
      nonce: asString(body.nonce) ?? approvalId,
      reason: asString(body.reason) ?? 'exec approval requested',
      idempotencyKey: asString(body.idempotencyKey) ?? `${approvalId}:1`,
    };
  },
};

export const defaultApprovalSchemaAdapters: ApprovalSchemaAdapter[] = [canonicalApprovalAdapter, openClawGatewayEventAdapter];

export function adaptApprovalInput(
  payload: unknown,
  adapters: ApprovalSchemaAdapter[] = defaultApprovalSchemaAdapters
): OpenClawApprovalInput {
  for (const adapter of adapters) {
    const adapted = adapter.adapt(payload);
    if (adapted) return adapted;
  }

  throw new Error('invalid approval payload');
}
