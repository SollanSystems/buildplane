# M3-S4 — adapters-tools fs_write broker enforcement slice receipt

| | |
|---|---|
| **Slice** | M3-S4 |
| **Branch** | `feat/m3-s3-packet-bundle-attach` (train with S1–S3) |

## Scope

- `writeFile` calls `evaluateToolInvocation` when `capabilityBundle` is set
- `createToolRegistry(worktreeRoot, { capabilityBundle })` forwards bundle to writes
- `run-cli` passes `packet.capability_bundle` into registry on command/fork paths

## Verification

```bash
pnpm exec vitest run packages/adapters-tools
```

## Next

M3-S5 — L0 `capability_denied` tape event.