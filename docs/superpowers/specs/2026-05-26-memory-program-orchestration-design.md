# Buildplane Memory Program — Agent Orchestration Design

**Date:** 2026-05-26
**Status:** Approved (brainstorming) — pending Phase-0 execution
**Author:** Opus (planning lane)

## Context

The Buildplane V1 memory spine is already implemented on `origin/main`: episodic
event log (`events`), structured memory (`repo_facts`, `procedures`,
`searchable_documents` + `searchable_documents_fts`), the full `BuildplaneStoragePort`
retrieval surface, `extractLearnings()` run-derived learnings (`run_learnings` with
session→workspace→user promotion), memory injection into runs (`injected_memories`,
`packet-enrichment.ts`), and status/supersession invalidation. Verified
2026-05-26. See `docs/plans/v1-memory-implementation.md` for the task→code mapping.

This document does **not** design the memory system — it designs how agents are
deployed to finish the *remaining* memory program. Local `main` is ~70 commits
behind `origin/main`; all execution branches off `origin/main`.

## Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Scope | Full remaining program: reconcile → V1 gaps → outcome-memory → (embeddings/team mode parked) |
| Substrate | Hybrid — Opus/Claude plans & reviews; Hermes Codex kanban workers execute |
| Parallelism | Phased parallel — serialize the gating front, fan out independent gaps, regroup |
| Planning granularity | Plan-per-slice (bounded 1–3h slices, each = one Hermes task with an Opus Planning Reference header) |
| Phase 3 (embeddings/team) | Parked — re-scope after Phase 2 ships |
| Phase-1 shared port | Opus pre-declares the port surface in the Phase-0 contract; Tasks A & C edit against a frozen interface and stay parallel |

## Agent roster

**Planning & governance lane — Claude Code (interactive session)**

| Agent | Model | Job |
|---|---|---|
| Opus (direct) | Opus | Milestone+slice planning, Phase-0 ADR decision, Opus Planning Reference headers, high-risk review at phase gates |
| `claude-code-orchestration:researcher` | Sonnet | Phase-0 spike: map `run_learnings` ↔ structured surface, draft reconciliation options + citations |
| `claude-code-orchestration:reviewer` | Sonnet | Read-only severity-tagged review at each slice boundary before merge |
| `Explore` | Haiku | Read-only "where is X / does Y exist" lookups during planning |

**Execution lane — Hermes kanban (Codex-backed)**

| Profile | Model | Job |
|---|---|---|
| kanban-triage | qwen3.6-flash | Decompose each Opus slice-plan into board tasks |
| kanban-impl | Codex gpt-5.5 | Write code in buildplane worktrees cut from `origin/main` |
| kanban-review | (review profile) | Worker-side review + receipt generation |

**Adversarial (selective) — Codex CLI**
- `/codex challenge`, invoked by Opus **only** on the two correctness-critical
  surfaces: the Phase-0 reconciliation contract and the Phase-2 scoring math.

Division of labor invariant: Opus never writes production code (Hermes does);
Hermes never makes the load-bearing model decision (Opus does in Phase 0); Sonnet
covers the reasoning-but-not-writing middle (research, review).

## Phase decomposition & dependencies

```
Phase 0 — RECONCILIATION SPIKE + ADR        [GATING · serial]
   └─ resolves: do run_learnings PROMOTE INTO repo_facts/procedures,
      or stay separate injected layers? Output = ADR + target port/schema
      contract + updated memory-architecture.md.
        │
        ▼
Phase 1 — V1 GAP CLOSURE                     [parallel fan-out · 3 lanes]
   ├─ Task A: repo-fact seeding from inspection (packet-enrichment)
   ├─ Task B: `bp memory` inspection CLI (memory-cli.ts + cli-main)
   └─ Task C: reviewer-side memory injection (packet-enrichment/run-loop)
        │   (each verify-first: confirm gap is real before building)
        ▼
Phase 2 — OUTCOME MEMORY (layer 5)           [serial after P1 · 1-2 lanes]
   └─ outcome_scores table + scoring aggregation + routing hints.
        │
        ▼
Phase 3 — EMBEDDINGS + TEAM MODE (V2/V3)     [PARKED]
```

Phase 0 is the only true gate — it rewrites the schema/port surface that all later
phases touch. Phase-1 tasks are mutually independent (separate files) and fan out.
Phase 2 needs the reconciled retrieval surface. Phase 3 is re-scoped after Phase 2.

## Per-phase orchestration

### Phase 0 — Reconciliation (serial, gating)
1. Opus dispatches researcher (Sonnet): map the two memory models, return 2–3
   reconciliation options with tradeoffs and citations.
2. Opus decides direction; authors the ADR, updates `memory-architecture.md`, and
   writes the **target port/schema contract** later phases code against.
3. Opus runs `/codex challenge` on the contract.
4. **GATE:** Opus sign-off + operator confirmation. Artifact = ADR + frozen contract.

### Phase 1 — V1 gaps (3 parallel Hermes lanes)
1. Opus writes 3 slice-plans (A/B/C), each with a verify-first step and Opus
   Planning Reference header referencing the frozen port surface.
2. kanban-triage decomposes each → 3 lanes of kanban-impl (Codex) in separate
   worktrees off `origin/main`.
3. Per lane: verify gap is real → TDD → green tests + receipt → kanban-review →
   reviewer (Sonnet) cross-check.
4. Merge policy: narrow + green → Mergify `buildplane:auto-merge`; anything
   touching the shared port → manual Opus review.
5. **GATE:** all three merged, main green.

### Phase 2 — Outcome memory (serial, 1–2 lanes)
1. Opus slice-plan: `outcome_scores` schema → aggregation → routing-hint
   consumption (sequential; schema gates aggregation gates routing).
2. kanban-impl executes; Opus runs `/codex challenge` on the scoring math;
   reviewer (Sonnet) + Opus review.
3. **GATE:** Opus sign-off.

### Phase 3 — parked.

## Handoff contract (Opus Planning Reference header)

Each Hermes task carries:
- Slice ID + phase + the frozen port/schema contract excerpt it codes against
- Exact target files (origin/main-verified paths — no phantom files)
- Verify-first step → TDD expectations → acceptance criteria + one-line verify command
- Merge eligibility: `buildplane:auto-merge` (narrow+green) vs manual Opus review (shared port)
- Branch base: `origin/main` (hard invariant)

## Artifacts

| Artifact | Location |
|---|---|
| This orchestration design | `docs/superpowers/specs/2026-05-26-memory-program-orchestration-design.md` |
| Phase-0 reconciliation ADR | `docs/adr/` |
| Per-phase slice plans | `docs/plans/` |
| Hermes receipts | `.hermes/reports/` |
| Living updates | `memory-architecture.md`, `v1-memory-implementation.md` |

## Gates & invariants

- Every worktree cut from `origin/main` — never stale local `main`.
- One receipt per slice.
- Trust-surface slices never auto-merge.
- Phase boundaries are hard gates: no Phase N+1 dispatch until N's gate passes,
  with operator sign-off reported at each gate.

## Kickoff sequence

1. Write + commit this spec.
2. `writing-plans` → produce the Phase-0 spike plan as the first executable plan.
3. Dispatch researcher (Sonnet) for the reconciliation spike.
4. Report spike findings + recommended reconciliation direction at the Phase-0 gate.

## Deferred to Phase 0 (not decided here)

The actual reconciliation content — whether `run_learnings` promote into structured
`repo_facts`/`procedures` or remain separate injected layers — is intentionally a
Phase-0 output, not a brainstorming decision. The spike informs it; Opus decides;
the operator confirms at the gate.
