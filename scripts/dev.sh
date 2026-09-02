#!/usr/bin/env bash
# Run a command inside the ValueTracker toolchain container.
#
#   ./scripts/dev.sh npm ci
#   ./scripts/dev.sh npm test
#   ./scripts/dev.sh              # interactive shell
#
# Reuses the running container when there is one, so an editor terminal and a
# test run share the same node_modules and npm cache.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/_docker.sh
source scripts/_docker.sh

if [ ! -f .env ]; then
  echo "no .env -- run ./scripts/check-env.sh --init-env first" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- bash
fi

if [ -n "$(vt_docker compose ps --quiet --status running app 2>/dev/null)" ]; then
  exec_flags=(); [ -t 0 ] || exec_flags=(-T)
  vt_docker compose exec "${exec_flags[@]}" app "$@"
else
  run_flags=(--rm); [ -t 0 ] || run_flags+=(-T)
  vt_docker compose run "${run_flags[@]}" app "$@"
fi
