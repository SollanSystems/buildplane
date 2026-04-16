# Pack Memory Visibility Boundary Requirements

## Goal

Advance Phase 6 with the next smallest justified native-boundary slice: extract the pack-defined memory visibility policy into a shared native seam and surface it consistently in pack inspection and effective-memory commands.

## User story

As a Buildplane operator, I want `pack show` and `memory ... --effective` to agree on which memory scopes a pack can see, so the native memory/runtime boundary is explicit, inspectable, and reusable instead of being hidden in a CLI-local helper.

## In scope

Keep this slice narrow and native-focused.

This slice must:
- extract the existing pack-manifest memory visibility mapping into a shared native helper/model
- reuse that shared helper/model in native effective-memory command paths
- surface the same pack-defined memory visibility policy in native pack inspection human output
- surface the same pack-defined memory visibility policy in native `pack show --json`
- add focused native tests proving `pack show` and `memory ... --effective` agree on the policy

## Exact behavior

### Shared policy seam

The shared seam must represent the pack-defined memory visibility boundary already implied by pack manifests. At minimum it must make visible whether a pack can read:
- user memory
- workspace memory
- pack memory
- session memory

The shared seam should be reusable by multiple native crates rather than staying embedded inside `bp-cli` command code.

### Pack inspection output

Native `pack show` must include a short human-readable memory visibility summary.

Native `pack show --json` must include a structured memory visibility / effective-memory policy field that matches the same underlying policy.

### Effective-memory commands

Native effective-memory commands must keep current behavior while obtaining the pack policy from the shared seam rather than a CLI-local helper.

## Constraints

- Keep the host/provider route logic unchanged
- Keep native memory storage semantics unchanged
- Do not port TS structured retrieval/injection in this slice
- Prefer extracting and reusing the already-stable pack-manifest memory-sharing boundary
- Keep the slice limited to native crates unless a tiny TS doc/test alignment is strictly necessary

## Out of scope

- TS packet-enrichment or structured retrieval migration
- native execution bridge expansion
- new pack selection commands
- provider/host routing changes
- published-package provisioning changes
- broad docs rewrite

## Acceptance criteria

- native `pack show` human output includes the pack memory visibility summary
- native `pack show --json` includes a structured memory visibility field
- native `memory inspect --effective` / `memory explain --effective` continue to honor the same pack visibility rules via the shared helper/model
- focused native tests prove the shared policy and output agreement
