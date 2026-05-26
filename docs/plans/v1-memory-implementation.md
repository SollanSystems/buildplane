# Buildplane V1 Memory — Reconciliation & Gap-Closure Plan

> For Hermes: Do NOT build a memory system from scratch. The V1 memory spine
> is already implemented on `origin/main`. This plan verifies what exists and
> closes the small remaining gaps. Use subagent-driven-development only for the
> open tasks at the bottom.

**Status:** The original 13-task "build V1 memory" plan is obsolete. A read of
`origin/main` (2026-05-25) shows the episodic + repo-fact + procedure +
searchable-document + retrieval + injection + invalidation layers are already
shipped. This document records ground truth and reduces the work to the actual
remaining gaps.

**Base branch warning:** Local `main` is ~70 commits behind `origin/main` and is a
minimal prototype snapshot. All real package code lives on `origin/main`. Cut any
implementation branch from `origin/main`, never from local `main` or
`docs/memory-system-foundation`.

---

## Ground truth — what already exists on `origin/main`

| Original task | Concept | Already implemented as |
|---|---|---|
| 1 | Memory domain types | `packages/kernel/src/memory-types.ts` — `MemoryType`, `MemoryScopeType`, `MemoryStatus`, `MemoryProvenance`, `RepoFact`, `ProcedureMemory`, `SearchableDocument`, `UpsertRepoFactInput`, `CreateProcedureInput`, `CreateSearchableDocumentInput`. Exported via `kernel/src/index.ts`. |
| 2 | Storage schema | `packages/storage/src/store.ts` creates `repo_facts`, `procedures`, `searchable_documents`, `injected_memories`, `run_learnings`, **and** `searchable_documents_fts` (FTS5). Migration/`ALTER` logic + `assertTableColumns` guards present. |
| 3 | Episodic memory | `packages/kernel/src/events.ts` (`RunCreated/Started/Completed`, `ToolCall*`, `CommandExecutionComplete`, `EvidenceRecorded`…) + `packages/storage/src/event-store.ts`. Event log is the canonical episodic stream. |
| 4 | Repo fact API | `BuildplaneStoragePort` (`kernel/src/ports.ts`): `upsertRepoFact`, `getRepoFact`, `listRepoFacts`, `retrieveRepoFacts`, `supersedeRepoFact`. |
| 6 | Procedure API | `BuildplaneStoragePort`: `createProcedure`, `upsertProcedure`, `listProcedures`, `findProceduresByTaskType`, `retrieveProcedures`, `supersedeProcedure`. |
| 7 | Extraction from runs | `packages/kernel/src/outcome-extractor.ts` → `extractLearnings()` (pure). Emits `ExtractedLearning[]` (kinds: fact/decision/constraint/preference/workflow/provider_heuristic). |
| 8 | Exact + scoped retrieval | `packages/kernel/src/memory-retrieval.ts` — exact→fuzzy→full-text precedence, scope-preference, confidence, recency tiebreak (`rankMemoryResults`, `compareRankedMemoryResults`, `dedupeRankedMemoryResults`). Storage-backed `retrieve*` methods on the port. |
| 9 | Searchable docs + FTS | `searchable_documents` + `searchable_documents_fts` (fts5, `content=searchable_documents`); port methods `createSearchableDocument`, `getSearchableDocument`, `listSearchableDocuments`, `searchSearchableDocuments`, `retrieveSearchableDocuments`. |
| 10/11 | Feed memory into planner/reviewer | `orchestrator.ts` wires `memoryPort` (opt 89/103); `writeLearnings`+`promoteLearnings` on rejected (830–842) and completed (918–930) runs and strategy runs (1539). Fetch-and-inject lives in `apps/cli/src/packet-enrichment.ts`; injected records persisted via `recordInjectedMemories`/`listInjectedMemories`; surfaced as `InjectedMemoryRecord`/`PersistedInjectedMemoryRecord`/`PromotedStructuredMemoryRecord` in `run-loop.ts`. |
| 13 | Invalidation/supersession | `MemoryStatus` = `active|stale|superseded|archived`; `supersedeRepoFact`/`supersedeProcedure`; `repo_facts.valid_from_commit`/`valid_to_commit`/`branch`/`commit_sha` columns; learning promotion thresholds (session≥3→workspace, workspace≥5→user) in `learning-store.ts`. |

**The original plan's 5 phantom file targets do not exist** and should never be
referenced again: `inspect-repo.ts`, `repo-profile.ts`, `final-summary.ts`,
`plan-task.ts`, `review-task.ts`. Planning/review/extraction live in
`run-loop.ts`, `orchestrator.ts`, `strategy-executor.ts`, and `outcome-extractor.ts`.

---

## Two coexisting memory models — reconcile before extending

`origin/main` carries **two** memory layers that overlap conceptually:

