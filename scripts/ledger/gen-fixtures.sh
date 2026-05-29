#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/native/target/debug/bp-ledger-gen-fixtures"
OUT="$ROOT/packages/ledger-client/fixtures/payload-variants.json"

if [[ ! -x "$BIN" ]]; then
  cargo build --manifest-path "$ROOT/native/Cargo.toml" -p bp-ledger --bin bp-ledger-gen-fixtures --quiet
fi
"$BIN" "$OUT"
# Normalise indentation to match Biome project style (tabs).
"$ROOT/node_modules/.bin/biome" format --write "$OUT" 2>/dev/null || true

# M1-S7: signed-tape fixtures for the external verifier.
TAPE_BIN="$ROOT/native/target/debug/bp-ledger-gen-signed-tape"
TAPE_OUT="$ROOT/test/fixtures/signed-tape"
if [[ ! -x "$TAPE_BIN" ]]; then
  cargo build --manifest-path "$ROOT/native/Cargo.toml" -p bp-ledger --bin bp-ledger-gen-signed-tape --quiet
fi
"$TAPE_BIN" "$TAPE_OUT"
# Match Biome JSON style (tabs) so the committed fixtures pass `biome check`.
"$ROOT/node_modules/.bin/biome" format --write "$TAPE_OUT" 2>/dev/null || true
