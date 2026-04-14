# Memory Doctor Promotion Noise Checks — Requirements

**Date:** 2026-04-14
**Scope:** Phase 2 / Slice 2C — add memory doctor checks for duplication/noise

## Goal

Make `buildplane memory doctor` detect the smallest high-value promotion integrity and noise issues already representable in the native memory store: orphaned promoted rows and duplicate promoted copies.

## Problem

Buildplane already supports `memory doctor`, but its current report only surfaces broad store health counts such as duplicate item ids, orphan events, orphan links, and forgotten-item counts. After promotion flows and promotion lineage work, the next operator-trust gap is more specific:

- promoted memory rows can point at missing source rows (`promoted_from_id` no longer resolves)
- repeated promotion of the same source content can create multiple active promoted copies that add noise without adding signal

These cases are not currently surfaced by `memory doctor` even though the store already persists the fields needed to detect them.

## In scope

- extend the native `memory doctor` report with promoted-row integrity/noise checks
- detect orphaned promoted rows where `promoted_from_id` references a missing source item
- detect duplicate promoted copies using deterministic grouping over identical promoted content
- surface the new report fields in both JSON and human CLI output
- add focused storage and native CLI tests

## Out of scope

- FTS synchronization checks
- expired session item checks
- generic hash-based duplicate detection for all memory rows
- auto-fix or prune behavior for promoted duplicates
- changes to the TypeScript CLI command routing
- broad memory doctor redesign

## Functional requirements

1. `memory doctor` must report promoted memory items whose `promoted_from_id` does not resolve to an existing source item.
2. `memory doctor` must report duplicate active promoted memory items that have the same promoted source and identical promoted content in the same target scope.
3. Duplicate detection must be deterministic and must not flag non-promoted rows.
4. The first duplication/noise slice may limit duplicate detection to active promoted rows only.
5. Human CLI output must summarize the new promoted-row doctor findings without changing the command surface.
6. JSON CLI output must expose the new promoted-row doctor fields with structured ids.
7. Existing doctor output fields and behavior must remain intact.

## Acceptance criteria

- `buildplane-native memory doctor --json` includes orphan-promoted and duplicate-promoted result fields
- human `buildplane-native memory doctor` output includes readable promoted-row health summaries
- storage-level tests prove orphan promoted rows are detected
- storage-level tests prove duplicate promoted copies are detected only for matching promoted groups
- native CLI tests prove the new doctor fields render in JSON and human modes
