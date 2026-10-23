#!/usr/bin/env bash
# Run a build or test command while holding a machine-wide lock,
# so only one build/test runs at a time across all agents.
#
#   scripts/serial.sh bun test
#   scripts/serial.sh bun run build
set -euo pipefail

LOCK="${OUTSCALED_LOCK:-/tmp/outscaled-build.lock}"

while ! mkdir "$LOCK" 2>/dev/null; do
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)
  # Clear a lock left behind by a process that no longer exists.
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$LOCK"
    continue
  fi
  sleep 2
done

echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM

"$@"
