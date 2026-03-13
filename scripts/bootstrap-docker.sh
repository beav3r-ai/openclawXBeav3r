#!/usr/bin/env sh
set -eu

REPO_URL=${REPO_URL:-https://github.com/beav3r-ai/openclawXBeav3r.git}
INSTALL_DIR=${INSTALL_DIR:-"$HOME/.beav3r/openclaw-bridge"}
REPO_REF=${REPO_REF:-main}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd sh

mkdir -p "$(dirname "$INSTALL_DIR")"

if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone --branch "$REPO_REF" --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" fetch origin "$REPO_REF"
  git -C "$INSTALL_DIR" checkout "$REPO_REF"
  git -C "$INSTALL_DIR" pull --ff-only origin "$REPO_REF"
fi

cd "$INSTALL_DIR"
exec sh scripts/install-docker.sh
