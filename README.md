# OpenClaw × Beav3r

Thin local connector for routing OpenClaw exec approvals into a hosted Beav3r service.

## Quick Install
Use the curl bootstrap. It clones the bridge repo, writes `.env`, and starts Docker.

```bash
curl -fsSL https://raw.githubusercontent.com/beav3r-ai/openclawXBeav3r/main/scripts/bootstrap-docker.sh | \
  BEAV3R_API_KEY=bvr_test_replace_me sh
```

You only need:
- a Beav3r API key
- Docker running locally
- OpenClaw reachable on the host machine

Optional overrides:

```bash
curl -fsSL https://raw.githubusercontent.com/beav3r-ai/openclawXBeav3r/main/scripts/bootstrap-docker.sh | \
  BEAV3R_API_KEY=bvr_test_replace_me \
  BEAV3R_URL=https://api.beav3r.ai \
  OPENCLAW_GATEWAY_URL=ws://host.docker.internal:18789 \
  sh
```

For a local Beav3r server, pass it explicitly the same way as the API key:

```bash
curl -fsSL https://raw.githubusercontent.com/beav3r-ai/openclawXBeav3r/main/scripts/bootstrap-docker.sh | \
  BEAV3R_API_KEY=bvr_test_replace_me \
  BEAV3R_URL=http://host.docker.internal:3000 \
  sh
```

Aliases also work:
- `BEAV3R_SERVER_URL`
- `BEAV3R_SERVER`

Docker callback routing note:

- the bridge calls back into the plugin over the Docker network
- leave `PLUGIN_PUBLIC_URL` at the default `http://plugin:7771` unless you are deliberately exposing the plugin outside Docker

## Repo-local install
If you already cloned this repo:

```bash
npm run install:docker
```

## Manual Docker flow

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


## Current Beav3r API Alignment

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
