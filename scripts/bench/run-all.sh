#!/usr/bin/env bash
# Real-data bench: everything, in order, into one log.
#   SNAP=<snapshotDir> TOKENS="t1 t2 t3" bash scripts/bench/run-all.sh > log
# Needs the snapshot server already running on 127.0.0.1:8290 serving ./dist.
set -u
cd "$(dirname "$0")/../.."
DATA="$SNAP\\chats.json"
set -- $TOKENS
echo "=== local: new desktop"; node scripts/bench/browser-bench.mjs --dist "$PWD/dist" --data "$DATA" --label new --port 8281 | grep -E "^\[|RESULT"
echo "=== local: new mobile"; node scripts/bench/browser-bench.mjs --dist "$PWD/dist" --data "$DATA" --label new-mobile --mobile --port 8282 | grep -E "^\[|RESULT"
echo "=== sync: new desktop, two devices"; node scripts/bench/sync-bench.mjs --token "$1" --token2 "$2" --label sync-new --second --minutes 20 --cdp 9650 | grep -E "^\[|RESULT"
echo "=== sync: new mobile"; node scripts/bench/sync-bench.mjs --token "$3" --label sync-new-mobile --mobile --minutes 20 --cdp 9660 | grep -E "^\[|RESULT"
# The previous build: scripts/bench/old-sync.sh (never swap ./dist -- a live
# server may be serving it).
echo "=== done"
