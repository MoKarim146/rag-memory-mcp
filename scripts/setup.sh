#!/usr/bin/env bash
# One-command setup: checks Node.js, installs, builds, writes .env and prints how to connect an AI.
# Usage: ./scripts/setup.sh [memory folder]     (default: ~/ObsidianVault/AI-Memory)
set -euo pipefail
cd "$(dirname "$0")/.."

need="22.13"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js $need or newer is needed: https://nodejs.org" >&2
  exit 1
fi
if ! node -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  const [c, d] = process.argv[1].split(".").map(Number);
  process.exit(a > c || (a === c && b >= d) ? 0 : 1);
' "$need"; then
  echo "Node.js $(node --version) found; $need or newer is needed: https://nodejs.org" >&2
  exit 1
fi

memory_dir="${1:-${AI_MEMORY_DIR:-$HOME/ObsidianVault/AI-Memory}}"

echo "1/3 Installing packages (package install scripts are not run)"
npm ci --ignore-scripts --no-audit --no-fund

echo "2/3 Building"
npm run --silent build

echo "3/3 Settings"
if [ -f .env ]; then
  echo "    .env already exists, left as it is"
else
  # Copy .env.example and set the memory folder. Readable by you only.
  node -e '
    const fs = require("node:fs");
    const dir = process.argv[1];
    const text = fs.readFileSync(".env.example", "utf8").replace(/^AI_MEMORY_DIR=.*$/m, () => `AI_MEMORY_DIR=${dir}`);
    fs.writeFileSync(".env", text, { mode: 0o600 });
  ' "$memory_dir"
  echo "    wrote .env with AI_MEMORY_DIR=$memory_dir"
fi

cat <<EOF

Done. Use a folder only for AI memory, not your whole vault. It is created on first start if missing.

Start the server:
  npm start

Connect Claude Code (in another terminal):
  claude mcp add --transport http memory http://127.0.0.1:8787/mcp

Optional: teach your AI how to use the memory well:
  mkdir -p ~/.claude/skills && cp -r skills/rag-memory ~/.claude/skills/

All settings are explained in .env.
EOF
