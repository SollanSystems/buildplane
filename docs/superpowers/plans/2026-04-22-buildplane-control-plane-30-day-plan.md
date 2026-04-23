# Buildplane Control-Plane 30-Day Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `writing-plans` before large new slices, `subagent-driven-development` for implementation, and `systematic-debugging` for any failure. Keep work PR-sized. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Buildplane's product surface with its strongest thesis: a deterministic control plane for autonomous software execution.

**Architecture:** Keep the center of gravity on kernel/runtime/policy/storage/operator surfaces. Do not widen into a generic chat shell. The next month should make the trust contract boring, expose provenance more clearly, and push replay/review/recovery closer to the default user story.

**Tech Stack:** TypeScript, pnpm workspaces, SQLite (`node:sqlite`), Vitest, Biome, git worktrees, GitHub Actions, existing native bridge where already present.

---

## Verified starting point

- [x] Buildplane already has a real repo-local control-plane path in the current mainline-clean worktree.
- [x] Current repo shape already supports the thesis:
  - `apps/cli`
  - `packages/kernel`
  - `packages/runtime`
  - `packages/policy`
  - `packages/storage`
  - `packages/ui-tui`
  - adapters and native workspace
- [x] README/design docs already identify Buildplane as a control plane.
- [x] Local verification observed recently:
  - `pnpm typecheck` passed
  - `pnpm build` passed
  - `pnpm buildplane bootstrap doctor --json` passed
- [x] Current main blocker is trust/readiness credibility, not lack of architectural direction.
- [x] The earlier published-bootstrap timeout-realism blocker is resolved in current live evidence: `pnpm test` passes and `pnpm verify:published-bootstrap` now completes successfully.
- [x] The most visible remaining trust gap is keeping the support matrix, provenance surfaces, and branch/worktree hygiene aligned with the verified product surface.

---

## Month objective

By the end of this 30-day window, Buildplane should feel less like a promising architecture and more like an operator-trustworthy system.

Success means:

- the supported install/run story is honest and green
- operators can inspect route/memory/policy/evidence in one place
- replay/review/recovery is a clearer front-door narrative than "just run an agent"

---

## Non-negotiable guardrails

- [ ] Do not widen into general agent-shell UX work unless it directly strengthens the control-plane story.
- [ ] No new worker/provider breadth unless it materially helps worker interchangeability or route transparency.
- [ ] Keep repo-local truth honest: do not describe public/global install as stronger than the verified contract proves.
- [ ] Every slice must improve one of: trust, provenance, replay/recovery, or operator calm.
- [ ] Keep slices PR-sized and independently reviewable.
- [ ] Before PR/merge, run at minimum:
  - targeted tests for touched areas
  - `pnpm typecheck`
  - `pnpm build`
- [ ] Treat publish/bootstrap verification as side-effecting and use disposable validation worktrees when needed.
- [ ] If a verification lane is timing out rather than asserting a real failure, fix the harness realism instead of normalizing red gates.

---

## Slice 1 — Make the trust contract boring and green

**Why first:** The architecture is already stronger than the release/readiness surface. That gap is the biggest current trust drag.

**Outcome:** The repo has one clear supported path, green verification for that path, and an honest support matrix for repo-dev vs built CLI vs published/global install.

### Acceptance criteria

- [x] `pnpm test` no longer fails because publish/bootstrap integration tests time out under default suite settings
- [x] integration-heavy publish/bootstrap tests have realistic timeout budgets or a separate slower verification lane
- [x] `verify:published-bootstrap` reflects the real public contract without being needlessly coupled to unrelated suite instability
- [x] README and any release-facing docs clearly distinguish:
  - repo-development path
  - in-repo built CLI path
  - published/global install path
- [x] the current best-supported operator path is stated plainly and honestly

### Likely files

- [ ] Modify: `vitest.config.ts`
- [ ] Modify: `test/workflow/published-bootstrap-install.test.ts`
- [ ] Modify: `test/workflow/published-bootstrap-stage.test.ts`
- [ ] Modify: `scripts/published-bootstrap/verify-positive.mjs`
- [ ] Modify: `README.md`
- [ ] Modify: release/readiness docs as needed

### Slice tasks

