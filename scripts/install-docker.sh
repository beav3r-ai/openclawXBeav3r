#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_FILE="$ROOT_DIR/.env.example"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

is_tty() {
  [ -t 0 ]
}

prompt_value() {
  key="$1"
  prompt="$2"
  default_value="${3:-}"
  current_value="${4:-}"
  value="$current_value"
  if [ -z "$value" ]; then
    if is_tty; then
      if [ -n "$default_value" ]; then
        printf "%s [%s]: " "$prompt" "$default_value" >&2
      else
        printf "%s: " "$prompt" >&2
      fi
      IFS= read -r value
      if [ -z "$value" ]; then
        value="$default_value"
      fi
    else
      value="$default_value"
    fi
  fi
  if [ -z "$value" ]; then
    echo "Missing required value for $key" >&2
    exit 1
  fi
  printf "%s" "$value"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  elif command -v shasum >/dev/null 2>&1; then
    date +%s | shasum -a 256 | cut -d' ' -f1 | cut -c1-48
  else
    date +%s | md5 | cut -c1-48
  fi
}

require_cmd docker

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Docker Compose is required." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
fi

get_existing() {
  key="$1"
  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi
  grep "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d'=' -f2-
}

BEAV3R_URL=$(prompt_value "BEAV3R_URL" "Hosted Beav3r URL" "https://api.beav3r.ai" "${BEAV3R_URL:-$(get_existing BEAV3R_URL)}")
BEAV3R_API_KEY=$(prompt_value "BEAV3R_API_KEY" "Beav3r API key" "" "${BEAV3R_API_KEY:-$(get_existing BEAV3R_API_KEY)}")
OPENCLAW_GATEWAY_URL=$(prompt_value "OPENCLAW_GATEWAY_URL" "OpenClaw gateway URL" "ws://host.docker.internal:18789" "${OPENCLAW_GATEWAY_URL:-$(get_existing OPENCLAW_GATEWAY_URL)}")
OPENCLAW_STATE_HOST_PATH=$(prompt_value "OPENCLAW_STATE_HOST_PATH" "OpenClaw state directory on host" "$HOME/.openclaw" "${OPENCLAW_STATE_HOST_PATH:-$(get_existing OPENCLAW_STATE_HOST_PATH)}")
OPENCLAW_STATE_DIR=$(prompt_value "OPENCLAW_STATE_DIR" "OpenClaw state directory in container" "/openclaw-state" "${OPENCLAW_STATE_DIR:-$(get_existing OPENCLAW_STATE_DIR)}")
PLUGIN_PUBLIC_URL=$(prompt_value "PLUGIN_PUBLIC_URL" "Plugin public URL" "http://127.0.0.1:7771" "${PLUGIN_PUBLIC_URL:-$(get_existing PLUGIN_PUBLIC_URL)}")
CALLBACK_SECRET=$(get_existing CALLBACK_SECRET)
if [ -z "$CALLBACK_SECRET" ]; then
  CALLBACK_SECRET=$(random_secret)
fi

cat >"$ENV_FILE" <<EOF
BEAV3R_URL=$BEAV3R_URL
BEAV3R_API_KEY=$BEAV3R_API_KEY
OPENCLAW_GATEWAY_URL=$OPENCLAW_GATEWAY_URL
OPENCLAW_STATE_HOST_PATH=$OPENCLAW_STATE_HOST_PATH
OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR
CALLBACK_SECRET=$CALLBACK_SECRET
CALLBACK_KEY_ID=k1
PLUGIN_PUBLIC_URL=$PLUGIN_PUBLIC_URL
PLUGIN_HOST=0.0.0.0
PLUGIN_PORT=7771
BRIDGE_HOST=0.0.0.0
BRIDGE_PORT=7772
BRIDGE_URL=http://bridge:7772
BEAV3R_TIMEOUT_MS=3000
BRIDGE_POLL_MS=1500
CALLBACK_RETRIES=2
CALLBACK_BACKOFF_MS=100
PENDING_TIMEOUT_SEC=300
EXPIRE_SKEW_SEC=0
RISK_LOCAL_MAX=30
RISK_BEAV3R_MIN=70
FALLBACK_MEDIUM=local
FALLBACK_HIGH=deny
EOF

echo "Starting OpenClaw x Beav3r services..."
(cd "$ROOT_DIR" && $COMPOSE_CMD up -d --build)

cat <<EOF

OpenClaw x Beav3r is up.

Health checks:
  curl http://127.0.0.1:7771/health
  curl http://127.0.0.1:7772/health
  docker compose -f $ROOT_DIR/docker-compose.yml ps

Logs:
  docker compose -f $ROOT_DIR/docker-compose.yml logs -f plugin
  docker compose -f $ROOT_DIR/docker-compose.yml logs -f bridge

Config:
  $ENV_FILE
EOF
