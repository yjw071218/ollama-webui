#!/usr/bin/env bash
# Real-data bench: the PREVIOUS build's first sync against a snapshot server.
#   USER_ID=<account id> SNAP=<snapshotDir> OLDSRV=<dir with server/, src/, dist/ (old build), node_modules> bash scripts/bench/old-sync.sh
#
# Never touches this repo's ./dist: a live server may be serving it. The old
# build is served by a copy of the server code in OLDSRV, on the snapshot,
# with schedules, Telegram, backups and Ollama management off. Syncs one fresh
# device and reports what that device wrote to the account.
set -u
# A bench server must not reach anything real. CLI models are the dangerous one:
# the account's synced default model can be Claude Code / Codex / agy, and a
# benchmark's test messages then run the real CLI on this machine against the
# real subscription (that happened once: 16 opus turns before it was caught).
# CLI_MODELS=false makes the server offer and route none of them.
grep -q 'CLI_MODELS=false' "$0" || { echo 'refusing: CLI_MODELS=false missing'; exit 2; }
cd "$(dirname "$0")/../.."
USER_ID="${USER_ID:?set USER_ID to the account id}"
WEBUI_DATA_DIR="$SNAP" PORT=8291 HOST=127.0.0.1 PUBLIC_ORIGIN=http://127.0.0.1:8291 ACCESS_TOKEN= SERVER_SCHEDULES=false \
  TELEGRAM_BOT_TOKEN= CLI_MODELS=false CLI_PROVIDERS=none DB_BACKUP_ENABLED=false OLLAMA_MANAGED=false OLLAMA_URL=http://127.0.0.1:1 node "$OLDSRV/server/index.js" > /dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8291/ && break; sleep 0.5; done
TOKEN=$(WEBUI_DATA_DIR="$SNAP" node scripts/bench/make-session.mjs $USER_ID 2>/dev/null | tail -1)
REV0=$(curl -s -b "webui_session=$TOKEN" "http://127.0.0.1:8291/api/auth/stats?rev=1" | sed 's/.*"rev":\([0-9]*\).*/\1/')
echo "rev before: $REV0"
timeout 1500 node scripts/bench/sync-bench.mjs --origin http://127.0.0.1:8291 --token "$TOKEN" --label sync-old --minutes 20 --cdp 9680
echo "--- what the old build's first sync wrote to the account:"
WEBUI_DATA_DIR="$SNAP" node scripts/bench/inspect-revs.mjs $USER_ID "$REV0" 2>&1 | grep -vi warn | sed -n '1p;3p'
