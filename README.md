# OpenClaw × Beav3r

Thin local connector for routing OpenClaw exec approvals into a hosted Beav3r service.

Components:
- `packages/openclaw-approvals`: plugin-side normalizer, handoff sender, signed callback receiver, resolve adapter
- `packages/openclaw-beav3r-bridge`: sidecar bridge with routing, idempotency, callbacks, retries, timeout transitions

## Quick Docker Install
From this repo:

```bash
npm run install:docker
```

The installer:
- prompts for hosted `BEAV3R_URL`
- prompts for `BEAV3R_API_KEY`
- sets `OPENCLAW_GATEWAY_URL` to `ws://host.docker.internal:18789` by default
- generates `CALLBACK_SECRET`
- writes `.env`
- runs `docker compose up -d --build`

Manual Docker flow:

```bash
cp .env.example .env
docker compose up -d --build
```

Health checks:

```bash
curl http://127.0.0.1:7771/health
curl http://127.0.0.1:7772/health
docker compose ps
```

Logs:

```bash
docker compose logs -f plugin
docker compose logs -f bridge
```

Stop:

```bash
docker compose down
```

## Runtime Notes
- OpenClaw stays on the host machine
- Docker runs the plugin and bridge only
- the plugin connects back to the host OpenClaw gateway with `OPENCLAW_GATEWAY_URL`
- the bridge connects to hosted Beav3r with `BEAV3R_URL`

Default local ports:
- plugin: `127.0.0.1:7771`
- bridge: `127.0.0.1:7772`

## Local Dev Without Docker
Bridge:

```bash
BEAV3R_URL=http://127.0.0.1:3000 npm run bridge
```

Plugin:

```bash
BRIDGE_URL=http://127.0.0.1:7772 CALLBACK_SECRET=secret npm run plugin:openclaw
```

## Current Beav3r API Alignment
The bridge now uses Beav3r relay mode for OpenClaw approvals:
- `POST {beav3r.baseUrl}/actions/relay`
- `GET {beav3r.baseUrl}/actions/:actionId/status`
- `POST {beav3r.baseUrl}/approvals/submit`
- `POST {beav3r.baseUrl}/approvals/reject`

Request mapping:
- `actionId <- approvalId`
- `actionType <- openclaw.<tool>_approval_requested`
- `payload <- execution context`
- `attributes <- normalized OpenClaw facts`
- `reason <- upstream OpenClaw approval reason`

## Docs
- `docs/OPENCLAW_BEAV3R_INTEGRATION.md`
- `docs/OPENCLAW_BEAV3R_HASH_SPEC.md`
- `docker-compose.yml`
