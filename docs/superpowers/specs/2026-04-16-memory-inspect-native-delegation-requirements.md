# Memory Inspect Native Delegation Requirements

## Goal

Advance Phase 6 with the next smallest useful slice after 6C3: expose the already-landed native advanced `memory inspect` contract through the umbrella `buildplane` CLI by delegating advanced `memory inspect` shapes to native while preserving the local TypeScript shortcut for exact learning-ID inspection.

## User story

As a Buildplane operator or automation client, I want `buildplane memory inspect --effective --json` and other advanced `memory inspect` forms to reach native inspection behavior, so the public CLI matches the documented memory contract and exposes the 6C1/6C2/6C3 native work instead of misrouting flags as learning IDs.

## In scope

Keep this slice narrow and TypeScript-only.

This slice must:
- change only the umbrella CLI routing for `buildplane memory inspect ...`
- preserve the existing local TypeScript shortcut for exact learning inspection:
  - `buildplane memory inspect <id>`
  - `buildplane memory inspect <id> --json`
- delegate advanced `memory inspect` invocations to native, including at minimum:
  - `buildplane memory inspect --effective --json`
  - flag-driven inspect forms such as `--scope`, `--pack`, `--session`, `--workspace-root`, or `--include-forgotten`
  - inspect forms that include extra flags beyond the exact local shortcut shape
- preserve native stdout/stderr/exit code exactly for delegated inspect invocations

## Exact behavior

### Local TypeScript shortcut remains narrow

Only these shapes should remain on the local TypeScript path:
- `buildplane memory inspect <id>`
- `buildplane memory inspect <id> --json`

These should continue to use the read-only learning store and produce the current local detail / JSON behavior.

### Advanced inspect shapes delegate to native

Any `buildplane memory inspect ...` invocation outside the exact shortcut above must dispatch to native with:
- `commandPath: ["memory"]`
- `argv` containing the original inspect subcommand and its arguments after `memory`

At minimum this includes:
- `buildplane memory inspect --effective --json`
- `buildplane memory inspect --pack superclaude --json`
- `buildplane memory inspect --scope workspace`
- `buildplane memory inspect <id> --include-forgotten`

### Public contract alignment

After this slice:
- the umbrella CLI must expose the same advanced `memory inspect` surface already documented in the architecture docs
- the umbrella CLI must no longer treat `--effective` or other advanced flags as learning IDs
- the native 6C3 JSON envelope for effective inspect must be reachable through `buildplane memory inspect --effective --json`

## Constraints

- TypeScript-only slice
- No native code or JSON schema changes
- No changes to `memory explain`, which already delegates correctly
- No changes to `memory list`
- No changes to storage, retrieval, ranking, or pack visibility semantics
- Keep the local learning-inspect fast path intact for the exact existing shortcut shape

## Out of scope

- native effective-memory behavior changes
- new memory commands
- help-text or architecture-doc rewrites beyond what is needed for tests or minimal wording cleanup
- broader TypeScript-to-native migration for all memory commands

## Acceptance criteria

- a focused CLI test proves `memory inspect --effective --json` delegates to native instead of entering the local learning-inspect path
- a focused CLI test proves delegated inspect preserves native JSON/stdout success output
- existing `memory inspect <id>` behavior remains green
- focused tests, lint, typecheck, and build all pass
