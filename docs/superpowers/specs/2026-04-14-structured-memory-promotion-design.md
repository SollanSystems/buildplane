# Structured Memory Promotion — Design

**Date:** 2026-04-14
**Scope:** Phase 2 / Slice 2A — promote selected run learnings into structured memory

## Summary

The smallest useful Phase 2 slice is to promote multi-round strategy workflow learnings into a canonical workspace procedure. This uses the existing procedure retrieval/injection path and avoids widening into lineage surfaces or broad learning-threshold heuristics.

## Why procedures first

Procedure memory is already:
- durable
- explainable
- ranked and retrievable
- injected into packet enrichment today

A successful multi-round strategy run is effectively evidence that a reusable workflow helped. That maps cleanly to a procedure record, while repo facts and searchable documents would require looser heuristics.

## Proposed behavior

### 1. Promotion trigger

After `runStrategy(...)` completes:
- if the strategy had `rounds.length > 1`
- and the strategy produced a workflow learning
- and the implementer packet has usable intent/task type

then Buildplane derives one promoted procedure candidate for the implementer packet.

### 2. Candidate shape

Create a canonical procedure from the implementer packet + workflow learning:
- `name`: stable canonical name derived from strategy mode + task type
- `taskType`: implementer intent task type
- `bodyMarkdown`: workflow guidance derived from the extracted learning body
- `metadata`:
  - `promotionRule: "multi-round-strategy-workflow->procedure"`
  - `strategyMode`
  - `sourceLearningTitle`
  - `sourceLearningKind`
  - `sourceStrategyId`

### 3. Dedupe and supersede policy

Before creating the promoted procedure:
- list active procedures for the same `taskType`
- find an existing active procedure with the same canonical `name`
- if no match: create new
- if same canonical `name` and same `bodyMarkdown`: no-op
- if same canonical `name` but changed body: supersede existing active procedure and create new

This keeps the slice deterministic and avoids accumulating prompt noise.

### 4. Placement

Keep the slice small by implementing promotion in the orchestrator strategy post-run hook, where Buildplane already:
- computes strategy-level learnings
- has access to `storage`
- has access to the full `StrategyPacket`
- has access to `strategyResult`

No new storage schema is required for Slice 2A.

## Likely files

- `packages/kernel/src/orchestrator.ts`
- `packages/kernel/test/orchestrator-memory.test.ts`
- `packages/kernel/test/outcome-extractor.test.ts` (only if learning extraction tests need minor expansion)
- `packages/storage/test/procedures.test.ts` (only if helper behavior needs storage-level assertions)

## Key risks

1. Generic `run_learnings` dedupe is too coarse for broad threshold-driven structured promotion.
2. Procedure promotion can create prompt noise if the canonical name/body is too generic.
3. Strategy hooks must use the real implementer packet intent, not synthetic fallback packet data.

## Non-goals for this slice

- human/UI lineage rendering
- `run_learnings` schema changes
- promotion of fact/constraint/provider heuristics into repo facts
- searchable-document archival of strategy summaries
