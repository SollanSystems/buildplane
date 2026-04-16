# Effective Memory Root Override Requirements

## Goal

Advance Phase 6 with the next smallest follow-up after Slice 6C1: make native effective-memory commands honor an explicit `--native-root` even when `--workspace-root` is also provided, regardless of flag order.

## User story

As a Buildplane operator, I want `buildplane-native memory inspect --effective` and `memory explain --effective` to keep using the pack manifests from my explicitly provided native root while targeting a different workspace root, so pack-aware effective memory works in detached or external workspaces.

## In scope

Keep this slice narrowly focused on native memory CLI parsing and effective-memory execution.

This slice must:
- preserve an explicit `--native-root` for effective-memory commands even if `--workspace-root` appears later
- keep the same behavior when flags are supplied in the opposite order
- apply the same fix to both:
  - `memory inspect --effective`
  - `memory explain --effective`
- add focused parser tests proving both commands preserve the explicit native root across flag orderings
- add at least one execution-level regression test proving a non-default pack visibility policy still works when `--native-root` and `--workspace-root` target different roots

## Exact behavior

### Flag precedence

For native effective-memory commands:
- explicit `--native-root <path>` must always win
- `--workspace-root <path>` must update workspace context only
- changing `--workspace-root` must not silently reset `native_root` back to the workspace-derived default if the caller already supplied an explicit native root

### Command coverage

The fix must cover:
- `buildplane-native memory inspect --effective ...`
- `buildplane-native memory explain --effective ...`

### Regression coverage

The slice should prove a realistic detached-workspace scenario:
- native root contains a pack manifest with a non-default memory sharing policy
- workspace root is outside that native tree
- effective-memory execution still finds the pack manifest under the explicit native root
- the resulting effective-memory output matches the pack policy instead of failing with a pack-not-found error

## Constraints

- Keep this slice native-only unless a tiny test-only TypeScript alignment is strictly necessary
- Do not change the pack memory visibility policy itself
- Do not change pack inspection output or JSON schema in this slice
- Do not widen into new memory commands or route-selection behavior

## Out of scope

- new pack inspection features
- pack-show docs alignment work
- broader Phase 6C native migrations
- storage/schema changes

## Acceptance criteria

- explicit `--native-root` survives alongside `--workspace-root` in both inspect and explain effective-memory commands
- parser tests cover the relevant flag orderings
- execution-level regression proves detached workspace behavior works with a non-default pack visibility policy
- focused native tests pass
- repo lint/typecheck/build remain green
