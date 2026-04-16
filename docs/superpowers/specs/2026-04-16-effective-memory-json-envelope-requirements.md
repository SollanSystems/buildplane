# Effective Memory JSON Envelope Requirements

## Goal

Advance Phase 6 with the next smallest useful slice after 6C2: make native effective-memory JSON output self-describing by wrapping effective inspect/explain results in structured envelopes that include roots and the effective memory policy.

## User story

As a Buildplane operator or automation client, I want `memory inspect --effective --json` and `memory explain --effective --json` to report which roots and policy produced the results, so I can consume effective-memory data without guessing hidden command context.

## In scope

Keep this slice narrow and native-only.

This slice must:
- change JSON output for native effective-memory commands only:
  - `memory inspect --effective --json`
  - `memory explain --effective --json`
- keep human output unchanged
- keep filtering, ranking, and policy semantics unchanged
- include enough provenance in JSON output to explain the effective-memory result set

## Exact behavior

### Inspect effective JSON

`buildplane-native memory inspect --effective --json` must return a JSON object, not a bare array.

At minimum it must include:
- `nativeRoot`
- `workspaceRoot`
- `packId` when present
- `sessionId` when present
- `includeForgotten`
- `effectiveMemoryPolicy`
- `items`

### Explain effective JSON

`buildplane-native memory explain --effective --json` must return a JSON object, not a bare array.

At minimum it must include:
- `nativeRoot`
- `workspaceRoot`
- `packId` when present
- `sessionId` when present
- `includeForgotten`
- `effectiveMemoryPolicy`
- `explanations`

### Cross-surface agreement

The envelope’s `effectiveMemoryPolicy` must match the same pack-defined visibility already surfaced by:
- `pack show --json`
- native effective-memory execution semantics

## Constraints

- Native-only slice
- No changes to human memory output
- No changes to pack inspection output/schema in this slice
- No changes to storage or retrieval semantics
- Reuse the existing shared effective-memory policy seam from 6C1

## Out of scope

- new memory commands
- pack-show docs alignment
- TypeScript CLI changes
- new ranking or retrieval behavior

## Acceptance criteria

- inspect effective JSON returns a structured envelope with roots, policy, and items
- explain effective JSON returns a structured envelope with roots, policy, and explanations
- focused tests prove non-default pack visibility is reflected in both envelopes
- focused tests prove the reported roots match the actual roots used for execution
- `cargo test -p bp-cli`, lint, typecheck, and build all pass
