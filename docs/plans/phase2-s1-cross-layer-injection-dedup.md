# Phase 2 · S1 — Cross-Layer Injection Dedup/Precedence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Deduplicate the injected memory packet across layers. At `packet-enrichment.ts:442–446` the three source arrays (run_learnings, structured, honcho) are concatenated with no cross-layer identity check. Add dedup by stable identity + a documented precedence order.

**Why:** per-table dedup (`dedupeRankedMemoryResults` at :300+) runs only *within* each structured sub-query; the same memory surfacing as both a run-learning and a structured fact is injected twice, wasting context and double-weighting it.

**Tech Stack:** TypeScript (ESM, `.js`), Node ≥24.13, vitest, `@buildplane/cli`.

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s1-cross-layer-injection-dedup`
- **Phase:** 2 · Track 1 — **lands LAST** (after S3, S2; both also touch `packet-enrichment.ts` in different regions). Rebase on S2.
- **Branch base:** cut worktree from `origin/main`. Last verified tip: `6391e17`.
- **Frozen contract excerpt** (authority: `docs/plans/phase2-memory-contract.md`):
  - Edit ONLY the assembly at `packet-enrichment.ts:442–446`. Dedup across run_learnings + structured + honcho by stable identity (`memory_id` where available; normalized display-text fallback) + a documented precedence.
  - No port change. No DDL change.
- **Off-limits:** `memory-retrieval.ts` ranking; the per-table `dedupeRankedMemoryResults`; the structured sub-query construction; `ports.ts`.
- **Merge eligibility:** single file (+test) → `buildplane:auto-merge`.
- **Verify command:** `pnpm -C <worktree> exec vitest run apps/cli/test/packet-enrichment.test.ts`. **Then the gate:** full suite + `pnpm -C <worktree> lint` + changeset.

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Read `packet-enrichment.ts:412–446`. Record exactly what identity each source carries: do `localLearnings` items expose a `memory_id` / source id, or only `kind/title/body` text? Do `structuredMemoryEnrichment.memories` items carry an id or only display text? This determines whether dedup keys on id or normalized text.
- [ ] **VF-2:** Finalize + document precedence. Proposal: `repo_facts ≻ procedures ≻ run_learnings ≻ honcho`; ties broken by confidence then recency. Confirm the data needed for tie-breaks is present; if not, fall back to source-order precedence and record the limitation.
- [ ] **VF-3:** Confirm no downstream consumer depends on duplicates or on the exact current ordering of `memories`.

## File Structure

- `apps/cli/src/packet-enrichment.ts` — **modify:** introduce a small pure `dedupeAcrossLayers(sources, precedence)` helper and apply it at the :442–446 assembly.
- `apps/cli/test/packet-enrichment.test.ts` — **modify/new:** unit tests for the helper + the assembly.

## Tasks (TDD)

- [ ] **T1 — pure dedup helper.** Failing test: given the same memory in two layers, the result contains it once, from the higher-precedence layer; distinct memories all survive; order is stable/deterministic.
- [ ] **T2 — wire into assembly.** Failing test: the assembled `memories` array at :442–446 has no cross-layer duplicates and respects precedence.

## Acceptance criteria

- A memory present in both run_learnings and structured appears once, higher-precedence wins; precedence documented in code.
- Distinct memories preserved; output deterministic.
- Only `packet-enrichment.ts` (+test) changed. Full suite + lint green; changeset added.
