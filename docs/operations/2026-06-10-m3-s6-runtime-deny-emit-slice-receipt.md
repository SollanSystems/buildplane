# M3-S6 slice receipt — runtime broker deny + tape emit hook

**Date:** 2026-06-10  
**Branch:** `feat/m3-s3-packet-bundle-attach` (PR train #187)  
**Review:** L1 — Codex if ledger subprocess paths touched.

## Scope

- `write_file` / tool registry `onCapabilityDenied` callback
- `emitCapabilityDenied` CLI helper → `capability_denied` tape event
- `run-cli` threads emitter + run id + bundle digest from packet

## Verification (executed)

```bash
pnpm exec vitest run packages/adapters-tools apps/cli/test/ledger-capability-denied.test.ts
```

## Acceptance

- Denied broker write does not create file; callback fires with tool/target.
- When tape context + digest present, CLI emits `capability_denied` on deny.