import { HandoffPayloadV1 } from '../types/contracts';

export type BeaverActionRequest = {
  actionId: string;
  agentId: string;
  actionType: string;
  payload: Record<string, unknown>;
  attributes: Record<string, string | number | boolean | null>;
  timestamp: number;
  nonce: string;
  expiry: number;
};

export type BeaverActionRequestResult =
  | { status: 'executed'; actionId: string; actionHash: string }
  | { status: 'pending'; actionId: string; actionHash: string; reason: string }
  | { status: 'denied'; actionId: string; reason: string };

export type BeaverActionStatusResult = {
  actionId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'denied';
  reason?: string;
};

export interface Beav3rClient {
  createDecisionRequest(payload: HandoffPayloadV1): Promise<{ requestId: string }>;
  fetchDecision(
    requestId: string
  ): Promise<
    | null
    | {
        status: 'approved' | 'denied' | 'expired';
        reason?: string;
        approver?: { deviceId: string; publicKey: string; assurance: 'software' | 'hardware' };
        signature?: string;
      }
  >;
  submitApproval?(input: { actionHash: string; deviceId: string; signature: string; expiry: number }): Promise<{ status: 'executed'; actionId: string }>;
  rejectApproval?(input: { actionHash: string; deviceId: string }): Promise<{ status: 'rejected'; actionId: string }>;
}

export class HttpBeav3rClient implements Beav3rClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly apiKey?: string,
    private readonly callbackUrl?: string
  ) {}

  async createDecisionRequest(payload: HandoffPayloadV1): Promise<{ requestId: string }> {
    const request: BeaverActionRequest = {
      actionId: payload.approvalId,
      agentId: payload.actor.agentId,
      actionType: `openclaw.${payload.action.tool}_approval_requested`,
      payload: {
        command: payload.action.command,
        cwd: payload.action.cwd,
        host: payload.action.host,
        node: payload.action.node,
        systemRunPlan: payload.action.systemRunPlan,
        risk: payload.risk,
        callbackUrl: this.callbackUrl ?? resolveBridgeWebhookUrl(),
      },
      attributes: {
        tool: payload.action.tool,
        command: payload.action.command,
        host: payload.action.host ?? null,
        node: payload.action.node,
        risk_score: payload.risk.score,
        risk_level: payload.risk.level,
        environment: payload.environment.envClass,
        channel: payload.actor.channel,
      },
      timestamp: Math.floor(Date.now() / 1000),
      nonce: payload.nonce || payload.approvalId,
      expiry: payload.expiry,
    };

    const res = await this.request('/actions/relay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: request,
        reason: payload.reason,
        source: {
          type: process.env.BEAV3R_ORIGIN_TYPE?.trim() || 'openclaw',
          originLabel: resolveOriginLabel(payload),
          metadata: buildOriginMetadata(payload),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`beaver relay request failed: ${res.status}${await this.describeError(res)}`);
    }
    const body = (await res.json()) as BeaverActionRequestResult;
    return { requestId: body.actionId };
  }

  async fetchDecision(requestId: string) {
    const res = await this.request(`/actions/${encodeURIComponent(requestId)}/status`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`beaver action status failed: ${res.status}${await this.describeError(res)}`);

    const body = (await res.json()) as BeaverActionStatusResult;
    if (body.status === 'pending') return null;
    if (body.status === 'approved' || body.status === 'executed') {
      return { status: 'approved' as const, reason: body.reason };
    }
    if (body.status === 'rejected' || body.status === 'denied') {
      return { status: 'denied' as const, reason: body.reason };
    }
    return { status: 'expired' as const, reason: body.reason };
  }

  async submitApproval(input: { actionHash: string; deviceId: string; signature: string; expiry: number }) {
    const res = await this.request('/approvals/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`beaver submit approval failed: ${res.status}${await this.describeError(res)}`);
    return (await res.json()) as { status: 'executed'; actionId: string };
  }

  async rejectApproval(input: { actionHash: string; deviceId: string }) {
    const res = await this.request('/approvals/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`beaver reject approval failed: ${res.status}${await this.describeError(res)}`);
    return (await res.json()) as { status: 'rejected'; actionId: string };
  }

  private async request(path: string, init?: RequestInit) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...(init?.headers ?? {}),
        },
        signal: c.signal
      });
    } finally {
      clearTimeout(t);
    }
  }

  private async describeError(res: Response): Promise<string> {
    const text = await res.text();
    if (!text) {
      return '';
    }

    try {
      const body = JSON.parse(text) as { error?: string };
      return body.error ? ` ${body.error}` : ` ${text}`;
    } catch {
      return ` ${text}`;
    }
  }
}

function resolveBridgeWebhookUrl(): string {
  const configured = process.env.BRIDGE_PUBLIC_URL?.trim();
  if (configured) {
    return `${configured.replace(/\/+$/, "")}/beav3r/webhook`;
  }

  const host = (process.env.BRIDGE_HOST ?? "127.0.0.1").trim();
  const port = (process.env.BRIDGE_PORT ?? "7772").trim();
  return `http://${host}:${port}/beav3r/webhook`;
}

function resolveOriginLabel(payload: HandoffPayloadV1): string {
  const configured = process.env.BEAV3R_ORIGIN_LABEL?.trim();
  if (configured) {
    return configured;
  }

  const hostname = payload.environment.hostname?.trim();
  if (hostname) {
    return `OpenClaw ${hostname}`;
  }

  const containerHostname = process.env.HOSTNAME?.trim();
  if (containerHostname) {
    return `OpenClaw ${containerHostname}`;
  }

  return `OpenClaw ${payload.actor.agentId}`;
}

function buildOriginMetadata(payload: HandoffPayloadV1): Record<string, unknown> {
  return {
    integration: 'openclaw',
    tool: payload.action.tool,
    agentId: payload.actor.agentId,
    sessionId: payload.actor.sessionId,
    senderId: payload.actor.senderId,
    channel: payload.actor.channel,
    hostname: payload.environment.hostname,
    envClass: payload.environment.envClass,
    workspace: payload.environment.workspace,
    host: payload.action.host ?? null,
    node: payload.action.node,
  };
}
