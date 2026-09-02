# shellcheck shell=bash
#
# Shared docker invocation for ValueTracker's scripts. Source, do not execute.
#
# A fresh `usermod -aG docker` only reaches a *new* login session, so until the
# developer logs out and back in, their shell still lacks the group and every
# docker command fails -- making a correct fix look broken. `sg docker -c` runs
# a command under the group without a re-login, so we fall back to it.
#
# The catch: sg takes a single string and runs it with /bin/sh, which is dash on
# Debian and Ubuntu. Bash's `printf %q` escapes anything containing a newline as
# $'...\n...', an ANSI-C form dash does not understand, so a multi-line `sh -c`
# payload arrives mangled. These arguments are therefore re-quoted with POSIX
# single quotes, which every /bin/sh handles.

_vt_shquote() {
  local out='' arg
  for arg in "$@"; do
    out="$out'$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")' "
  done
  printf '%s' "$out"
}

# Run `docker <args>`, transparently re-entering the docker group if needed.
vt_docker() {
  if id -Gn | grep -qw docker; then
    docker "$@"
  else
    sg docker -c "$(_vt_shquote docker "$@")"
  fi
}

# True when the current shell needs the sg fallback -- worth telling the user,
# since it means their group fix is applied but not yet active.
vt_docker_group_is_stale() { ! id -Gn | grep -qw docker; }
