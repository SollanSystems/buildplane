# Buildplane Autonomous Build-Out Plan

> **Superseded 2026-05-21.** This plan predates the v0.5 design and the auto-merge governance work landed in PRs #112–#115. The canonical operating model for the M0–M6 buildout is now [`docs/architecture/buildplane-agent-operating-system.md`](../../architecture/buildplane-agent-operating-system.md). Use that doc for agent roles, model routing, PR/auto-merge policy, and phase-by-phase scope. The roadmap below is retained for lineage and the Phase 1 (structured memory retrieval) acceptance criteria, but is no longer the authoritative cadence.
>
> **For agentic workers:** REQUIRED SUB-SKILLS: use `writing-plans` before large new slices, `subagent-driven-development` for implementation, and `systematic-debugging` for any failure. Keep work PR-sized. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Buildplane from the current green mainline into the operator-first, self-improving coding system for Claude Code CLI and Codex CLI.

**Architecture:** Keep the shipping path TypeScript-first until the product contracts are stable. The deterministic kernel, evidence-first execution, worktree isolation, structured memory, and operator trust surface remain the center of gravity. Rust/native hardening is a later, selective move for clearly justified host/runtime/storage boundaries.

**Tech Stack:** TypeScript, pnpm workspaces, SQLite (`node:sqlite`), Vitest, Biome, git worktrees, GitHub Actions, optional Rust native crates later.

---

## Verified starting point

- `main` is green on GitHub.
- PR #25 (`feat: add V1 memory storage foundations`) is merged.
- Clean canonical local worktree:
  - `/mnt/c/Dev/projects/buildplane-memory-mainline-clean`
- Local clean mainline verification succeeded:
  - `npx pnpm install --frozen-lockfile`
  - `npx pnpm typecheck`
  - `npx pnpm build`
- M1 foundations are real: init/run/status/inspect, SQLite state, policy, evidence, worktree isolation, repo-dev bootstrap, published bootstrap verification.
- Strategy elevation exists: `buildplane run` defaults to implement-then-review unless `--raw` is used.
- TaskIntent + renderer layer exists (M9).
- Memory flywheel pieces exist (M10 track): extractor/governance, eval harness, inspect surfaces.
- Structured V1 memory foundations now exist on main:
  - repo facts
  - procedures
  - searchable documents

---

## Non-negotiable guardrails for autonomous workers

- [ ] Always branch from `main`, never from an old replay or backup branch.
- [ ] Use the clean canonical worktree unless CI parity requires an ext4 worktree under `/tmp`.
- [ ] Never modify these preserved backup branches/worktrees unless explicitly told:
  - `backup/feat-memory-scaffold-mainline-dirty-20260413-200045`
  - `docs/memory-system-foundation`
  - `feat/memory-scaffold`
  - `backup/archive-*`
- [ ] Keep `core.filemode=false` in the repo to avoid `/mnt/c` executable-bit noise.
- [ ] Use `npx pnpm ...` instead of assuming `pnpm` is on PATH.
- [ ] Treat `scripts/published-bootstrap/verify-positive.mjs` as side-effecting. Run it only in a disposable ext4 validation worktree.
- [ ] Prefer exact-first retrieval before semantic/heuristic retrieval.
- [ ] One autonomous cycle should land one focused, reviewable slice.
- [ ] Before opening a PR, run at minimum:
  - targeted Vitest for touched areas
  - `npx pnpm typecheck`
  - `npx pnpm build`
- [ ] If GitHub Actions disagrees with `/mnt/c`, reproduce on ext4 early.
- [ ] If three fix attempts fail, stop and write an architecture note instead of thrashing.

---

## Autonomous loop contract

Every autonomous cycle should follow this exact loop:

- [ ] **Step 1: Refresh mainline context**
  - `git fetch origin --prune`
  - verify current worktree is clean and on `main`
  - inspect current open PRs and recent runs

- [ ] **Step 2: Choose the next smallest high-leverage slice**
  - use the roadmap priority below
  - prefer slices that improve the default user experience, memory usefulness, or operator trust
  - avoid starting a large umbrella refactor when a smaller proof slice is available

- [ ] **Step 3: Write or update a focused design + implementation plan**
  - design spec under `docs/superpowers/specs/`
  - implementation plan under `docs/superpowers/plans/`
  - the slice plan must be specific enough for subagents to execute without guessing

