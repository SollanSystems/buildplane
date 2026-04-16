# Pack Show JSON Route Explanation Design

## Slice name

Phase 6 / Slice 6B1: native `pack show --json` route explanation seam

## Why this slice

The current repo already has the human-facing pack inspection UX that Phase 6A called for:
- native pack inspection exists
- route precedence is implemented and tested
- human terminal rendering explains the selected route and bridge plan

The smallest remaining gap is machine-readability.

Today:
- `buildplane-native pack show superclaude` works
- `buildplane-native pack show superclaude --json` fails with `unknown flag '--json'`

So the next smallest useful step is to expose the current route explanation structurally rather than inventing new inspection behavior.

## Architecture

### 1. Extend the native CLI parser with `--json`

Add a `json: bool` flag to native pack inspection args in `bp-cli`.

This should mirror the existing native memory command pattern:
- human mode prints the current rendered report
- JSON mode prints structured inspection data

### 2. Reuse the current inspection model

Prefer to reuse existing inspection data instead of re-deriving route logic.

Current reusable pieces already exist:
- `LoadedPack`
- `PackInspectionReport`
- `RuntimeSelection`
- `RuntimeSelectionProvenance`
- `HostStatus`
- `HostBridgePlan`

The main missing piece for parity with human output is a stable machine-readable `selectionReason` string. The narrowest approach is:
- move the current display-specific selection-reason logic into a shared helper owned by pack inspection
- let human rendering and JSON output both consume the same helper

### 3. Emit a narrow JSON DTO

Prefer one dedicated JSON payload struct for `pack show --json` rather than serializing unrelated internal-only shapes wholesale.

Recommended payload fields:
- `pack`
- `packRoot`
- `manifestPath`
- `workspaceRoot`
- `selection`
- `selectionReason`
- `effectiveDetectedHosts`
- `detectionSource`
- `hostRows`
- `bridgePlan`

This keeps the JSON surface explicit and future-friendly.

### 4. Keep the TypeScript CLI unchanged except for coverage

The main TypeScript CLI already delegates `pack show` to the native runner.

For this slice:
- keep `apps/cli/src/run-cli.ts` behavior unchanged if possible
- add a success-path test in `apps/cli/test/run-cli.test.ts` proving `pack show --json` preserves native stdout/stderr and exit code

## Likely files

### New
- `docs/superpowers/specs/2026-04-16-pack-show-json-route-explanation-requirements.md`
- `docs/superpowers/specs/2026-04-16-pack-show-json-route-explanation-design.md`
- `docs/superpowers/plans/2026-04-16-pack-show-json-route-explanation-tasks.md`

### Modified
- `native/crates/bp-cli/src/main.rs`
- `native/crates/bp-pack-inspection/src/lib.rs`
- `native/crates/bp-pack-loader/src/lib.rs` only if a derive/helper is needed
- `native/crates/bp-ui-terminal/src/lib.rs` only if selection-reason logic is shared
- `apps/cli/test/run-cli.test.ts`

## Verification set

Focused native tests:

```bash
. "$HOME/.cargo/env"
cargo test --manifest-path native/Cargo.toml -p bp-cli pack_show
cargo test --manifest-path native/Cargo.toml -p bp-pack-inspection
cargo test --manifest-path native/Cargo.toml -p bp-runtime
cargo test --manifest-path native/Cargo.toml -p bp-ui-terminal
```

Focused TypeScript tests:

```bash
npx vitest run apps/cli/test/run-cli.test.ts
```

Repo checks:

```bash
npx pnpm lint
npx pnpm typecheck
npx pnpm build
```

## Non-goals

- no new pack list/select UX yet
- no route precedence changes
- no new host/provider adapters
- no broad docs rewrite or Phase 6C native-boundary porting
