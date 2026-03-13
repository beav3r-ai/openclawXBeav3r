#!/usr/bin/env sh
set -eu

REPO_URL=${REPO_URL:-https://github.com/beav3r-ai/openclawXBeav3r.git}
REPO_REF=${REPO_REF:-main}
BOOTSTRAP_DIR=${BOOTSTRAP_DIR:-}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd sh

cleanup() {
  if [ -n "${CLONE_DIR:-}" ] && [ -d "$CLONE_DIR" ]; then
    rm -rf "$CLONE_DIR"
  fi
}

trap cleanup EXIT INT TERM

if [ -n "$BOOTSTRAP_DIR" ]; then
  rm -rf "$BOOTSTRAP_DIR"
  mkdir -p "$(dirname "$BOOTSTRAP_DIR")"
  CLONE_DIR="$BOOTSTRAP_DIR"
else
  CLONE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-beav3r-bootstrap.XXXXXX")
fi

git clone --branch "$REPO_REF" --depth 1 "$REPO_URL" "$CLONE_DIR"

cd "$CLONE_DIR"
sh scripts/install-docker.sh
