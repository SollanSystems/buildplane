# Structured Memory Injection — Design

**Date:** 2026-04-13
**Scope:** Phase 1 / Slice 1B — repo fact + procedure injection

## Problem

Slice 1A added ranked retrieval contracts, but packet enrichment still only injects ephemeral run learnings and optional Honcho context. Durable repo facts and procedures do not yet influence runs.

## Design summary

Keep `TaskIntent.context.memories` as the single provider-neutral injection surface. Extend packet enrichment so it can read:

- local run learnings
- ranked repo facts
- ranked procedures
- Honcho memories

Structured memories are selected with deterministic retrieval inputs derived from the task intent and are formatted into concise plain strings before they are appended to the existing memory list.

## Retrieval strategy

### 1. Scope candidates for repo facts

Build repo-fact scope candidates in this order:

1. current branch, if known
2. each file path from `intent.context.files`
3. task type from `intent.taskType`
4. repo
5. global

This keeps retrieval deterministic and allows narrower scoped facts to outrank broader defaults.

### 2. Search terms

Build a stable list of search terms from:

- task objective keywords
- task type
- referenced file paths and basenames
- verification command keywords

Normalize by trimming, lowercasing for dedup, preserving first-seen order, and dropping empty terms.

### 3. Procedure retrieval

For each selected term, call `retrieveProcedures({ taskType, searchText, ... })` and merge results. The exact `taskType` parameter gives deterministic exact-first ranking while the term provides fuzzy narrowing.

### 4. Repo-fact retrieval

For each selected term, call `retrieveRepoFacts({ searchText, scopeCandidates, ... })` and merge results. This lets slice 1B reuse Slice 1A ranking behavior without inventing new storage APIs.

## Formatting

Keep formatting provider-neutral by converting structured memories to plain strings inside packet enrichment:

- repo fact: `[repo-fact] <factKey>: <rendered value>`
- procedure: `[procedure] <name>: <summary>`

Formatting rules:

- stringify JSON values compactly
- collapse multiline procedure markdown into a short first-line summary
- keep strings concise and deterministic

## Ordering

Final memory order:

1. local run learnings
2. structured repo facts
3. structured procedures
4. Honcho memories

Rationale:

- preserve the current flywheel behavior first
- inject durable workspace memory before user/remote context
- keep the previous Honcho behavior intact

## File-level changes

- `apps/cli/src/packet-enrichment.ts`
  - add a structured-memory port interface
  - derive search terms and scope candidates
  - retrieve, dedupe, limit, and format repo facts/procedures
  - preserve existing learning + Honcho paths
- `apps/cli/test/packet-enrichment.test.ts`
  - add red/green tests for structured injection and mixed-source ordering
- `apps/cli/src/run-cli.ts`
  - construct a structured-memory storage port when `.buildplane/state.db` exists
  - resolve current branch best-effort and pass it to packet enrichment
- `apps/cli/src/demo.ts`
  - update enrichment calls to the new signature
- `eval/runner.ts`
  - update enrichment call types/signature if needed

## Non-goals for this slice

- no renderer changes
- no searchable-document injection
- no inspect/history surface for match reasons
- no new kernel/storage contracts unless implementation uncovers a real gap
