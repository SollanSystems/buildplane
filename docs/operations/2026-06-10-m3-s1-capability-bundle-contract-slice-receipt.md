# M3-S1 — capability bundle contract slice receipt

| | |
|---|---|
| **Status** | Implementation complete — pending PR |
| **Date** | 2026-06-10 |
| **Slice** | M3-S1 |
| **Base** | `origin/main` @ `33a23ff` |
| **Worktree** | `/mnt/c/Dev/projects/buildplane-m3-s1` |
| **Branch** | `feat/m3-s1-capability-broker` |

## Scope

New `@buildplane/capability-broker` package: `CapabilityBundleV0`, `parseCapabilityBundle`, `validateCapabilityBundle`, `bundleDigest` (delegates to `@buildplane/planforge` `digest`). No tool enforcement (S2), no kernel wiring (S3+).

## Verification

```bash
pnpm exec vitest run packages/capability-broker   # 16 passed
pnpm exec tsc --build packages/capability-broker/tsconfig.json --pretty false
```

## Golden digest vector

Bundle `GOLDEN_CAPABILITY_BUNDLE` in `packages/capability-broker/test/digest.test.ts`:

`sha256:c8f199e958714b3d7d7c3e7c5d9887e7658e2ccdaef7d632fe9b7543d59d3058`

## Next slice

M3-S2 — `evaluateToolInvocation` in `packages/capability-broker/src/evaluate.ts`.