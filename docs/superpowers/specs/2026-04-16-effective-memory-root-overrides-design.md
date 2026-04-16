# Effective Memory Root Override Design

## Slice name

Phase 6 / Slice 6C2: harden effective-memory root overrides

## Why this slice

Slice 6C1 extracted the pack-defined memory visibility boundary into a shared native seam.

The smallest remaining weakness is command-level reliability:
- effective-memory commands accept both `--native-root` and `--workspace-root`
- current parsing can reset `native_root` when `--workspace-root` appears after an explicit native root
- that breaks detached/external-workspace usage even though the shared pack policy seam is otherwise correct

This is the smallest useful next step because it:
- fixes a real operator-facing contract bug
- likely stays inside one file plus focused tests
- avoids widening into new features or additional native migrations

## Architecture

### 1. Preserve explicit native-root intent during parsing

The bug lives in native memory CLI argument parsing for:
- `parse_inspect(...)`
- `parse_explain(...)`

Current behavior resets `native_root` to `default_native_root_for_workspace(&workspace_root)` whenever `--workspace-root` is seen.

The narrow fix is:
- track whether `--native-root` was explicitly supplied
- only recompute the workspace-derived native root when `--workspace-root` changes and no explicit native root has been provided yet

This keeps the current defaulting behavior while making explicit native-root stable across flag orderings.

### 2. Add parser tests for both commands

Add focused parser tests for:
- inspect effective with `--native-root` before `--workspace-root`
- inspect effective with `--workspace-root` before `--native-root`
- explain effective with `--native-root` before `--workspace-root`
- explain effective with `--workspace-root` before `--native-root`

### 3. Add one execution-level regression

Use the existing temporary pack-manifest helper and effective-memory command path to prove:
- a non-default pack visibility policy still works when workspace root lives outside the native tree
- parsing through the real CLI parser keeps the explicit native root

Prefer one end-to-end regression rooted in `memory inspect --effective` because that is enough to prove the parser + execution contract; explain continues to share the same root override behavior and still gets explicit parser coverage.

## Likely files

### Modified
- `native/crates/bp-cli/src/memory_cli.rs`
- docs/specs/plans for this slice

## Verification set

Focused native tests:

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli
```

Repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

## Non-goals

- no changes to pack inspection JSON/human output
- no new shared policy types
- no changes to storage or runtime selection logic
- no TypeScript CLI changes
