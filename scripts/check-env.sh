#!/usr/bin/env bash
# Verifies the toolchain prerequisites from tasks/todo.md Task 1.
# Exits non-zero if the environment cannot build and test ValueTracker.
set -uo pipefail

fail=0
pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

echo "ValueTracker environment check"
echo

# --- Node ---------------------------------------------------------------
required_major=20                       # NestJS 12: engines.node >= 20
pinned="$(tr -d '[:space:]' < .nvmrc 2>/dev/null || echo '')"

if ! command -v node >/dev/null 2>&1; then
  bad "node not found on PATH"
else
  current="$(node --version | sed 's/^v//')"
  major="${current%%.*}"
  if [ "$major" -ge "$required_major" ]; then
    pass "node $current (>= $required_major required)"
    [ -n "$pinned" ] && [ "$current" != "$pinned" ] && \
      printf '       note: .nvmrc pins %s\n' "$pinned"
  else
    bad "node $current is below the required major $required_major"
    printf '       .nvmrc pins %s -- install it with your version manager\n' "$pinned"
  fi
fi

# --- Docker (required by Testcontainers) --------------------------------
if ! command -v docker >/dev/null 2>&1; then
  bad "docker not found on PATH"
elif docker info >/dev/null 2>&1; then
  pass "docker daemon reachable"
else
  if [ "$(systemctl is-active docker 2>/dev/null)" = "active" ]; then
    bad "docker daemon is running but not reachable by this user"
    printf '       likely cause: user is not in the "docker" group\n'
    printf '       fix: sudo usermod -aG docker "$USER"  (then log out and back in)\n'
  else
    bad "docker daemon is not running"
    printf '       fix: sudo systemctl start docker\n'
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "Environment OK."
else
  echo "Environment NOT ready -- see failures above."
fi
exit "$fail"
