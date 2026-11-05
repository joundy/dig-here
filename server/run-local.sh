#!/usr/bin/env bash
# Starts the one local backend, capped so it can't hurt the desktop. The fixed unit name means a
# second start fails rather than running two oracles against each other.
#   server/run-local.sh            start, with logs in server/data/server.log
#   server/run-local.sh stop
#   ENV overrides go first: BOTS_ENABLED=0 server/run-local.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unit=dig-here-server
log="$here/data/server.log"
mkdir -p "$here/data"

if [ "${1:-}" = "stop" ]; then
  systemctl --user stop "$unit.scope" 2>/dev/null || true
  exit 0
fi
if systemctl --user is-active --quiet "$unit.scope"; then
  echo "already running: $unit" >&2
  exit 1
fi
cd "$here/.."
export BOTS_ENABLED="${BOTS_ENABLED:-1}"
setsid nohup systemd-run --user --scope --unit="$unit" -p MemoryMax=1G -p CPUQuota=100% \
  node --disable-warning=ExperimentalWarning server/main.ts >>"$log" 2>&1 </dev/null &
disown
echo "started, log: $log"