- [ ] **Step 4: Implement with subagents**
  - fresh subagent per task
  - spec compliance review first
  - code quality review second

- [ ] **Step 5: Verify locally**
  - targeted tests for touched files
  - `npx pnpm typecheck`
  - `npx pnpm build`
  - if CI-sensitive: reproduce in ext4 worktree

- [ ] **Step 6: Publish the slice**
  - create focused branch
  - commit cleanly
  - push
  - open draft PR
  - monitor checks, fix until green

- [ ] **Step 7: Merge and retarget**
  - squash merge
  - retarget clean worktree to updated `main`
  - prune disposable worktrees safely

---

## Roadmap priority

## Phase 1 — Structured memory retrieval and injection (highest priority)

**Why first:** PR #25 gave Buildplane durable structured memory primitives. The next highest-leverage gap is making those primitives actually influence runs.

**Outcome:** `buildplane run` becomes smarter because repo facts, procedures, and searchable documents are retrieved and injected into intent/context before execution.

**Acceptance criteria:**
- exact-first structured retrieval exists for repo facts, procedures, and searchable documents
- retrieval is scope-aware and deterministic
- packet enrichment can inject structured memories, not only flywheel learnings
- operator can see what structured memories were injected and why
- tests prove retrieval ordering and injection behavior

