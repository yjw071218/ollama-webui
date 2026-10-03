#!/bin/sh
# Launcher for Linux and macOS. Uses the Node runtime shipped next to it
# (runtime/bin/node), or a system Node 22.5+ if that is missing.
# Serves on the network; the first run asks for the access token.
set -u
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR/app" || { echo "Ollama WebUI: $DIR/app is missing."; exit 1; }

NODE="$DIR/runtime/bin/node"
if [ ! -x "$NODE" ]; then
  NODE=$(command -v node || true)
  if [ -z "$NODE" ]; then
    echo "Ollama WebUI: Node.js was not found. Reinstall the package or install Node 22.5+."
    exit 1
  fi
fi
# macOS marks downloaded files as quarantined, which stops the bundled node.
if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true
fi

[ -f .env ] || { [ -f .env.example ] && cp .env.example .env; }
# npm (shipped beside node) and freshly installed CLIs, for this shell.
PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
export PATH
# First run: asks for the access token (the app serves on the network, as
# the project's start script does) and sets up Claude Code / Codex / agy.
# Later runs return at once.
"$NODE" server/first-run.mjs || exit 1
"$NODE" server/setup-env.mjs --network
PORT=$("$NODE" server/setup-env.mjs --print-port 2>/dev/null || echo 5173)
[ -n "$PORT" ] || PORT=5173
URL="http://localhost:$PORT"

open_browser() {
  if [ "$(uname -s)" = "Darwin" ]; then open "$URL" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  fi
}

if command -v curl >/dev/null 2>&1 && curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/"; then
  echo "Ollama WebUI is already running at $URL"
  open_browser
  exit 0
fi

echo "Starting Ollama WebUI on $URL ..."
echo "Press Ctrl+C (or close this window) to stop it."
( sleep 3; open_browser ) &
"$NODE" server/index.js
code=$?
if [ "$code" -ne 0 ]; then
  echo ""
  echo "Ollama WebUI stopped with an error ($code). The message above says why."
  # Keep a double-clicked Terminal window open long enough to read it.
  [ -t 0 ] && { printf 'Press Enter to close.'; read -r _; }
fi
exit "$code"