- [x] Task 1A: measure and document the exact timeout-sensitive publish/bootstrap cases
- [x] Task 1B: raise timeout realism or split a slower publish-contract lane from the broad default suite
- [x] Task 1C: make `verify:published-bootstrap` prove the public contract with minimal collateral coupling
- [x] Task 1D: add or update a support-matrix doc and ensure README wording matches the real contract

---

## Slice 2 — Unified inspect/provenance surface

**Why second:** Buildplane's moat is not just that it stores state, but that operators can understand why a run behaved the way it did.

**Outcome:** One inspect surface explains route, memory, policy, evidence, and outcome coherently.

### Acceptance criteria

- [ ] inspect output shows the chosen worker/route in a first-class way
- [ ] inspect output shows pack / host / provider selection where applicable
- [ ] inspect output shows injected memories and why they were surfaced
- [ ] inspect output shows the active policy profile / trust gates / approval-relevant decisions
- [ ] inspect output shows evidence, artifacts, and final outcome in one causal story
- [ ] operator can answer "what happened and why?" from one surface without reading raw SQLite tables

### Likely files

- [ ] Modify: `apps/cli/src/run-cli.ts`
- [ ] Modify: `apps/cli/src/formatters.ts`
- [ ] Modify: `packages/storage/src/store.ts`
- [ ] Modify: `packages/kernel/src/*` where provenance payloads are assembled
- [ ] Modify: relevant inspect/history tests

### Slice tasks

- [ ] Task 2A: define the minimum provenance payload contract for inspect/history
- [ ] Task 2B: surface route and worker selection explicitly
- [ ] Task 2C: surface structured memory injection reasons explicitly
- [ ] Task 2D: surface policy/trust-gate context without overloading the operator
- [ ] Task 2E: tighten human-readable formatting so inspect feels calm, not dumpy

---

## Slice 3 — Replay / review / recovery as the default operator narrative

**Why third:** Buildplane becomes legible when users see it rescue or govern runs better than a one-shot raw worker path.

**Outcome:** The default story is not "chat with an agent" but "run, inspect, review, replay, recover."

### Acceptance criteria

- [ ] replay-oriented workflows are easy to discover and understand from CLI help/docs
- [ ] implement-then-review is presented as the default high-trust mode where appropriate
- [ ] recovery after bad or partial runs is visible in operator surfaces and docs
- [ ] a clear benchmark/demo story exists showing why review/replay/recovery beats raw one-shot execution for at least one meaningful case

### Likely files

- [ ] Modify: `apps/cli/src/run-cli.ts`
- [ ] Modify: operator-facing help/docs
- [ ] Modify: replay/review-related tests and fixtures
- [ ] Modify: benchmark/demo docs as needed

### Slice tasks

- [ ] Task 3A: tighten replay/help/operator wording so the flow is obvious
- [ ] Task 3B: make review-mode outcomes clearer in inspect/history surfaces
- [ ] Task 3C: document a concrete rescue/recovery comparison against a raw worker path
- [ ] Task 3D: ensure the front-door docs talk about replay/review/recovery, not generic shell behavior

---

## Weekly cadence

### Week 1

- [x] finish Slice 1 diagnosis and timeout realism fixes
- [x] decide whether publish-contract verification remains in the default suite or gets its own lane
- [x] update README/support-matrix language to match the real support contract

### Week 2

- [ ] land the unified provenance payload contract
- [ ] ship first inspect/history improvements for route + memory visibility

### Week 3

- [ ] ship policy/trust-gate visibility improvements
- [ ] tighten inspect formatting and operator readability

### Week 4

- [ ] ship replay/review/recovery front-door improvements
- [ ] publish one benchmark/demo story proving the control-plane thesis more clearly than raw one-shot execution

---

## Kill criteria / anti-goals

Stop or de-scope if the month drifts into:

- [ ] building broader chat UX instead of stronger control-plane surfaces
- [ ] adding new worker/provider breadth without improving route transparency or interchangeability
- [ ] writing more positioning prose without making the product surface more trustworthy
- [ ] keeping known-red verification lanes because the architecture feels exciting enough anyway

---

## Definition of done

At the end of this plan window:

- [ ] Buildplane's public story matches its actual verified contract
- [ ] the trust/readiness surface is materially stronger and calmer
- [ ] operators can inspect route, memory, policy, and evidence in one coherent flow
- [ ] replay/review/recovery is a stronger default narrative than "just use a smarter shell"
- [ ] the repo is more clearly building control-plane depth, not agent breadth
