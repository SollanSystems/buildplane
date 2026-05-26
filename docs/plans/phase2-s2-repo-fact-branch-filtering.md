# Phase 2 · S2 — repo_facts Branch-Scoped Filtering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]` checkboxes.

**Goal:** Stop cross-branch `repo_facts` leakage. Add an optional `branch?` to `RepoFactRetrievalQuery`, thread it through `retrieveRepoFacts` → the store read helpers, and have packet-enrichment pass the run's current branch. Filter: `branch = ? OR branch IS NULL` (null-branch = repo-global, always matches). **No DDL change.**

**Why:** `readRepoFactRows`/exact/fuzzy return all active facts regardless of `branch`, so a fact promoted on another branch leaks into unrelated runs. (ADR 0001 deferred this to Phase 2; Codex R1 proved commit-ancestry validity is Phase-3-sized — Phase 2 does **branch-only**.)

**Tech Stack:** TypeScript (ESM, `.js`), Node ≥24.13, vitest, `@buildplane/kernel`, `@buildplane/storage`.

## Opus Planning Reference (handoff contract)

- **Slice ID:** `phase2-s2-repo-fact-branch-filtering`
- **Phase:** 2 · Track 1 — **lands SECOND** (after S3; rebase on S3's `store.ts` edit). Does **NOT** touch `ports.ts`.
- **Branch base:** cut worktree from `origin/main`. Last verified tip: `6391e17`.
- **Frozen contract excerpt** (authority: `docs/plans/phase2-memory-contract.md`):
  - ADD `branch?: string` to `RepoFactRetrievalQuery` (`packages/kernel/src/memory-retrieval.ts:27`); omitted ⇒ no filtering (today's behavior — additive/opt-in).
  - Thread `branch` through `retrieveRepoFacts` → store read helpers (`readRepoFactRows :1081`, exact `:1448`, fuzzy `:1481`). SQL clause: `(branch = ? OR branch IS NULL)`.
  - `packet-enrichment.ts` local port type (`:26`) + call site (`:302`) pass the run's current branch.
- **Off-limits:** `memory-retrieval.ts` **ranking algorithm** (adding the `branch` query field is allowed; changing scoring is NOT); `valid_from_commit`/`valid_to_commit` (Phase 3); table DDL; `ports.ts`.
- **Merge eligibility:** touches `memory-retrieval.ts` + `store.ts` + `packet-enrichment.ts` (no port signature) → `buildplane:auto-merge`; shares `store.ts` with S3 (different methods) — rebase on S3.
- **Verify command:** `pnpm -C <worktree> exec vitest run packages/kernel/test packages/storage/test apps/cli/test/packet-enrichment.test.ts`. **Then the gate:** full suite + `pnpm -C <worktree> lint` + changeset.

## Verify-first (BEFORE implementation)

- [ ] **VF-1:** Confirm `branch` is populated on promoted facts (`run-cli.ts:1826`) and on inspection-seeded facts (Phase-1 Task A) — and what value (short name vs ref). Record the canonical form so the query matches.
- [ ] **VF-2:** Confirm null-`branch` rows mean repo-global and SHOULD always match. Confirm no active code relies on cross-branch facts being returned (search callers of `retrieveRepoFacts`).
- [ ] **VF-3:** Confirm the run's **current branch is available** at `packet-enrichment.ts:302` (from provenance / a git adapter / the packet). If not directly available, identify the nearest source and record it — do NOT shell out to git on the hot path if a stored value exists.

## File Structure

- `packages/kernel/src/memory-retrieval.ts` — **modify:** add `branch?` to `RepoFactRetrievalQuery`; pass to the store in `retrieveRepoFacts`. (Ranking untouched.)
- `packages/storage/src/store.ts` — **modify:** `readRepoFactRows`/exact/fuzzy accept `branch?` and add the `(branch = ? OR branch IS NULL)` clause.
- `apps/cli/src/packet-enrichment.ts` — **modify:** local port type `:26` + pass current branch at `:302`.
- tests: `packages/storage/test`, `packages/kernel/test`, `apps/cli/test/packet-enrichment.test.ts`.

## Tasks (TDD)

- [ ] **T1 — store filter.** Failing test: a fact with `branch="feat/x"` is NOT returned when querying `branch="main"`; a `branch=NULL` fact IS returned for any branch; omitting `branch` returns everything (unchanged). Implement the SQL clause in all three readers.
- [ ] **T2 — thread the query type.** Failing test: `retrieveRepoFacts({ ..., branch })` forwards the filter. Add `branch?` to `RepoFactRetrievalQuery`.
- [ ] **T3 — caller passes branch.** Failing test: packet-enrichment retrieval is invoked with the run's current branch; explicit absence ⇒ unfiltered.

## Acceptance criteria

- Cross-branch facts excluded; null-branch (repo-global) included; omitting `branch` = today's behavior.
- `valid_*_commit` untouched; ranking algorithm untouched; `ports.ts` untouched.
- Full suite + lint green; changeset added.
