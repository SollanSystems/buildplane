# Promotion Lineage in Inspect Output — Requirements

**Date:** 2026-04-14
**Scope:** Phase 2 / Slice 2B — explain promotion lineage in inspect output

## Goal

Make Buildplane inspect surfaces explain when a run promoted durable structured memory so operators can connect a run's workflow learning to the resulting structured procedure record.

## Problem

Slice 2A promotes selected multi-round strategy workflow learnings into durable procedure memory, but operators still cannot see that promotion lineage through normal `inspect` output. The provenance exists in storage (`sourceRunId`, `sourceTaskId`, promotion metadata), but it is not surfaced in run/unit inspect output.

## In scope

- surface durable promotion lineage in `inspect` output for runs and units
- keep the first lineage slice limited to promoted procedure memory
- expose lineage in both human and JSON inspect surfaces
- preserve status so superseded promoted procedures remain inspectable
- write focused tests for storage, formatter, and CLI inspect behavior

## Out of scope

- repo-fact promotion lineage
- searchable-document promotion lineage
- new memory UI/TUI panels
- operator approval workflow
- memory-doctor duplication/noise checks
- broad memory-inspect redesign

## Functional requirements

1. Inspecting a run must surface structured memories promoted from that run.
2. Inspecting a unit must surface structured memories promoted from the latest inspected run for that unit.
3. The first lineage slice only needs to surface promoted procedures created by Slice 2A.
4. Promotion lineage must be available in JSON inspect output with structured fields.
5. Human inspect output must summarize promoted procedures with enough lineage detail to explain why the promotion exists.
6. Superseded promoted procedures must remain visible in inspect lineage so provenance does not disappear after later replacements.
7. Existing injected-memory and run-learning inspect behavior must remain intact.

## Acceptance criteria

- `buildplane inspect <run-id>` shows promoted procedure lineage for a run that triggered Slice 2A promotion
- `buildplane inspect <unit-id>` shows the same lineage via the latest run for that unit
- JSON inspect output includes promoted lineage records with status, promotion rule, and source task provenance
- superseded promoted procedures remain visible in lineage output
- focused tests pass
