import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type GatewayEventFrameLike = {
  type?: string;
  event: string;
  payload?: unknown;
};

type GatewayResponseFrameLike = {
  type?: string;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string } | string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal?: boolean;
};

type SimpleGatewayClientOptions = {
  url?: string;
  token?: string;
  password?: string;
  clientName?: string;
  clientDisplayName?: string;
  mode?: string;
  scopes?: string[];
  onEvent?: (evt: GatewayEventFrameLike) => void;
  onHelloOk?: () => void;
  onConnectError?: (err: Error) => void;
  onClose?: (code: number, reason: string) => void;
};

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type DeviceTokenStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, { token: string; role: string; scopes?: string[] }>;
};

type PairedDeviceRecord = {
  deviceId: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  approvedScopes?: string[];
  scopes?: string[];
};

const DEFAULT_STATE_DIR = '/Users/ndeto/.openclaw';

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class SimpleGatewayClient {
  private socket: WebSocket | null = null;
  private challengeNonce: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private stopped = false;
  private connectRequestId: string | null = null;

  constructor(private readonly opts: SimpleGatewayClientOptions) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Gateway client stopped'));
    }
    this.pending.clear();
  }

  async request<T = Record<string, unknown>>(method: string, params?: unknown, opts?: { expectFinal?: boolean }): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway websocket is not connected');
    }

    const id = `req_${++this.requestCounter}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: opts?.expectFinal,
      });
    });

    socket.send(
      JSON.stringify({
        type: 'req',
        id,
        method,
        params,
      })
    );

    return promise;
  }

  private open(): void {
    const socket = new WebSocket(this.opts.url ?? 'ws://127.0.0.1:18789');
    this.socket = socket;

    socket.addEventListener('open', () => {
      // wait for connect.challenge
    });

    socket.addEventListener('message', (event) => {
      void this.handleMessage(String(event.data));
    });

    socket.addEventListener('error', (event) => {
      const err = asError((event as ErrorEvent).error ?? new Error('Gateway websocket error'));
      this.opts.onConnectError?.(err);
    });

    socket.addEventListener('close', (event) => {
      this.socket = null;
      this.opts.onClose?.(event.code, event.reason);
      if (!this.stopped) {
        for (const pending of this.pending.values()) {
          pending.reject(new Error('Gateway websocket closed'));
        }
        this.pending.clear();
      }
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const eventFrame = parsed as GatewayEventFrameLike;
    if (eventFrame?.event) {
      if (eventFrame.event === 'connect.challenge') {
        const payload = eventFrame.payload as { nonce?: string } | undefined;
        this.challengeNonce = payload?.nonce?.trim() ?? null;
        this.sendConnect();
        return;
      }

      if (eventFrame.event === 'tick') {
        return;
      }

      this.opts.onEvent?.(eventFrame);
      return;
    }

    const responseFrame = parsed as GatewayResponseFrameLike;
    if (!responseFrame?.id) {
      return;
    }

    const pending = this.pending.get(responseFrame.id);
    if (!pending) {
      return;
    }

    if (pending.expectFinal && responseFrame.payload && typeof responseFrame.payload === 'object') {
      const payload = responseFrame.payload as { status?: string };
      if (payload.status === 'accepted') {
        return;
      }
    }

    this.pending.delete(responseFrame.id);

    if (responseFrame.ok) {
      if (responseFrame.id === this.connectRequestId) {
        this.opts.onHelloOk?.();
      }
      pending.resolve(responseFrame.payload);
      return;
    }

    const message =
      typeof responseFrame.error === 'string'
        ? responseFrame.error
        : responseFrame.error?.message ?? 'Gateway request failed';
    pending.reject(new Error(message));
  }

  private sendConnect(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const nonce = this.challengeNonce?.trim() ?? '';
    if (!nonce) {
      this.opts.onConnectError?.(new Error('Gateway connect challenge missing nonce'));
      socket.close(1008, 'connect challenge missing nonce');
      return;
    }

    const deviceIdentity = loadDeviceIdentity();
    const paired = loadPairedDevice(deviceIdentity.deviceId);
    const role = paired?.role ?? 'operator';
    const scopes = this.opts.scopes ?? paired?.approvedScopes ?? paired?.scopes ?? ['operator.approvals'];
    const platform = paired?.platform ?? process.platform;
    const deviceFamily = paired?.deviceFamily;
    const clientId = paired?.clientId ?? this.opts.clientName ?? 'gateway-client';
    const clientMode = paired?.clientMode ?? this.opts.mode ?? 'backend';
    const deviceToken = loadDeviceToken(deviceIdentity.deviceId, role);
    const authToken = this.opts.token?.trim() || deviceToken || undefined;
    const authPassword = this.opts.password?.trim() || undefined;
    const signedAtMs = Date.now();
    const device = buildDeviceAuthBlock({
      deviceIdentity,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: authToken ?? null,
      nonce,
      platform,
      deviceFamily,
    });

    const auth =
      authToken || authPassword || deviceToken
        ? {
            token: authToken,
            deviceToken,
            password: authPassword,
          }
        : undefined;

    this.connectRequestId = randomId('connect');
    socket.send(
      JSON.stringify({
        type: 'req',
        id: this.connectRequestId,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: clientId,
            displayName: this.opts.clientDisplayName ?? 'Beav3r Approvals',
            version: '0.1.0',
            platform,
            mode: clientMode,
            deviceFamily,
            instanceId: randomId('instance'),
          },
          caps: [],
          role: 'operator',
          scopes,
          auth,
          device,
        },
      })
    );
  }
}

function loadDeviceIdentity(): DeviceIdentity {
  const filePath = path.join(DEFAULT_STATE_DIR, 'identity', 'device.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<DeviceIdentity>;
  if (!parsed.deviceId || !parsed.publicKeyPem || !parsed.privateKeyPem) {
    throw new Error(`Invalid OpenClaw device identity at ${filePath}`);
  }
  return {
    deviceId: parsed.deviceId,
    publicKeyPem: parsed.publicKeyPem,
    privateKeyPem: parsed.privateKeyPem,
  };
}

function loadDeviceToken(deviceId: string, role: string): string | undefined {
  const filePath = path.join(DEFAULT_STATE_DIR, 'identity', 'device-auth.json');
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<DeviceTokenStore>;
  if (parsed.deviceId !== deviceId || !parsed.tokens) {
    return undefined;
  }
  return parsed.tokens[role]?.token;
}

function loadPairedDevice(deviceId: string): PairedDeviceRecord | undefined {
  const filePath = path.join(DEFAULT_STATE_DIR, 'devices', 'paired.json');
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, PairedDeviceRecord>;
  return parsed[deviceId];
}

function buildDeviceAuthBlock(params: {
  deviceIdentity: DeviceIdentity;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}): { id: string; publicKey: string; signature: string; signedAt: number; nonce: string } {
  const payload = [
    'v3',
    params.deviceIdentity.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily ?? ''),
  ].join('|');

  return {
    id: params.deviceIdentity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(params.deviceIdentity.publicKeyPem),
    signature: signDevicePayload(params.deviceIdentity.privateKeyPem, payload),
    signedAt: params.signedAtMs,
    nonce: params.nonce,
  };
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  const spki = crypto.createPublicKey(publicKeyPem).export({
    type: 'spki',
    format: 'der',
  });
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const raw = spki.length === prefix.length + 32 && spki.subarray(0, prefix.length).equals(prefix)
    ? spki.subarray(prefix.length)
    : spki;
  return base64UrlEncode(raw);
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function normalizeDeviceMetadataForAuth(value: string): string {
  return value.trim().toLowerCase();
}
