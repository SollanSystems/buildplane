# Structured Memory Retrieval Ranking — Design Spec

**Date:** 2026-04-13
**Scope:** Phase 1 / Slice 1A — retrieval interfaces + ranking contract
**Goal:** Define the TypeScript retrieval contract that can surface repo facts, procedures, and searchable documents in deterministic, explainable priority order before any packet-injection work lands.

## Problem

Buildplane now has durable structured memory primitives, but the read path is fragmented:
- repo facts support exact single-scope lookup and listing
- procedures support task-type filtering only
- searchable documents support listing plus raw FTS search

There is no shared retrieval contract for "what should this run see?" and no ranking surface that explains why one memory outranked another. That blocks packet enrichment and operator trust.

## Non-goals

- No packet enrichment changes yet
- No CLI formatter or inspect-surface work yet
- No semantic/vector retrieval
- No schema migration beyond what the existing storage layer already supports

## Design

### 1. Kernel-owned retrieval contract

Create `packages/kernel/src/memory-retrieval.ts` with:
- query types for repo-fact, procedure, and searchable-document retrieval
- a ranked result/read-model shape
- named match reasons (`exact-*`, `fuzzy-*`, `full-text-*`)
- a deterministic comparator and ranking helper

The ranking contract should be explainable from data already available in storage:
1. match class / reason
2. caller-supplied scope order when applicable
3. confidence
4. updated-at recency
5. stable ID tie-break

Exact matches must always outrank fuzzy/full-text fallbacks.

### 2. Repo fact retrieval

Add a ranked repo-fact retrieval method to the storage port.

Query shape:
- optional exact `factKey`
- optional fuzzy `searchText`
- optional ordered scope candidates (`branch`, `repo`, `global`, etc.)
- optional `limit`

Behavior:
- exact fact-key matches search across the provided scope candidates
- fuzzy fallback searches `fact_key` and serialized `fact_value_json`
- exact matches win over fuzzy matches even when fuzzy rows have higher confidence or are newer
- within exact matches, earlier scope candidates win

### 3. Procedure retrieval

Add a ranked procedure retrieval method to the storage port.

Query shape:
- optional exact `taskType`
- optional exact `name`
- optional fuzzy `searchText`
- optional `limit`

Behavior:
- exact `taskType` / exact `name` matches are ranked ahead of fuzzy text matches in name/body
- duplicate rows matched by multiple rules are deduplicated, keeping the best-ranked explanation

### 4. Searchable document retrieval

Add a ranked searchable-document retrieval method to the storage port.

Query shape:
- optional exact `title`
- optional exact `sourceTable + sourceId`
- optional full-text `searchText`
- optional `documentKind`
- optional `limit`

Behavior:
- exact source/title filters rank ahead of FTS fallback
- FTS remains the fallback path, not the primary path
- duplicate rows matched by exact and FTS paths are deduplicated in favor of the exact explanation

### 5. Why this slice is enough

This slice gives later work a stable read model and ranking contract without coupling it to prompt formatting yet. Slice 1B can consume the ranked results for packet enrichment; Slice 1D can render the same explanations for operators.

## Files expected

- Create: `packages/kernel/src/memory-retrieval.ts`
- Modify: `packages/kernel/src/ports.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/index.d.ts`
- Modify: `packages/storage/src/store.ts`
- Test: `packages/kernel/test/memory-retrieval.test.ts`
- Test: `packages/storage/test/repo-facts.test.ts`
- Test: `packages/storage/test/procedures.test.ts`
- Test: `packages/storage/test/searchable-documents.test.ts`

## Acceptance criteria

- ranked retrieval interfaces exist for repo facts, procedures, and searchable documents
- result objects explain why each item matched
- exact matches outrank fuzzy/full-text fallback results
- scope ordering is deterministic for repo facts
- focused tests prove ordering and dedup behavior
