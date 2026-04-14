# Injection Provenance Surface — Requirements

**Date:** 2026-04-14
**Scope:** Phase 1 / Slice 1D — operator-visible injection reasons

## Goal

Let operators see which structured memories were injected into a run and why, in both run-time CLI output and later inspect/history surfaces.

## Problem

Today memory injection is transient. `enrichPacketWithMemories()` decides what to inject, but that decision is not persisted, so later operator surfaces cannot explain what structured memory influenced the run.

## In scope

- persist structured-memory injection provenance for each run
- expose that provenance in `buildplane run` result output when available
- expose that provenance in `buildplane inspect <run-id>` and JSON output
- keep the surface provider-neutral and independent of renderer internals
- include enough data to explain both what was injected and why it matched

## Out of scope

- new memory ranking algorithms
- changing packet-renderer prompt sections
- promotion/forget/search memory commands
- semantic/vector retrieval changes
- TUI/operator console enhancements beyond the existing text CLI surfaces

## Functional requirements

1. Each run must be able to persist zero or more injected structured-memory records.
2. An injection record must capture at minimum:
   - run id
   - memory kind (`repo-fact`, `procedure`, `searchable-document`, later extensible)
   - memory id
   - display text injected into the prompt
   - match reason (`exact-*`, `fuzzy-*`, `full-text-*`)
   - optional scope preference index when applicable
3. `buildplane run` human output should show a compact injected-memory summary when records exist.
4. `buildplane inspect <run-id>` human output should show a detailed injected-memory section.
5. JSON inspect/run surfaces should include structured injection provenance arrays.
6. Runs with no injected structured memories must remain backward-compatible and quiet.
7. Existing history/status behavior must remain stable unless explicitly expanded by this slice.

## Acceptance criteria

- injection provenance is stored durably in `.buildplane/state.db`
- operator can inspect a completed run and see what structured memories were injected and why
- human CLI output remains concise but informative
- JSON surfaces expose machine-readable provenance records
- focused tests cover persistence, inspect output, and backward-compat/no-record paths
