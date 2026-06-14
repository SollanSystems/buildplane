# M3-S3 — UnitPacket capability bundle attach slice receipt

| | |
|---|---|
| **Slice** | M3-S3 |
| **Branch** | `feat/m3-s3-packet-bundle-attach` |
| **Stacks** | M3-S1 + M3-S2 on same branch train |

## Scope

- `packages/planforge/src/bundle.ts` — default bundle from task side effects + verification commands
- `dispatchAdmittedPlan` attaches `capability_bundle` + `capability_bundle_digest`
- `UnitPacket` typed `CapabilityBundleV0`; `parseUnitPacket` validates bundle + digest
- CLI dispatch path unchanged (JSON packets now carry bundle fields)

## Verification

```bash
pnpm exec vitest run packages/planforge/test/bundle.test.ts packages/planforge/test/dispatch.test.ts packages/kernel/test/packet.test.ts packages/capability-broker
```

## Next

M3-S4 — adapters-tools enforces fs_write via broker.