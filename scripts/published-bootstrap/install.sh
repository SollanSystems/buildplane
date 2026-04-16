#!/usr/bin/env bash
set -euo pipefail

resolve_command() {
  local candidate="$1"
  if [ -z "$candidate" ]; then
    return 1
  fi
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if command -v "$candidate" >/dev/null 2>&1; then
    command -v "$candidate"
    return 0
  fi
  return 1
}

require_command() {
  local label="$1"
  local candidate="$2"
  local resolved
  if ! resolved="$(resolve_command "$candidate")"; then
    printf 'Buildplane installer requires %s but could not resolve %s\n' "$label" "$candidate" >&2
    exit 1
  fi
  printf '%s\n' "$resolved"
}

NPM_BIN="$(require_command npm "${BUILDPLANE_INSTALL_NPM:-npm}")"
GIT_BIN="$(require_command git "${BUILDPLANE_INSTALL_GIT:-git}")"
INSTALL_SPEC="${BUILDPLANE_INSTALL_SPEC:-buildplane}"
INSTALL_PREFIX="${BUILDPLANE_INSTALL_PREFIX:-}"

if [ -n "$INSTALL_PREFIX" ]; then
  "$NPM_BIN" install -g --prefix "$INSTALL_PREFIX" "$INSTALL_SPEC"
  INSTALL_BIN_DIR="$INSTALL_PREFIX/bin"
  printf 'Buildplane installed into %s\n' "$INSTALL_PREFIX"
  printf 'Add Buildplane to PATH with:\n'
  printf '  export PATH="%s:$PATH"\n' "$INSTALL_BIN_DIR"
else
  "$NPM_BIN" install -g "$INSTALL_SPEC"
  printf 'Buildplane installed globally via npm\n'
fi

printf '\nNext steps:\n'
printf '  buildplane init\n'
printf '  buildplane run --packet /absolute/path/to/packet.json\n'
printf '  buildplane status --json\n'
printf '  buildplane inspect <run-id> --json\n'

# Keep a direct fail-fast check around the resolved git binary so the installer
# reports missing git before the first real Buildplane run.
"$GIT_BIN" --version >/dev/null 2>&1
