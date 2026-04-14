# Memory Doctor Promotion Noise Checks — Design

**Date:** 2026-04-14
**Scope:** Phase 2 / Slice 2C — add memory doctor checks for duplication/noise

## Summary

The smallest useful Slice 2C is to extend the existing native `memory doctor` report so operators can see two promotion-specific problems:

1. orphaned promoted rows
2. duplicate promoted copies

This reuses the existing doctor command and existing persisted fields (`promoted_from_id`, scope, kind, title, body, tags, applicable packs, status`) without introducing new schema or repair flows.

## Why this slice

The roadmap names Slice 2C broadly as duplication/noise checks. The native CLI architecture already treats `memory doctor` as the operator-visible integrity command, and the native store already persists the exact promotion provenance required for a narrow first implementation.

This is the smallest high-value slice because it:
- improves operator trust right after promotion/lineage slices
- requires no new command or storage migration
- is deterministic and explainable
- stays safely report-only

## Proposed behavior

### 1. Orphaned promoted rows

A memory item is an orphaned promoted row when:
- `promoted_from_id` is non-empty
- and no item exists with that id in either database

Report these by promoted item id.

### 2. Duplicate promoted copies

A promoted item is a duplicate promoted copy when:
- it is an active promoted row (`promoted_from_id` present and `status = active`)
- and another active promoted row exists with the same canonical duplication key

### 3. Duplication key

For this slice, the duplication key should be a deterministic tuple of:
- `promoted_from_id`
- `scope`
- `scope_key`
- `kind`
- `title`
- `body`
- normalized `tags`
- normalized `applicable_packs`

All promoted rows in a group with cardinality greater than 1 are reported as duplicates.

This intentionally avoids broader heuristic similarity or hash-contract work.

## Report shape

Extend `MemoryDoctorReport` with:
- `orphan_promoted_item_ids: Vec<String>`
- `duplicate_promoted_item_ids: Vec<String>`

Keep existing fields unchanged.

## Rendering

Human `memory doctor` output should add lines such as:
- `- orphan promoted item ids: ...`
- `- duplicate promoted item ids: ...`

Use `none` when the new lists are empty, matching the current report style.

JSON output will automatically expose the new fields through existing serde serialization.

## Likely files

- `native/crates/bp-storage-sqlite/src/lib.rs`
- `native/crates/bp-cli/src/memory_cli.rs`

## Tests

### Storage tests

Add focused tests for:
- orphan promoted row detection
- duplicate active promoted copy detection
- duplicate groups do not flag non-promoted rows

### Native CLI tests

Add focused coverage that:
- `memory doctor --json` includes the new fields
- human `memory doctor` output renders the new summaries

## Non-goals

- FTS drift checks
- expiry-based doctor checks
- auto-remediation
- TS CLI changes beyond existing native delegation
- broad similarity/noise heuristics