**Likely files:**
- Create: `packages/kernel/src/memory-retrieval.ts`
- Modify: `packages/kernel/src/ports.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/storage/src/store.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `apps/cli/src/packet-enrichment.ts`
- Modify: `apps/cli/src/formatters.ts`
- Modify: `apps/cli/src/run-cli.ts`
- Test: `packages/storage/test/*.test.ts`
- Test: `packages/kernel/test/*.test.ts`
- Test: `apps/cli/test/*.test.ts`

### Suggested slices for Phase 1

- [ ] **Slice 1A: retrieval interfaces + ranking contract**
  - define a read model that returns structured memories in explainable priority order
  - prove exact-match wins over fuzzy match

- [ ] **Slice 1B: repo fact + procedure injection**
  - enrich TaskIntent with top-ranked repo facts/procedures
  - keep formatting provider-neutral

- [ ] **Slice 1C: searchable document lookup**
  - add exact-title/source filters first
  - add FTS-backed fallback second

- [ ] **Slice 1D: operator-visible injection reasons**
  - show which structured memories were surfaced during run/inspect output

---

## Phase 2 — Converge flywheel learnings and structured memory

**Why second:** the system currently has both run-learnings and structured memory foundations. The next product win is making them reinforce each other instead of existing as parallel tracks.

**Outcome:** repeated run outcomes promote into durable structured memory where appropriate, while ephemeral/session learnings remain narrow.

**Acceptance criteria:**
- clear policy for when a run learning becomes a repo fact, procedure, or searchable document
- provenance links remain inspectable
- workspace/user/pack/session boundaries stay explicit
- dedup/promotion rules avoid prompt noise

**Likely files:**
- Modify: `packages/kernel/src/outcome-extractor.ts`
- Modify: `packages/storage/src/learning-store.ts`
- Modify: `packages/storage/src/store.ts`
- Modify: `apps/cli/src/packet-enrichment.ts`
- Modify: `docs/architecture/buildplane-memory-schema.md`
- Modify: `docs/architecture/buildplane-memory-cli.md`

### Suggested slices for Phase 2

- [ ] **Slice 2A: promote selected run learnings into structured memory**
- [ ] **Slice 2B: explain promotion lineage in inspect output**
- [ ] **Slice 2C: add memory doctor checks for duplication/noise**

---

## Phase 3 — Operator trust surface

**Why third:** Buildplane will not become the default workflow unless operators can see what happened, what was learned, and how to recover.

**Outcome:** the text CLI and TUI make autonomous work inspectable, replayable, and calm to supervise.

**Acceptance criteria:**
- history / inspect / replay surfaces clearly show outcomes, evidence, learnings, and workspaces
- retained failed workspaces are easy to understand and recover from
- TUI is useful for live runs, not just a stub
- memory and strategy behavior are visible without opening SQLite manually

**Likely files:**
- Modify: `apps/cli/src/run-cli.ts`
- Modify: `apps/cli/src/formatters.ts`
- Modify: `packages/ui-tui/src/*`
- Modify: `packages/storage/src/store.ts`
- Test: CLI and TUI contracts

### Suggested slices for Phase 3

- [ ] **Slice 3A: enrich inspect/history for strategies and memory provenance**
- [ ] **Slice 3B: retained-workspace recovery/status commands**
- [ ] **Slice 3C: turn TUI into a real operator console**

---

## Phase 4 — Workflow import and operator bootstrap outside the repo

**Why fourth:** once the system is demonstrably smarter and trustworthy, reduce the habit/anxiety tax so users choose it over manual prompt glue.

**Outcome:** a user can install Buildplane, import existing Claude Code / Codex habits, and run it without monorepo knowledge.

**Acceptance criteria:**
- published bootstrap contract is solid and locally reproducible
- zero/low-friction install path exists
- Buildplane can scan/import existing workflow conventions from Claude/Codex setups
- repo-local and published paths remain clearly separated

**Likely files:**
- `apps/cli/package.json`
- `scripts/published-bootstrap/*`
- install/bootstrap docs
- import helpers under CLI or adapters

### Suggested slices for Phase 4

- [ ] **Slice 4A: workflow import for Claude Code / Codex configs**
- [ ] **Slice 4B: one-line installer / published CLI hardening**
- [ ] **Slice 4C: bootstrap doctor for host/tool prerequisites**

---

## Phase 5 — Evaluation and proof of superiority

**Why fifth:** Buildplane's claims should be measured, not narrated.

**Outcome:** Buildplane has repeatable evidence that memory and strategy improve outcomes compared with raw agent usage.

**Acceptance criteria:**
- eval harness covers local fixtures and model-backed fixtures
- memory-injected rate and memory-helped rate are tracked
- at least one "no human intervention" success metric exists
- benchmark reports are easy to compare across changes

**Likely files:**
- `eval/runner.ts`
- `eval/report.ts`
- `eval/suites/*`
- CI workflow additions for eval later

### Suggested slices for Phase 5

- [ ] **Slice 5A: expand eval harness to model-backed fixtures**
- [ ] **Slice 5B: add raw-agent comparison suites**
- [ ] **Slice 5C: publish benchmark summary in repo docs**

---

## Phase 6 — Pack/host/provider hardening and selective native migration

**Why last:** this is the architecture-hardening phase, not the first product-discovery phase.

**Outcome:** Buildplane stays the umbrella system while packs/hosts/providers become explicit, inspectable layers. Rust/native hardens only the pieces that benefit materially.

**Acceptance criteria:**
- pack selection and inspection are first-class
- host/provider routing is explicit and testable
- TS contracts are stable before native migration
- native work is limited to clearly justified surfaces

**Likely files:**
- `native/crates/*`
- `native/packs/*`
- `docs/architecture/buildplane-package-architecture.md`
- `docs/architecture/rust-native-host-runtime.md`

### Suggested slices for Phase 6

- [ ] **Slice 6A: pack selection + inspection UX**
- [ ] **Slice 6B: host/provider route explanation**
- [ ] **Slice 6C: selective native port of stable memory/runtime boundary**

---

## Default next slice

If an autonomous worker starts from the current repo state and needs an immediate next task, choose:

- [ ] **Next default slice:** Phase 1 / Slice 1A — structured memory retrieval interfaces + ranking contract

Why:
- it builds directly on the freshly merged memory foundations
- it unlocks the next several slices
- it is small enough for a focused PR
- it sharpens the product's core thesis: future runs should be better because the system remembers durable facts

---

## Definition of done for each autonomous slice

- [ ] design doc exists or was updated
- [ ] implementation plan exists or was updated
- [ ] code is covered by focused tests
- [ ] `npx pnpm typecheck` passes
- [ ] `npx pnpm build` passes
- [ ] CI-sensitive changes validated on ext4 when necessary
- [ ] branch pushed
- [ ] draft PR opened with a clear summary and test plan

---

## Things autonomous workers must not do

- [ ] do not rewrite the architecture into Rust just because native crates exist
- [ ] do not bundle multiple roadmap phases into one PR
- [ ] do not push synthetic `verify-positive` run commits to mainline branches
- [ ] do not use backup/archive branches as active development bases
- [ ] do not hide memory behavior behind opaque ranking that operators cannot inspect
- [ ] do not make semantic retrieval outrank exact workspace/user facts by default