1. **Learnings** — `run_learnings` table + `BuildplaneMemoryPort` (`writeLearnings`/
   `fetchLearnings`/`promoteLearnings`) + `extractLearnings()`. Scope model:
   `session|workspace|user|pack`. This is the *run-derived, auto-promoted* layer.
2. **Structured memory** — `repo_facts` / `procedures` / `searchable_documents`
   tables + the `BuildplaneStoragePort` `*RepoFact`/`*Procedure`/`*SearchableDocument`
   methods. Scope model: `global|organization|repo|branch|file-path|task-type|engine|workflow`.
   This is the *curated, exact-recall* layer.

These were built incrementally and are **not yet explicitly related**. Before any
new memory work, decide and document (in `docs/memory-architecture.md`):
- Is "learnings" the episodic-summary feed that *promotes into* structured
  `repo_facts`/`procedures`, or are they permanently separate layers?
- Which layer does `packet-enrichment.ts` inject into prompts today, and should
  both be injected?

This is a **design decision for the operator**, not a Hermes build task.

---

## Verification checklist (do this first — read-only)

Run from a worktree cut off `origin/main`:

1. `pnpm -w build && pnpm -w test` green, especially `packages/storage/test/*` and
   `test/event-stream/*`.
2. Confirm the memory tables initialize: inspect a fresh state DB for `repo_facts`,
   `procedures`, `searchable_documents`, `searchable_documents_fts`, `run_learnings`,
   `injected_memories`.
3. Confirm round-trip: a run produces `run_learnings` rows (`extractLearnings` →
   `writeLearnings`) and `injected_memories` rows on the *next* run.
4. Confirm exact-before-fuzzy retrieval ordering via existing
   `memory-retrieval` tests.

If all four pass, V1 memory is functionally complete and only the open tasks below remain.

---

## Open tasks (the real remaining gaps)

### Task A — Repo-fact seeding from repo inspection
**Objective:** Ensure first-touch repo inspection durably writes `repo_facts`
(build/test commands, conventions) so later runs reuse them.

**Reality check first:** `apps/cli/src/packet-enrichment.ts` and
`apps/cli/src/workflow-scan.ts` + `packages/policy/src/profiles.ts` already derive
repo signals. Determine whether any path calls `upsertRepoFact`. If yes, this task
is verification-only.

**If a gap exists:**
- Modify: `apps/cli/src/packet-enrichment.ts` (or the inspection entrypoint that owns repo profiling)
- Add a step that maps detected commands/conventions → `upsertRepoFact` with
  `scopeType: "repo"` and commit provenance.
- Test: extend the relevant `apps/cli/test/*` to assert facts are written on inspection.

**Acceptance:** inspecting a repo yields durable `repo_facts`; a second run reads them back.

### Task B — User-facing memory inspection command
**Objective:** Let an operator inspect what Buildplane knows.

**Reality check first:** `inspectTarget`/`InspectSnapshot` exist and `run-cli.ts`
already emits memory output (138 memory references). Confirm whether a discrete
`bp memory` / `bp learnings` subcommand exists.

**If a gap exists:**
- Create: `apps/cli/src/memory-cli.ts` (subcommands: `facts`, `procedures`, `learnings`, `episodes`)
- Modify: `apps/cli/src/cli-main.ts` to register the command
- Reuse `formatters.ts` for output; reuse port `listRepoFacts`/`listProcedures`/`fetchLearnings`/event queries.
- Test: `apps/cli/test/memory-cli.test.ts`.

**Acceptance:** `bp memory facts|procedures|learnings|episodes` prints human-readable, attributable output.

### Task C — Reviewer-side injection coverage
**Objective:** Confirm (and if missing, add) memory injection into the *reviewer*
prompt, not only the planner/implementer.

**Reality check first:** `packet-enrichment.ts` injects memory into packets; verify
reviewer packets receive the same enrichment (definition-of-done facts, risk facts,
review conventions). The write/promote path on reviewer rejection already exists
(orchestrator.ts:830).

**If a gap exists:**
- Modify: `apps/cli/src/packet-enrichment.ts` and/or `packages/kernel/src/run-loop.ts`
  to enrich reviewer packets with scoped repo facts/procedures.
- Test: extend reviewer-flow coverage.

**Acceptance:** reviewer packets carry scoped memory; review is stricter on repeated tasks.

---

## What NOT to do

- Do **not** create `memory-types.ts` or `memory-retrieval.ts` — they exist and are exported.
- Do **not** create new `repo_facts`/`procedures`/`searchable_documents` tables — `store.ts` owns them.
- Do **not** add a second FTS index — `searchable_documents_fts` exists.
- Do **not** reference `inspect-repo.ts`, `repo-profile.ts`, `final-summary.ts`,
  `plan-task.ts`, or `review-task.ts` — they do not exist.
- Do **not** branch from local `main` — it is 70 commits stale.
