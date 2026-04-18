#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/native/target/debug/bp-ledger-gen-fixtures"
OUT="$ROOT/packages/ledger-client/fixtures/payload-variants.json"

if [[ ! -x "$BIN" ]]; then
  cargo build --manifest-path "$ROOT/native/Cargo.toml" -p bp-ledger --bin bp-ledger-gen-fixtures --quiet
fi
"$BIN" "$OUT"
