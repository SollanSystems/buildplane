#!/usr/bin/env bash
# Regenerate TS types from bp-ledger Rust types via typeshare.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/packages/ledger-client/src/generated/index.ts"
RELEASE_EVALUATION_SHIM="$ROOT/packages/ledger-client/src/generated/release-evaluation-shim.ts.in"

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
# Typeshare cannot represent the ledger's deliberately untagged closed claim
# union. Its leaf structs/enums are generated from Rust; this generated-module
# shim supplies only the stable TypeScript union and its containing evidence
# record without changing the signed wire schema.
cat "$RELEASE_EVALUATION_SHIM" >> "$TMP"
mv "$TMP" "$OUT"

echo "wrote $OUT"

# Reformat the generated file to satisfy Biome's formatter rules.
biome format --write "$OUT" 2>/dev/null || true
