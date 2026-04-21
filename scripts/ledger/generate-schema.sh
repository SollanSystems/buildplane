#!/usr/bin/env bash
# Regenerate TS types from bp-ledger Rust types via typeshare.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/packages/ledger-client/src/generated/index.ts"

mkdir -p "$(dirname "$OUT")"

typeshare \
  --lang=typescript \
  --config-file="$ROOT/typeshare.toml" \
  --output-file="$OUT" \
  "$ROOT/native/crates/bp-ledger/src"

# Prepend shims/payload imports (sorted per Biome rules) so generated types can
# reference Uuid, DateTime, Payload, etc.
SHIMS_IMPORT='import type { Payload } from "../payload.js";
import type { BTreeMap, DateTime, Utc, Uuid, Value } from "../shims.js";'
TMP="$(mktemp)"
printf '%s\n' "$SHIMS_IMPORT" > "$TMP"
cat "$OUT" >> "$TMP"
mv "$TMP" "$OUT"

echo "wrote $OUT"

# Reformat the generated file to satisfy Biome's formatter rules.
biome format --write "$OUT" 2>/dev/null || true
