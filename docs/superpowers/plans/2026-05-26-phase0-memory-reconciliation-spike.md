# Phase 0 — Memory Model Reconciliation Spike & Contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. NOTE: this is a research + design plan — its deliverables are an options report, an ADR, and a frozen interface contract, not shipped code. "Verification" steps check document completeness and symbol consistency, not test runs.

**Goal:** Decide whether Buildplane's auto-promoted `run_learnings` layer promotes into the curated structured layer (`repo_facts`/`procedures`) or stays a separate injected layer, and freeze a target port/schema contract that Phases 1–2 code against.

**Architecture:** A Sonnet researcher maps the two coexisting memory subsystems on `origin/main`; Opus decides direction and authors an ADR + a frozen interface contract referencing only verified existing symbols plus explicitly-marked additions; Codex CLI adversarially challenges the contract before an operator gate.

**Tech Stack:** TypeScript monorepo (`@buildplane/kernel`, `@buildplane/storage`), SQLite, markdown docs. Read-only against `origin/main`; no code shipped in this phase.

**Gating:** No Phase 1 dispatch until this plan's final gate passes. Per `docs/superpowers/specs/2026-05-26-memory-program-orchestration-design.md`.

---

## Ground-truth surface (verified 2026-05-26, origin/main)

The contract must reconcile these two existing surfaces — reference them exactly:

- **Learnings layer** — `BuildplaneMemoryPort` (`packages/kernel/src/ports.ts:241-266`): `writeLearnings`, `fetchLearnings`, `promoteLearnings`, `fetchLearningById`, `fetchLearningsByRunId`. Backed by `run_learnings` table + `learning-store.ts`. Scopes: `session|workspace|user|pack`. Produced by `extractLearnings()` (`outcome-extractor.ts`).
- **Structured layer** — `BuildplaneStoragePort` (`packages/kernel/src/ports.ts:90-150`): `upsertRepoFact`, `getRepoFact`, `listRepoFacts`, `retrieveRepoFacts`, `supersedeRepoFact`, `createProcedure`, `upsertProcedure`, `listProcedures`, `findProceduresByTaskType`, `retrieveProcedures`, `supersedeProcedure`, `createSearchableDocument`, `getSearchableDocument`, `listSearchableDocuments`, `searchSearchableDocuments`, `retrieveSearchableDocuments`, `recordInjectedMemories`, `listInjectedMemories`. Tables: `repo_facts`, `procedures`, `searchable_documents`(+`_fts`), `injected_memories`. Scopes: `global|organization|repo|branch|file-path|task-type|engine|workflow`.

---

## Task 1: Reconciliation research spike

**Files:**
- Create: `.hermes/reports/phase0-memory-reconciliation-spike.md` (researcher deliverable)

**Agent:** `claude-code-orchestration:researcher`, model `sonnet` (reasoning across sources, no writes → Sonnet per HARD CONTRACT).

- [ ] **Step 1: Dispatch the researcher with this exact prompt**

```
Read packages/kernel/src/{ports.ts,outcome-extractor.ts,memory-types.ts,
memory-retrieval.ts,run-loop.ts} and packages/storage/src/{learning-store.ts,
store.ts,event-store.ts} on origin/main. Two memory subsystems coexist:
(1) "learnings" — run_learnings table + BuildplaneMemoryPort write/fetch/promote,
    auto-extracted by extractLearnings(), scopes session|workspace|user|pack,
    seen-count promotion (session>=3->workspace, workspace>=5->user).
(2) "structured" — repo_facts/procedures/searchable_documents tables +
    BuildplaneStoragePort, curated exact-recall, scopes repo|branch|task-type|etc.

Produce a report with EXACTLY these sections:
A. Current-state map: what each layer stores, who writes it, who reads it
   (cite packet-enrichment.ts injection path + orchestrator.ts write path).
B. Overlap analysis: where do "learnings" and "facts/procedures" represent
   the same knowledge? Where are they genuinely distinct?
C. 2-3 reconciliation options, each with: data flow, retrieval surface,
   migration cost, and risk. At minimum cover:
   - "Promote": learnings are raw signal that graduate into repo_facts/
     procedures at a confidence/seen-count threshold; one curated read surface.
   - "Separate layers": learnings stay soft injected hints; structured stays
     exact curated truth; both injected, clearly scoped.
D. Recommendation with reasoning, and explicit impact on Phase-1 Tasks A
   (repo-fact seeding) and C (reviewer injection).
Keep under 800 words. Cite file:line. Do not write code or edit files.
```

- [ ] **Step 2: Verify the deliverable is complete**

Confirm `.hermes/reports/phase0-memory-reconciliation-spike.md` exists and contains all of sections A–D, at least 2 options in C, and an explicit Phase-1 A/C impact note in D. If any section is missing, re-dispatch with the gap named.

- [ ] **Step 3: Commit**

```bash
git add .hermes/reports/phase0-memory-reconciliation-spike.md
git commit -m "docs: phase-0 memory reconciliation spike report"
```

