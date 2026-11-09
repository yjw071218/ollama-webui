#!/usr/bin/env bash
# Real-data bench: serve a given BUILD on a SNAPSHOT, without touching ./dist.
#   SNAP=<snapshotDir> BUILD=<built dist dir> PORT=8292 bash scripts/bench/serve-build.sh <command...>
# Copies this repo's server/ and src/ into a scratch root next to BUILD,
# links node_modules and integrations/risuai (junctions, removed afterwards --
# never deleted through), runs the server there with schedules, Telegram,
# backups, CLI models and Ollama management off -- and a stand-in Ollama
# (fake-ollama.mjs) answering every chat -- runs <command...>, then stops it all.
set -u
# A bench server must not reach anything real. CLI models are the dangerous one:
# the account's synced default model can be Claude Code / Codex / agy, and a
# benchmark's test messages then run the real CLI on this machine against the
# real subscription (that happened once: 16 opus turns before it was caught).
# CLI_MODELS=false makes the server offer and route none of them.
grep -q 'CLI_MODELS=false' "$0" || { echo 'refusing: CLI_MODELS=false missing'; exit 2; }
cd "$(dirname "$0")/../.."
REPO="$PWD"
ROOT="$(dirname "$BUILD")/serve-root-$PORT"
rm -rf "$ROOT"; mkdir -p "$ROOT/server" "$ROOT/integrations"
find server -maxdepth 1 -type f \( -name '*.js' -o -name '*.mjs' \) -exec cp {} "$ROOT/server/" \;
cp package.json "$ROOT/"; cp -r src "$ROOT/src"; cp -r "$BUILD" "$ROOT/dist"
win() { cygpath -w "$1"; }
cmd //c mklink //J "$(win "$ROOT/node_modules")" "$(win "$REPO/node_modules")" > /dev/null
cmd //c mklink //J "$(win "$ROOT/integrations/risuai")" "$(win "$REPO/integrations/risuai")" > /dev/null
FAKE=$((PORT + 100))
node scripts/bench/fake-ollama.mjs $FAKE > /dev/null 2>&1 &
FAKE_PID=$!
WEBUI_DATA_DIR="$SNAP" PORT=$PORT HOST=127.0.0.1 PUBLIC_ORIGIN=http://127.0.0.1:$PORT ACCESS_TOKEN= SERVER_SCHEDULES=false \
  TELEGRAM_BOT_TOKEN= CLI_MODELS=false CLI_PROVIDERS=none DB_BACKUP_ENABLED=false OLLAMA_MANAGED=false OLLAMA_URL=http://127.0.0.1:$FAKE node "$ROOT/server/index.js" > /dev/null 2>&1 &
SERVER=$!
USAGE0=$(cat "$SNAP/cli-usage.jsonl" 2>/dev/null | wc -l)
cleanup() {
  kill $SERVER $FAKE_PID 2>/dev/null; sleep 1
  USAGE1=$(cat "$SNAP/cli-usage.jsonl" 2>/dev/null | wc -l)
  if [ "$USAGE1" -gt "$USAGE0" ]; then echo "!!! CLI turns ran during the bench: $((USAGE1 - USAGE0))"; else echo "cli turns during bench: 0"; fi
  cmd //c rmdir "$(win "$ROOT/node_modules")" > /dev/null 2>&1
  cmd //c rmdir "$(win "$ROOT/integrations/risuai")" > /dev/null 2>&1
  [ ! -e "$ROOT/node_modules" ] && [ ! -e "$ROOT/integrations/risuai" ] && rm -rf "$ROOT"
}
trap cleanup EXIT
for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.5; done
"$@"
