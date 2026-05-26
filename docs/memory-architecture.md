# Buildplane Memory Architecture

> **Implementation status (origin/main, verified 2026-05-26):** This is the design
> record, and most of it is already shipped. Implemented: episodic event log
> (`events` table + `events.ts`/`event-store.ts`), semantic repo memory
> (`repo_facts` + `RepoFact` type + `*RepoFact` port methods), procedural memory
> (`procedures` + `ProcedureMemory` + `extractLearnings()`), exact-first retrieval
> (`memory-retrieval.ts`), FTS (`searchable_documents_fts`), provenance + scope +
> invalidation (status/supersede/`valid_*_commit`). **Not yet built:** outcome
> memory / scoring (layer 5 — no `outcome_scores` table), embeddings (V2/V3),
> Postgres/team mode (V2). See `docs/plans/v1-memory-implementation.md` for the
> ground-truth task mapping and remaining gaps.

## Goal

Buildplane's memory system should make the coding system more trustworthy, more repo-aware, and better over time.

The memory system must support:
- trusted issue-to-PR execution
- deterministic orchestration
- replay and recovery
- repo-specific adaptation
- procedural learning
- strategy improvement over time

## Design principles

1. Memory must be inspectable
2. Memory must have provenance
3. Memory must be scoped
4. Memory must decay or invalidate when stale
5. Exact retrieval should be preferred over fuzzy retrieval
6. Embeddings should support memory, not define it
7. The memory spine should be append-only and replayable

## The five memory layers

### 1. Working memory

Short-lived memory for the current run only.

Examples:
- current task
- current plan
- active worker context
- current failures
- current verification status

Properties:
- ephemeral
- in-memory or temporarily persisted state
- discarded or compacted after run completion

### 2. Episodic memory

Append-only history of what happened in prior runs.

Examples:
- run created
- repo inspected
- plan emitted
- worker started/completed
- diff captured
- tests run
- reviewer approved/rejected
- operator intervened
- recovery/replay occurred

Properties:
- canonical system of record
- append-only
- replayable
- durable
- tied to run IDs and timestamps

This is the memory spine.

### 3. Semantic repo memory

Stable facts about how a repo works.

Examples:
- preferred test, lint, typecheck, and build commands
- architecture boundaries
- folder ownership conventions
- dangerous paths
- branch naming rules
- definition-of-done requirements
- common failure modes
- preferred review expectations

Properties:
- typed
- structured
- repo-scoped
- versioned and invalidatable
- small and high-value

This is the operational memory layer used most often.

### 4. Procedural memory

Reusable workflows and playbooks extracted from successful runs.

Examples:
- how to add a schema migration in this repo
- how to release safely
- how to fix common CI failures
- how to update a package across a monorepo
- how to perform the preferred review pipeline

Properties:
- human-readable
- reusable across runs
- derived from evidence
- versioned and attributable

This is the compounding behavior layer.

### 5. Outcome memory

Statistical memory about what strategies work best.

Examples:
- which engine works best for bugfix tasks in this repo
- which planner pattern succeeds on refactors
- which verifier catches the most real issues
- which task types require more review
- which repair loops are worth retrying

Properties:
- aggregated
- scored
- repo-, task-, and engine-scoped
- used for routing and prioritization

This is the optimization layer.

## Retrieval model

### Retrieval rule

Use exact retrieval first, semantic retrieval second.

### Retrieval priority order

1. Current run state
2. Repo-scoped structured facts
3. Matching procedural skills and playbooks
4. Recent successful runs on similar task type
5. Outcome scores and routing hints
6. Semantic similarity over selected summaries and artifacts

### Why

Coding systems need exact commands, exact conventions, exact risk rules, and exact prior failures more often than they need approximate semantic recall.

## Provenance model

Every memory entry should include:
- `memory_id`
- `memory_type`
- `scope_type`
- `scope_key`
- `repo_id`
- `branch` or `commit_sha` if relevant
- `source_run_id`
- `source_task_id` if relevant
- `created_at`
- `updated_at`
- `created_by` (`worker`, `system`, or `operator`)
- `confidence`
- `status` (`active`, `stale`, `superseded`, `archived`)

If a memory cannot be traced back to its source, it should not influence trusted execution.

## Scope model

Supported scopes:
- global
- organization
- repo
- branch
- file path
- task type
- engine
- workflow

Examples:
- repo-scoped test command
- file-path-scoped risk warning
- engine-scoped success pattern
- task-type-scoped retry strategy

## Invalidation model

Memory becomes dangerous when stale.

Use these invalidation mechanisms:
- commit- or branch-based freshness
- explicit supersession
- TTL for weakly stable memories
- confidence downgrades after repeated contradiction
- manual operator invalidation

Examples:
- repo command memory invalidated after tooling migration
- procedural memory superseded by a newer successful playbook
- strategy score decays if recent runs fail

## Artifact strategy

Artifacts should live on disk or object storage and be referenced by memory records.

Examples:
- diff files
- execution logs
- test output
- review summaries
- generated plans
- patch sets

The memory database stores references and summaries, not giant blobs unless necessary.

## Recommended storage stack

### V1 local-first
- SQLite as the primary memory database
- FTS5 for exact and full-text recall
- filesystem artifacts for logs, diffs, and summaries
- typed tables plus JSON where useful

### V2 shared or team mode
- Postgres as the primary database
- optional pgvector for semantic retrieval
- object storage for artifacts
- the same logical model as SQLite

## Why not vector-only memory

A vector database alone is not sufficient because:
- provenance is weak
- retrieval is fuzzy
- staleness is easy to miss
- exact repo facts are more important than semantic similarity
- trusted execution needs deterministic inputs

Embeddings should be an add-on retrieval surface, not the memory backbone.

## Recommended implementation order

### V1
- episodic memory
- structured repo memory
- FTS retrieval
- artifact references

### V2
- procedural memory and skill extraction
- outcome memory and scoring
- routing hints

### V3
- semantic retrieval over selected summaries and artifacts
- team-shared memory
- smarter invalidation and promotion logic

## Memory contract

Buildplane should remember:
- what happened
- what is true about the repo
- what procedures work
- what strategies succeed

Buildplane should not rely on:
- raw transcripts alone
- opaque adaptive state
- vector similarity as primary truth

## Mapping to the implementation

`origin/main` already realizes this architecture in a TypeScript monorepo with a
kernel, storage layer, planner/implementer/reviewer loop, and PR handoff:

| Layer | Implemented as |
|---|---|
| Working memory | run-loop in-memory state (`run-loop.ts`) |
| Episodic memory | `events` table + `events.ts` / `event-store.ts` |
| Semantic repo memory | `repo_facts` table + `BuildplaneStoragePort.*RepoFact` |
| Procedural memory | `procedures` table + `extractLearnings()` (`outcome-extractor.ts`); run-derived `run_learnings` with seen-count promotion |
| Outcome memory | **not yet built** — no `outcome_scores` table |

Note: the run/task model uses `units` + `steps` + `runs` (not separate `repos` /
`tasks` tables). Two memory layers currently coexist — auto-promoted `run_learnings`
and curated structured `repo_facts`/`procedures`; their relationship is an open
reconciliation item in the V1 plan.

## One-line summary

Buildplane should use an event-sourced, scope-aware, inspectable memory system with episodic events as the spine, structured repo memory as the operational layer, procedural skills as the compounding layer, and embeddings only as a secondary retrieval tool.