---

## Task 2: Decision + ADR

**Files:**
- Create: `docs/adr/0001-memory-model-reconciliation.md`

**Agent:** Opus (direct) — load-bearing decision.

- [ ] **Step 1: Decide the direction**

Read Task 1's report. Pick one option (or a justified hybrid). The decision answers one question: *do `run_learnings` promote into `repo_facts`/`procedures`, or stay separate injected layers?*

- [ ] **Step 2: Write the ADR with exactly these sections**

```markdown
# ADR 0001: Memory Model Reconciliation

## Status
Accepted (Phase 0 gate, 2026-05-26)

## Context
[Two coexisting layers; cite the spike report and ports.ts surfaces.]

## Decision
[Promote | Separate | Hybrid] — state the rule in one sentence, e.g.
"run_learnings of kind=fact/workflow promote into repo_facts/procedures at
seen_count>=N with confidence>=C; all other learnings remain session-scoped hints."

## Consequences
- Retrieval surface: [single curated | dual]
- Migration: [what changes in store.ts / ports.ts, if anything]
- Phase 1 impact: [how Task A seeding and Task C injection must behave]
- Phase 2 impact: [whether outcome_scores reads learnings, facts, or both]

## Rejected alternatives
[The non-chosen options and why.]
```

- [ ] **Step 3: Verify the ADR answers the question**

The Decision section must contain a single unambiguous rule (promote-with-threshold OR separate-with-injection-policy). No "TBD". Consequences must name concrete files.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0001-memory-model-reconciliation.md
git commit -m "docs: ADR 0001 memory model reconciliation decision"
```

---

## Task 3: Frozen port/schema contract

**Files:**
- Create: `docs/plans/phase1-memory-port-contract.md`

**Agent:** Opus (direct).

- [ ] **Step 1: Write the contract document**

Capture the target interface Phases 1–2 code against. Structure:

```markdown
# Phase 1 Memory Port Contract (frozen 2026-05-26)

## Unchanged (already on origin/main — DO NOT recreate)
[List the exact BuildplaneStoragePort + BuildplaneMemoryPort methods from the
ground-truth surface above that remain as-is.]

## Added by Phase 1
[Only NEW methods/fields, each marked NEW, with full TS signature. Example:
NEW seedRepoFactsFromInspection(repoId: string, signals: RepoInspectionSignals): RepoFact[]
— Task A. Every type referenced must either exist on origin/main or be defined here.]

## Behavioral rules (from ADR 0001)
[The promote-vs-separate rule, restated as constraints Task A seeding and Task C
injection must satisfy.]

## Off-limits
[What Phase 1 must NOT touch: existing table DDL, existing method signatures, etc.]
```

- [ ] **Step 2: Verify every referenced existing symbol is real**

For each method named under "Unchanged", confirm it exists:

Run: `git show origin/main:packages/kernel/src/ports.ts | grep -nE "<methodName>\("`
Expected: a line match for each. Any "Unchanged" symbol that does not match is a contract error — fix the contract.

- [ ] **Step 3: Verify no NEW symbol collides with an existing one**

Run: `git show origin/main:packages/kernel/src/ports.ts | grep -nE "<newMethodName>\("`
Expected: NO match for each NEW symbol (it must not already exist). A match means it is not new — move it to "Unchanged".

- [ ] **Step 4: Commit**

```bash
git add docs/plans/phase1-memory-port-contract.md
git commit -m "docs: freeze phase-1 memory port contract"
```

---

## Task 4: Adversarial challenge & gate

**Files:** none (review + checkpoint).

- [ ] **Step 1: Challenge the contract with Codex**

Run `/codex challenge` against `docs/adr/0001-memory-model-reconciliation.md` +
`docs/plans/phase1-memory-port-contract.md`. Prompt focus: "Does the promote/separate
rule create data duplication, stale-read, or scope-collision hazards? Does any NEW
method belong on the existing port or duplicate an existing one?"

- [ ] **Step 2: Resolve or accept each challenge finding**

For each finding: either amend the ADR/contract (re-commit) or record a one-line
rationale for accepting it in the ADR's Consequences section.

- [ ] **Step 3: Operator gate**

Present to the operator: the chosen reconciliation rule, the frozen contract's
NEW surface, and any accepted Codex findings. **Stop and wait for operator sign-off.**
Do not proceed to Phase 1 planning until confirmed.

- [ ] **Step 4: Record the gate result**

```bash
git commit --allow-empty -m "chore: phase-0 gate passed — memory contract frozen"
```

---

## Self-review checklist (run before execution)
- Spec coverage: Task 1 = spike, Task 2 = ADR, Task 3 = frozen contract, Task 4 = challenge+gate — matches the orchestration spec's Phase 0 steps 1–4.
- No placeholders: the one intentional `<methodName>` tokens in Task 3 verification are template slots filled at authoring time from the ground-truth list — not unresolved TODOs.
- Symbol consistency: all "Unchanged" references trace to `ports.ts:90-150` / `241-266` verified above.
