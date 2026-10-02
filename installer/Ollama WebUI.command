#!/bin/sh
# Double-click in Finder to start Ollama WebUI (macOS opens .command files in Terminal).
exec "$(dirname -- "$0")/ollama-webui.sh"
