# Pack Show JSON Route Explanation Requirements

## Goal

Advance Phase 6 with the next smallest useful slice after the already-landed pack inspection UX: add machine-readable JSON output for native pack inspection so host/provider route selection is explicit, testable, and automatable.

## User story

As a Buildplane operator or integration author, I want `buildplane-native pack show <pack-id> --json` to return a structured route explanation, so I can inspect selected host/provider behavior without scraping terminal text.

## In scope

Keep this slice narrow and additive.

This slice must:
- add `--json` support to `buildplane-native pack show <pack-id>`
- preserve the existing human-readable `pack show` output unchanged
- return structured machine-readable data for pack metadata and route explanation
- include the current route-selection explanation data already implied by:
  - selected route
  - selection provenance
  - effective detected hosts
  - detection source
  - bridge-plan presence/absence
- add focused native tests for parser and JSON output behavior
- add a TypeScript CLI success-path test proving `buildplane pack show --json` delegates and preserves native JSON output

## Exact behavior

### Native CLI contract

`buildplane-native pack show <pack-id> --json` must:
- exit `0` on success
- print valid JSON to stdout
- accept the same existing inspection flags as human mode:
  - `--native-root <path>`
  - `--workspace-root <path>`
  - `--host <id>`
  - `--provider <id>`
  - `--detected-host <id>`
- reject unknown flags as before

### JSON payload

The JSON success payload must include enough structured information to explain route selection without terminal parsing. At minimum it must expose:
- pack metadata / loaded-pack context
- `workspaceRoot`
- `selection`
- `selectionReason`
- `effectiveDetectedHosts`
- `detectionSource`
- `hostRows`
- `bridgePlan`

The payload must make it easy to tell when:
- explicit provider beats a detected preferred host
- CLI `--detected-host` override changes the detection source
- a default provider fallback was used
- no bridge plan is produced because the selected route is not a detected host route

## Constraints

- Keep route precedence unchanged
- Keep host/provider detection logic unchanged
- Keep the human renderer unchanged unless a tiny shared-helper extraction is necessary
- Prefer deriving/serializing existing structs or adding a narrow DTO over broad architecture changes
- Keep this slice focused on pack inspection only

## Out of scope

- new pack commands such as `pack list` or `pack select`
- route-selection algorithm changes
- new host/provider integrations
- TS CLI behavior changes beyond success-path test coverage for delegated JSON output
- broader native migration work from Phase 6C

## Acceptance criteria

- `cargo run --manifest-path native/Cargo.toml -p bp-cli -- pack show superclaude --json` succeeds and prints valid JSON
- the JSON payload includes structured route-selection explanation fields
- the existing human `pack show` surface remains unchanged
- focused native tests cover parser + JSON explanation cases
- TypeScript CLI tests cover delegated `pack show --json` success-path passthrough
