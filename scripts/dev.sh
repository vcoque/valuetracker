#!/usr/bin/env bash
# Run a command inside the ValueTracker DEVELOPMENT toolchain container.
#
# The environment is named explicitly (compose-dev.yaml, .env.dev,
# .env.dev.local) by scripts/_docker.sh -- Compose never picks a file by
# implicit discovery here.
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

if ! vt_compose_files_present; then
  echo "the $VT_ENVIRONMENT environment is not set up -- run ./scripts/check-env.sh --init-env" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- bash
fi

if [ -n "$(vt_compose ps --quiet --status running app 2>/dev/null)" ]; then
  exec_flags=(); [ -t 0 ] || exec_flags=(-T)
  vt_compose exec "${exec_flags[@]}" app "$@"
else
  run_flags=(--rm); [ -t 0 ] || run_flags+=(-T)
  vt_compose run "${run_flags[@]}" app "$@"
fi
