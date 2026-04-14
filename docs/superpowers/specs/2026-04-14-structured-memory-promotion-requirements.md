# Structured Memory Promotion — Requirements

**Date:** 2026-04-14
**Scope:** Phase 2 / Slice 2A — promote selected run learnings into structured memory

## Goal

Turn high-value repeated workflow learnings into durable structured memory so future runs benefit from prior multi-round strategy behavior without relying only on ephemeral run learnings.

## Problem

Buildplane currently extracts run learnings into `run_learnings` and separately supports durable structured memory (`repo_facts`, `procedures`, `searchable_documents`). These systems do not yet reinforce each other. Valuable workflow lessons from multi-round strategy runs are not promoted into the structured retrieval path.

## In scope

- promote selected strategy-derived workflow learnings into durable structured memory
- limit the first slice to procedure promotion only
- keep promotion deterministic, inspectable, and idempotent
- write focused tests proving promotion and dedupe behavior

## Out of scope

- repo-fact promotion
- searchable-document promotion
- inspect/history lineage UI changes
- new storage schema for lineage links
- threshold-based promotion from generic `run_learnings` rows
- memory doctor / cleanup policies

## Functional requirements

1. Multi-round strategy runs may create at most one promoted structured-memory procedure per promoted implementer packet.
2. Promotion only occurs for workflow learnings derived from strategy runs with more than one round.
3. Promotion only occurs when the implementer packet exposes enough task intent to produce a useful procedure, especially `taskType`.
4. The promoted procedure must be workspace-scoped through the existing procedure storage path.
5. The promoted procedure must record provenance through existing fields:
   - `sourceRunId`
   - `createdBy: worker`
   - metadata describing the promotion rule and source learning
6. Promotion must be idempotent:
   - identical candidate -> no duplicate active procedure
   - changed canonical candidate -> supersede old active procedure and create a new one
7. Existing run-learning behavior must remain intact.

## Acceptance criteria

- a multi-round strategy run can promote a workflow learning into a procedure
- future retrieval can find the promoted procedure through the existing procedure path
- identical replays do not create duplicate active procedures
- changed procedure content supersedes the earlier version cleanly
- focused kernel/storage tests pass
