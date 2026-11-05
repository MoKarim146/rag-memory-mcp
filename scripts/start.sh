#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-8787}"
export HOST="${HOST:-127.0.0.1}"
export AI_MEMORY_DIR="${AI_MEMORY_DIR:-$HOME/ObsidianVault/AI-Memory}"

if [ ! -d dist ]; then
  npm run build
fi

node dist/index.js
