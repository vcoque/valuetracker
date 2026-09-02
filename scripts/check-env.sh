#!/usr/bin/env bash
# Verifies the toolchain prerequisites from tasks/todo.md Task 1.
#
# ValueTracker builds and tests inside a container (see compose.yaml), so the
# only hard host requirements are a reachable Docker daemon and Compose v2+.
# The host's own Node version is advisory -- nothing in the project runs on it.
#
#   ./scripts/check-env.sh              fast checks, no image build
#   ./scripts/check-env.sh --init-env   write the gitignored .env Compose needs
#   ./scripts/check-env.sh --full       also build the image and prove docker-in-docker
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
mode="${1:-}"
pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
info() { printf '  \033[34m--\033[0m   %s\n' "$1"; }
hint() { printf '       %s\n' "$1"; }

# shellcheck source=scripts/_docker.sh
source scripts/_docker.sh

echo "ValueTracker environment check"
echo

# --- Docker daemon (required: the toolchain and Testcontainers both need it) --
docker_ok=0
if ! command -v docker >/dev/null 2>&1; then
  bad "docker not found on PATH"
  hint "install Docker Engine: https://docs.docker.com/engine/install/"
elif vt_docker info >/dev/null 2>&1; then
  pass "docker daemon reachable ($(vt_docker version --format '{{.Server.Version}}' 2>/dev/null))"
  docker_ok=1
  vt_docker_group_is_stale && \
    hint "note: this shell has stale groups; commands are wrapped in 'sg docker'"
else
  if [ "$(systemctl is-active docker 2>/dev/null)" != "active" ]; then
    bad "docker daemon is not running"
    hint "fix: sudo systemctl start docker"
  elif ! getent group docker | grep -qw "$(id -un)"; then
    bad "docker is running but this user is not in the \"docker\" group"
    hint "fix: sudo usermod -aG docker \"\$USER\"   (then log out and back in)"
  else
    bad "docker unreachable despite group membership"
    hint "check permissions on /var/run/docker.sock"
  fi
fi

# --- Docker Compose v2+ -------------------------------------------------------
if [ "$docker_ok" -eq 1 ]; then
  if compose_v="$(vt_docker compose version --short 2>/dev/null)" && [ -n "$compose_v" ]; then
    if [ "${compose_v%%.*}" -ge 2 ]; then
      pass "docker compose v$compose_v"
    else
      bad "docker compose v$compose_v is too old (v2+ required)"
    fi
  else
    bad "the 'docker compose' plugin is not installed"
    hint "fix: install docker-compose-plugin (the legacy docker-compose script will not do)"
  fi
fi

# --- Compose interpolation values --------------------------------------------
# Compose reads .env for ${...} interpolation only from the project directory.
# It is gitignored because DOCKER_GID differs per machine.
want_env="$(printf 'HOST_UID=%s\nHOST_GID=%s\nDOCKER_GID=%s\n' \
  "$(id -u)" "$(id -g)" "$(getent group docker | cut -d: -f3)")"

if [ "$mode" = "--init-env" ]; then
  # Preserve any non-managed lines the user added (secrets, DATABASE_URL, ...).
  if [ -f .env ]; then
    grep -vE '^(HOST_UID|HOST_GID|DOCKER_GID)=' .env > .env.keep || true
  else
    : > .env.keep
  fi
  { echo "$want_env"; cat .env.keep; } > .env && rm -f .env.keep
  pass "wrote .env"
fi

if [ ! -f .env ]; then
  bad ".env is missing (Compose needs HOST_UID/HOST_GID/DOCKER_GID)"
  hint "fix: ./scripts/check-env.sh --init-env"
else
  missing=""
  while IFS='=' read -r k v; do
    grep -qxF "$k=$v" .env || missing="$missing $k"
  done <<< "$want_env"
  if [ -n "$missing" ]; then
    bad ".env is stale or incomplete:$missing"
    hint "fix: ./scripts/check-env.sh --init-env"
  else
    pass ".env matches this host (uid $(id -u), docker gid $(getent group docker | cut -d: -f3))"
  fi
fi

# --- Required files -----------------------------------------------------------
for f in Dockerfile compose.yaml; do
  [ -f "$f" ] && pass "$f present" || bad "$f is missing"
done

# --- Host Node: advisory only -------------------------------------------------
pinned="$(tr -d '[:space:]' < .nvmrc 2>/dev/null || echo '')"
if command -v node >/dev/null 2>&1; then
  host_node="$(node --version | sed 's/^v//')"
  if [ "${host_node%%.*}" -ge 20 ]; then
    info "host node $host_node (unused; the toolchain runs in the container)"
  else
    info "host node $host_node is below 20 -- fine, nothing runs on it"
    hint "the container provides $pinned; .nvmrc is only for optional host-native work"
  fi
else
  info "no host node (not required)"
fi

# --- Full check: the toolchain actually works ---------------------------------
if [ "$mode" = "--full" ] && [ "$docker_ok" -eq 1 ]; then
  echo
  echo "  building the toolchain image (first run pulls layers)..."
  if ! vt_docker compose build app >/dev/null 2>&1; then
    bad "'docker compose build app' failed"
    hint "re-run without redirection to see the error"
  else
    in_node="$(vt_docker compose run --rm --no-deps -T app node --version 2>/dev/null | tr -d '[:space:]\r' | sed 's/^v//')"
    if [ -n "$in_node" ] && [ "${in_node%%.*}" -ge 20 ]; then
      pass "container node $in_node"
      [ -n "$pinned" ] && [ "$in_node" != "$pinned" ] && hint "note: .nvmrc pins $pinned"
    else
      bad "container node version unusable (got '${in_node:-nothing}')"
    fi

    # Prisma's query engine links libssl; node:*-slim does not ship it.
    vt_docker compose run --rm --no-deps -T app \
      sh -c 'ls /usr/lib/*/libssl.so.3 >/dev/null 2>&1' >/dev/null 2>&1 \
      && pass "libssl present in image (Prisma engines need it)" \
      || bad "libssl missing from the image -- Prisma engines will fail to load"

    # Testcontainers talks to the host daemon through the mounted socket and
    # reaches the sibling container's mapped ports via host.docker.internal.
    if vt_docker compose run --rm --no-deps -T app \
         sh -c 'test -S /var/run/docker.sock && getent hosts host.docker.internal' >/dev/null 2>&1; then
      pass "docker socket + host.docker.internal reachable from the container"
    else
      bad "the container cannot reach the docker socket or the host gateway"
      hint "Testcontainers (integration and e2e tests) will not work"
    fi
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "Environment OK."
  [ "$mode" = "--full" ] || echo "Run with --full to build the image and verify the container toolchain."
else
  echo "Environment NOT ready -- see failures above."
fi
exit "$fail"
