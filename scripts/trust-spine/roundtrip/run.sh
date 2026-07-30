#!/usr/bin/env bash
# Host-side driver for the first live promotion-decision authority round trip.
#
# Builds the harness image and runs the exchange in a throwaway rootful
# container. Artifacts land in .tmp/trust-spine-roundtrip/ (removed and
# recreated each run, so the harness is re-runnable from scratch and
# deterministic).
#
# Requires: rootful Docker (verified: 29.5.2, no sudo needed in this env).
# Podman is deliberately NOT used -- only the governed-session host calls OCI
# attestation, and this pair (promotion-decision) does not.
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
HARNESS_DIR="$REPO_ROOT/scripts/trust-spine/roundtrip"
OUT_DIR="$REPO_ROOT/.tmp/trust-spine-roundtrip"
IMAGE=bp-authority-roundtrip:local

fail() { echo "HARNESS-FAIL: $*" >&2; exit 1; }

for bin in buildplane-authority-host buildplane-authority-client buildplane-native; do
  [ -x "$REPO_ROOT/native/target/debug/$bin" ] || fail \
    "missing native/target/debug/$bin -- run: cargo build --manifest-path native/Cargo.toml -p bp-authority-broker --bins && pnpm native:build"
done

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "== build image =="
docker build -t "$IMAGE" -f "$HARNESS_DIR/Dockerfile" "$HARNESS_DIR" \
  || fail "docker build"

echo "== ABI probe (expect: invalid_arguments / exit 1) =="
# Cheapest possible discriminator between "the binary cannot load in this
# container" (dynamic-linker / exec-format error) and "the binary loaded and its
# argv guard fired". Isolates an ABI mismatch before any provisioning.
probe=$(docker run --rm -v "$REPO_ROOT:/repo:ro" "$IMAGE" \
  bash -c '/repo/native/target/debug/buildplane-authority-host x 2>&1; echo "exit=$?"')
echo "$probe"
grep -qx 'invalid_arguments' <<<"$probe" \
  || fail "host binary did not load in the container (glibc/ABI mismatch) -- add a build stage to the Dockerfile"
grep -qx 'exit=1' <<<"$probe" || fail "unexpected exit from the argv guard"

echo "== round trip =="
# No --privileged and no --user: CAP_CHOWN/CAP_SETUID/CAP_SETGID are in Docker's
# default set, and container root is required to create uid-0 trees, to be the
# listener creator, and to drop privileges before exec.
docker run --rm \
  -v "$REPO_ROOT:/repo:ro" \
  -v "$OUT_DIR:/out" \
  "$IMAGE"
rc=$?

echo "== artifacts in $OUT_DIR =="
ls -la "$OUT_DIR" || true
echo "== exit $rc =="
exit "$rc"
