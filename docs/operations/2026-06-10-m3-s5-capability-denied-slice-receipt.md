# M3-S5 slice receipt — `capability_denied` L0 tape vocabulary

**Date:** 2026-06-10  
**Branch:** `feat/m3-s3-packet-bundle-attach` (PR train #187)  
**Review:** L0 — requires Opus + adversarial Codex before merge; not auto-merge eligible.

## Scope

- Rust `EventKind::CapabilityDenied` / `CapabilityDeniedV1` payload
- Canonicalize + replay no-op transition
- Signed append integration test
- typeshare regen + fixture drift (21 variants)

## Verification (executed)

```bash
cargo test --manifest-path native/Cargo.toml
pnpm ledger:gen && pnpm ledger:gen-fixtures
pnpm exec vitest run packages/ledger-client/test/payload-drift.test.ts
```

## Notes

- Replay treats `capability_denied` as observability-only (no state mutation).
- S6 wires runtime emit on broker deny via CLI tool registry hook.