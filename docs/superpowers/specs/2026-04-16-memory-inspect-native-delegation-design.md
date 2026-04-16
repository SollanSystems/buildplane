# Memory Inspect Native Delegation Design

## Slice name

Phase 6 / Slice 6C4: expose advanced `memory inspect` through the umbrella CLI

## Why this slice

After 6C1, 6C2, and 6C3:
- native effective-memory inspection uses the shared pack visibility seam
- explicit native/workspace roots are handled correctly
- native effective inspect/explain JSON is now self-describing

The smallest remaining public-contract gap is routing in the TypeScript umbrella CLI:
- `memory explain --effective` already reaches native
- but `memory inspect --effective` is intercepted by the local TypeScript `memory inspect <id>` shortcut
- the current TS path can misread `--effective` and other advanced flags as learning IDs, hiding the native Phase 6 contract behind the umbrella CLI

This follow-up is smaller than any further native work because it only corrects one TS dispatch seam.

## Architecture

### 1. Narrow the local `memory inspect` shortcut to an exact shape

In `apps/cli/src/run-cli.ts`, keep the local TypeScript path only for the exact existing learning shortcut:
- one non-flag positional learning id
- optional `--json`
- no other flags or extra arguments

A small helper or inline classifier is acceptable as long as the rule is explicit and testable.

### 2. Delegate all other inspect forms to native

If `memory inspect` does not match the exact local shortcut above, dispatch to native using the existing memory delegation path:
- `commandPath: ["memory"]`
- `argv: ["inspect", ...subRest]`

This must preserve native stdout/stderr/exit code exactly, the same way `pack show` and the generic memory fallthrough already do.

### 3. Keep `memory explain` and `memory list` unchanged

Do not widen the slice into other memory subcommands.
- `memory explain` already delegates to native
- `memory list` remains the current local TypeScript shortcut

### 4. Test the routing boundary directly

Add focused CLI tests that prove:
- `memory inspect --effective --json` delegates to native
- delegated inspect preserves native JSON output without TS rewriting it
- exact `memory inspect <id>` behavior still works locally

## Likely files

### Modified
- `apps/cli/src/run-cli.ts`
- `apps/cli/test/run-cli.test.ts`
- planning docs for this slice

## Verification set

Focused CLI tests:

```bash
npx pnpm vitest run apps/cli/test/run-cli.test.ts
```

Repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

## Non-goals

- no native crate changes
- no JSON envelope changes
- no `memory explain` routing changes
- no `memory list` redesign
- no broader docs rewrite
