# Buildplane Agent Operating System

| | |
|---|---|
| **Status** | Canonical operating model — Draft v1 |
| **Date** | 2026-05-21 |
| **Owning project** | `buildplane` (this repo) |
| **Horizon** | v0.5 (6 months, M0–M6). Forward-compatible with v∞. |
| **Companion docs** | [v0.5 design](../superpowers/specs/2026-05-21-buildplane-v05-design.md) · [v∞ vision](../superpowers/specs/2026-05-21-buildplane-vinf-world-class-design.md) · [direction](../superpowers/specs/2026-05-21-buildplane-direction.md) · [package architecture](./buildplane-package-architecture.md) · [PlanForge](./planforge.md) · [run admission receipts](./run-admission-receipts.md) · [memory schema](./buildplane-memory-schema.md) · [slice receipt template](../operations/slice-receipt-template.md) |
| **Supersedes** | The buildout cadence in [`docs/superpowers/plans/2026-04-13-buildplane-autonomous-buildout.md`](../superpowers/plans/2026-04-13-buildplane-autonomous-buildout.md) — that plan predates the 2026-05-21 v0.5 design and the 2026-05-21 auto-merge governance aids. Keep it for lineage; route new work through this doc. |

This document is the single canonical operating model for how agents, models, hosts, and operators collaborate to land Buildplane v0.5. It is binding for every agent (human or otherwise) that touches this repo. It exists so that any worker session — fresh Claude Code window, Codex review pass, Hermes routine, operator at the keyboard — can read this one file and know exactly what to do, what they cannot do, and where the handoff goes.

## 1. Architecture decision

**Buildplane is its own orchestration framework. Do not introduce LangGraph, CrewAI, AutoGen, Swarm, or any other meta-orchestrator into this repo.**

Every coding-agent workflow goes through one spine:

1. Operator goal →
2. PlanForge dry-run / admission receipt →
3. `UnitPacket` (or `StrategyPacket` / `UnitGraph`) →
4. `BuildplaneOrchestrator.runPacket(Async|Graph|Strategy)` in [`packages/kernel/src/orchestrator.ts`](../../packages/kernel/src/orchestrator.ts) →
5. Bounded worker in an isolated git worktree under a capability bundle →
6. Signed events on the ledger (Rust `bp-ledger`, TS `packages/ledger-client`) →
7. Policy decision (`packages/policy`) →
8. Operator approval gate →
9. Merge via the slice-receipt-template gates and `scripts/ci/pr-auto-merge-eligibility.mjs`.

Why this is the right call (and the only honest call):

- **Buildplane v0.5 IS the orchestrator.** Adopting a third-party orchestration framework would contradict the v0.5 thesis ("evidence-first local execution harness") and force every Buildplane invariant to be re-implemented inside an opaque agent shell. The shipped TypeScript kernel already implements `runPacketAsync`, `runGraphAsync`, `runStrategy`, retry-aware policy loops, admission receipts, and run-scoped event buses. Replacing that with LangGraph would be net-negative.
- **The six invariants only hold inside the kernel.** No claim without evidence, no execution without admission, all authority is policy-mediated, no mystery state, no retroactive PASS, no silent ambient effect. Each is enforced by code in `packages/kernel`, `packages/policy`, `packages/adapters-tools`, and `bp-ledger`. An external orchestrator routes around these gates.
- **The worker contract is already worker-agnostic.** `UnitPacket.routingHints.preferredWorker` already accepts `"claude-code" | "codex"` (see [`packages/kernel/src/run-loop.ts:19`](../../packages/kernel/src/run-loop.ts) and [`packet.ts:317`](../../packages/kernel/src/packet.ts)). New hosts add via `packages/adapters-models` and the native `bp-host-*` crates without changing the kernel.

What this implicitly rejects:

- A separate "agent orchestrator" service or daemon. The kernel is the orchestrator. The CLI invokes it.
- LangGraph-style externalized DAGs of LLM calls. `UnitGraph` already provides dependency scheduling inside the kernel ([`packages/kernel/src/graph.ts`](../../packages/kernel/src/graph.ts)).
- Hermes Agent as the control plane. Hermes is allowed as an **operator-facing kanban surface** only (read-only mirror or queue intake). It must not dispatch Buildplane runs.
- MCP servers as orchestration glue. MCP servers are *tools* attached to a host; the kernel still owns dispatch and policy.

## 2. Local tool inventory (what we actually have)

Evidence gathered on this machine at session start.

| Surface | Version / state | Role in Buildplane operating system |
|---|---|---|
| Node.js | v24.13.1 (`.node-version`) | TS kernel runtime baseline |
| pnpm | 10.0.0 | Workspace manager — `pnpm install`, `pnpm check` |
| Rust | 1.94.1 stable | Native crates (`bp-ledger`, `bp-replay`, `bp-fork`, `bp-memory`) |
| Claude Code CLI | 2.1.147 (Max auth) | Primary worker host (`adapters-models/claude-code-executor.ts`) |
| Codex CLI | installed | Secondary worker host + adversarial reviewer |
| Hermes Agent | v0.14, auto-coder profile running | Operator-facing kanban surface only — NOT control plane |
| gh CLI | installed | PR / label / check inspection (read-only by default) |
| tmux | installed | Long-running worker session multiplexing |
| ruflo | installed | Swarm experiments — NOT used in v0.5 critical path |
| MCP servers (Claude Code) | `claude-ai-Linear`, `claude-ai-Figma`, `claude-ai-Google-Drive`, `claude-ai-Slack`, `context7`, `playwright`, `hermes`, `composio`, `plugin-vercel` | Tool surface for individual agents (read-mostly). Linear/Slack/Drive optional, attached per-pack. |
| `.gsd/audit/receipts/` | active session journaling | Local agent-activity receipts (NOT the Buildplane ledger). |
| `.gsd2/` | not yet present in this worktree | Will host PlanForge-fed task envelopes after M2. |
| Buildplane CI | `.github/workflows/ci.yml` | Required-gates definition (see §6) |
| Auto-merge probe | `scripts/ci/pr-auto-merge-eligibility.mjs` | Read-only eligibility evaluator. Never mutates remote state. |

## 3. Layered roles — operator, kernel, workers

Three rings. Authority flows inward; evidence flows outward.

```
┌─────────────────────────────────────────────────────────────┐
│ Operator (human)                                            │
│   - Sets goals · approves PlanForge plans · approves merges │
│   - Reads ledger via CLI/TUI/Mission-Control (M5)           │
└───────────────────────┬─────────────────────────────────────┘
                        │ approvals + goals
┌───────────────────────▼─────────────────────────────────────┐
│ Buildplane kernel (TS) + native bp-* crates                 │
│   - Compiles intent → PlanForge plan → UnitPacket           │
│   - Dispatches, replays, forks, signs, gates                │
│   - Memory retrieval / promotion / extraction               │
└───────────────────────┬─────────────────────────────────────┘
                        │ packets + bounded capability bundles
┌───────────────────────▼─────────────────────────────────────┐
│ Bounded workers (untrusted by design)                       │
│   - Claude Code host (default permissions, no --dangerous)  │
│   - Codex CLI host                                          │
│   - Any future host implementing bp-host-sdk                │
│   Each worker runs in an isolated git worktree              │
└─────────────────────────────────────────────────────────────┘
```

The kernel is the only thing that holds authority. Workers receive a capability bundle by digest and act under it. Every worker action becomes a signed event on the tape. Workers cannot grant themselves authority; the kernel grants and revokes.

## 4. Model routing table

The table below is normative. It binds task class → model → host → policy profile. Override only with an explicit `routingHints` block on the packet, justified in the slice plan.

| Task class | Default model | Host | Reason | Where it shows up |
|---|---|---|---|---|
| **Architecture / design / load-bearing reviews** | Opus 4.7 (`claude-opus-4-7`) | Claude Code CLI (planning session, no worker dispatch) | Highest synthesis; touches v0.5 invariants. Cannot delegate. | PlanForge compile, /plan-eng-review, M-level decisions, this doc. |
| **PlanForge plan compile + acceptance contract drafting** | Opus 4.7 | Same Claude Code planning session as above | Plan is admission-bearing evidence. | `apps/cli/src/planforge-*.ts`, dry-run output. |
| **Implementer (bulk of coding)** | Sonnet 4.6 (`claude-sonnet-4-6`) | Claude Code worker (`adapters-models/claude-code-executor.ts`) | Cost-correct for code edits; strong tool-use. | `UnitPacket` with `intent.taskType ∈ {implement, refactor, fix, test}`. |
| **Test writer (TDD red phase)** | Sonnet 4.6 | Claude Code worker, often same packet as Implementer (paired) | Single-context yields tighter tests. | `StrategyPacket` with `mode: "implement-then-review"`. |
| **Independent code review (pre-merge)** | Opus 4.7 | Fresh Claude Code session, no write capability | Independence requirement — different context window than implementer. | `superpowers:requesting-code-review`, `/code-review`. |
| **Adversarial diff review (second-opinion gate)** | Codex (GPT-5/o-series via Codex CLI) | `bp-host-codex` / `packages/adapters-codex` | Diverse failure modes; catches Claude-specific blind spots. The 2026-05-21 Codex adversarial review caught material gaps in the v∞ spec that the v0.5 design then fixed. | `/codex review` skill, manual invocation pre-merge for high-risk slices. |
| **Failure debugging (after retry exhaustion)** | Opus 4.7 | Claude Code planning session | Synthesis across receipts + ledger events. | Triggered when `policy.evaluateRun` returns `rejected` after `attemptNumber >= max`. |
| **Doc updates / changelog / receipt fills** | Haiku 4.5 (`claude-haiku-4-5-20251001`) | Claude Code worker with constrained capability bundle (`fs_write: docs/**, CHANGELOG.md`) | Cheap, fast, narrow scope. Cap at low-thousand tokens. | Slice receipt template fills, README touch-ups, CHANGELOG entries. |
| **Summarization / classification / tagging / lint pre-flight** | Haiku 4.5 (fallback OpenAI `gpt-5-nano` via `bp-provider-openai` once that crate ships) | Utility sub-agent or inline tool call | Sub-millisecond cost; routinely needed. | Memory promotion, event-tape summarization, pre-flight lint of PR titles/labels. |
| **Parallel exploration / brainstorming** | Sonnet 4.6 in parallel (subagent dispatch) | Multiple Claude Code agents via `superpowers:dispatching-parallel-agents` | Two-to-four independent attempts > one expensive single. | Design-shotgun, multi-strategy slices, plan reviews. |

Hard rules:

- **Never use `--dangerously-skip-permissions` as ambient authority.** This is invariant 3. PR #113 moved the flag behind explicit `unsafeMode` in `packages/adapters-models/src/claude-code-executor.ts` and emits `claude-code-unsafe-mode-used` evidence before spawn. Future M0 work verifies and hardens that shipped boundary; it does not reintroduce a default bypass path.
- **Opus is for synthesis, not for searches.** Subagents that only read and report should use Haiku (see global CLAUDE.md routing rule).
- **Never escalate model class without recording the reason in the packet.** Promotion happens via memory procedures, not by ad-hoc preference.

## 5. Agent roles + handoff contracts

Every role corresponds to a packet shape and a handoff event. No agent calls another agent directly. All handoffs are mediated by the kernel (packet → ledger event → next packet).

### 5.1 Director

- **Identity:** the human operator + their interactive Claude Code session.
- **Inputs:** business goals, schedule, scope decisions.
- **Outputs:** a written slice goal + a PlanForge `goal-input.md` style fixture.
- **Handoff:** invokes `buildplane planforge dry-run --input <file> --json` (or its future admit successor) → Planner takes over.
- **Cannot:** write production code, approve merges of their own slices without a separate Reviewer.

### 5.2 Planner / Architect (Opus)

- **Inputs:** Director goal + repo state + memory retrieval (`memory-retrieval.ts`).
- **Outputs:** a PlanForge plan (`planforge.plan.v0`), a proposed capability bundle, an acceptance contract, and a slice plan under `docs/superpowers/plans/`.
- **Handoff:** writes the admission receipt input; the kernel produces a signed `run_admission_recorded` event (`run-admission-receipts.md`). On `PASS`, the packet becomes eligible for dispatch.
- **Cannot:** dispatch the packet. Dispatch requires operator approval (M3).

### 5.3 Implementer (Sonnet, paired Test-Writer)

- **Inputs:** the admitted `UnitPacket` with `intent.taskType ∈ {implement, refactor, fix}`; an isolated worktree under `.buildplane/workspaces/<run-id>`.
- **Outputs:** a diff inside the worktree, plus tests for new behavior, plus a worker completion record (becomes an `ExecutionReceipt`).
- **Handoff:** the kernel collects `changedFiles`, records evidence, and emits `command-execution-complete`. Policy evaluates against the acceptance contract.
- **Cannot:** write outside the bundle's `fs_write` paths; spawn unallowed child processes; reach the network outside the `net_egress` allowlist.

### 5.4 Test-Writer (Sonnet)

- **Inputs:** the same packet as Implementer (TDD pairing) OR a follow-up packet when retro-tests are needed.
- **Outputs:** Vitest cases for TS, `#[cfg(test)]` for Rust, integration tests under `test/`.
- **Handoff:** part of the Implementer packet's diff; rolled up in the same `ExecutionReceipt`. When the role is split (rare), the follow-up packet `dependsOn` the Implementer packet via `UnitGraph`.
- **Rule:** use `superpowers:test-driven-development`. Red → green → refactor. No mocks of the database in integration tests.

### 5.5 Reviewer (Opus)

- **Inputs:** a *fresh* Claude Code session (different context window than the Implementer) with read-only access to the diff. The slice plan. The acceptance contract.
- **Outputs:** a review verdict (`PASS` / `REQUEST_CHANGES` / `BLOCKED_INSUFFICIENT_EVIDENCE` / `BLOCKED_UNSAFE_TO_RUN` / `BASELINE_FAILURE`) per the slice-receipt-template vocabulary. A list of significant issues. Reviewed commit SHA recorded.
- **Handoff:** Reviewer's verdict + reviewed SHA feed into the slice receipt's "Review gate" section and the auto-merge probe (`--review-pass --expected-head <sha>`).
- **Cannot:** edit files. Cannot approve a slice it implemented.

### 5.6 Adversarial Reviewer (Codex)

- **Inputs:** the same diff + the slice plan. A different provider stack.
- **Outputs:** a finding list ranked P1/P2/P3. Each finding either fixed by a follow-up commit (SHA recorded) or explicitly accepted with an architecture note.
- **Trigger conditions:** any slice that (a) touches L0-L3 (tape, kernel, packet, pack/host/provider), (b) modifies policy, admission, ledger schema, or auto-merge, or (c) is explicitly flagged in the slice plan.
- **Handoff:** verdict joins the slice receipt's Review gate section.

### 5.7 Debugger (Opus)

- **Trigger:** a `retry-run` policy decision exhausts `attemptNumber >= profile.maxAttempts`, OR an `execution-error` event occurs in the kernel.
- **Inputs:** the failed run id, `buildplane inspect <run-id> --json`, the slice plan.
- **Outputs:** a written root-cause analysis under `docs/superpowers/plans/<date>-<slice>-postmortem.md` AND a corrective packet (either a `fork` from a unit boundary or a new admission). Uses `superpowers:systematic-debugging`.
- **Cannot:** silently re-run the failing packet. Every retry must record why.

### 5.8 Doc Agent (Haiku)

- **Trigger:** Implementer's slice merges, OR a slice explicitly assigns a Doc Agent task.
- **Inputs:** the merged commit SHA, the slice plan, the slice receipt template.
- **Outputs:** filled slice receipt, README/CHANGELOG/architecture index updates, optionally `docs/operations/...` runbook entries.
- **Capability bundle:** `fs_write` restricted to `docs/**`, `CHANGELOG.md`, `.changeset/**`. No source-code writes.

### 5.9 Release Agent (Opus, gated by operator)

- **Trigger:** Reviewer + Adversarial Reviewer have signed off; slice receipt is complete; ledger events exist for admission and execution.
- **Inputs:** the PR number, the reviewed SHA, the operator's explicit approval.
- **Outputs:** runs `scripts/ci/pr-auto-merge-eligibility.mjs --pr <n> --review-pass --expected-head <sha> --json`. If `AUTO_MERGE_READY`, hands the result back to the operator. **Does not merge.** Merge is an operator click in M5; until then, the operator runs `gh pr merge` themselves.
- **Cannot:** push, force-push, rewrite history, alter the auto-merge label, alter required checks, or call any remote API beyond GET probes.

### 5.10 Handoff message shape (the contract)

Every handoff between agents is one of three artifacts. No other handoff form is permitted.

1. **Admission receipt** (`packages/kernel/src/admission-receipts.ts`) — Planner → Kernel → Implementer. Carries `evidence`, `declared_scope`, `requested_side_effects`.
2. **UnitPacket** (`packages/kernel/src/packet.ts`) — Kernel → Worker (Implementer / Test-Writer / Doc Agent). Carries `unit`, `execution`, `model`, `intent`, `verification`, `routingHints`.
3. **Review receipt** (slice receipt template, §"Review gate") — Reviewer → Operator → Release Agent. Carries verdict, reviewed SHA, issue list.

A spoken/free-text message that is not one of these three artifacts is *narration*, not a handoff, and must not gate a state change.

## 6. Verification contract (the gate every slice must pass)

Local minimum before opening a PR:

```bash
pnpm lint
pnpm typecheck
pnpm test          # runs `pnpm native:build && vitest --run`
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm verify:published-bootstrap
```

CI mirror lives in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) and adds:

- ledger payload-fixture freshness check (`pnpm ledger:gen-fixtures` + clean diff)
- no `dist/` directories before build
- dev bootstrap smoke (`buildplane init` + `run --raw` + `status` + `inspect`)
- worktree-clean assertion after smoke
- wrong-Node guard verification (separate job)

Targeted reruns are allowed; partial runs are not — a slice receipt that records only `pnpm test` without `cargo test` is treated as `BLOCKED_INSUFFICIENT_EVIDENCE`.

## 7. PR + auto-merge policy

### 7.1 Eligibility (all required for `AUTO_MERGE_READY`)

The probe at [`scripts/ci/pr-auto-merge-eligibility.mjs`](../../scripts/ci/pr-auto-merge-eligibility.mjs) is the canonical evaluator. A PR is eligible only if **every** condition holds:

1. PR is not draft (else `BLOCKED_DRAFT`).
2. PR `mergeStateStatus` is clean (else `BLOCKED_MERGE_STATE`).
3. PR `headRefOid` equals the reviewed SHA passed via `--expected-head` (else `BLOCKED_SHA_MISMATCH`).
4. Review receipt is `PASS` (`--review-pass`).
5. GitHub `reviewDecision=APPROVED` for protected paths (`--require-github-approval`).
6. All required CI checks observed and successful (else `BLOCKED_CHECKS`).
7. No deployment objects exist for the head SHA (else `BLOCKED_DEPLOYMENT_SIDE_EFFECT`).
8. The opt-in label `buildplane:auto-merge` is present (else `BLOCKED_AUTO_MERGE_OPT_IN`, per PR #115).
9. Slice receipt template is fully filled and committed alongside the slice plan.

If any of those is missing, the probe emits the matching `BLOCKED_*` status and the operator must reconcile before any merge attempt.

### 7.2 Manual review required (no auto-merge candidacy)

These slices never get the `buildplane:auto-merge` label, regardless of CI:

- L0–L4 changes: ledger schema, replay semantics, fork semantics, kernel run loop, packet schema, admission receipts, sandbox boundary, capability bundles.
- Policy changes: `packages/policy/**`, retry behavior, trust-gate behavior, budget profiles.
- Security-shaped diffs: anything touching credentials, env scrubbing, `--dangerously-*` flags, `unsafe-mode`, signing keys.
- Migration changes: SQLite migrations, schema versions, `bp-storage-sqlite/**`, durable-state shape.
- Deployment + release plumbing: CI workflow edits, release workflow edits, `scripts/published-bootstrap/**`, the auto-merge probe itself.
- Architecture diff scope breaches: any change where `policy.evaluateArchitectureDiffScope` would have rejected.

### 7.3 Auto-merge candidates

A slice can be labelled `buildplane:auto-merge` only if it is:

- Docs-only inside `docs/**` AND was reviewed by a separate Reviewer, OR
- A dependabot patch in scope (already gated by `.github/dependabot.yml`), OR
- A test-only addition inside an already-greenlit package with no source change, OR
- A trivial fixture refresh (ledger payload variants, smoke fixtures) with the freshness check passing.

In every other case, a human operator clicks merge.

### 7.4 No-go list (durable)

Regardless of probe verdict, agents NEVER:

- Push to `main` directly.
- Force-push to any branch.
- Rewrite published history.
- Remove the `buildplane:auto-merge` label opt-in requirement.
- Bypass required checks (`--admin`, branch-protection overrides).
- Open PRs with `--no-verify`-committed history.
- Merge a PR they reviewed if they also implemented it.

## 8. Workflow / kanban surface

There is no Hermes / Linear / Jira bookkeeping requirement that overrides repo state. Repo state is the source of truth.

| Layer | Purpose | Source-of-truth? |
|---|---|---|
| **PlanForge plans** (`docs/superpowers/plans/`, `docs/superpowers/specs/`) | Pre-execution contract for each slice. | Yes — the plan is the slice's spec. |
| **GSD2 task envelopes** (`.gsd2/<task-id>/`, when M2 lands) | Bounded envelope per task: `task.md`, `envelope.yaml`, `receipt.yaml`. NEW → READY → ADMITTED → RUNNING → PASSED/FAILED. | Yes — the kernel state for in-flight slices. |
| **`.gsd/audit/receipts/<date>.jsonl`** | Session-level activity journal (already active). | Yes — agent activity log, not the Buildplane ledger. |
| **Buildplane ledger** (`bp-ledger` + `packages/ledger-client`) | Per-run, per-event signed history. | Yes — the canonical evidence record. |
| **GitHub Issues / PRs** | External visibility + reviewer assignment. | No — mirrors repo state; never authoritative. |
| **Hermes Agent kanban** (optional) | Operator-facing view of queued / running slices when the operator wants a board UI. | No — read-only operator surface; must not dispatch Buildplane runs. |
| **Linear / Slack / Drive / Figma** | Reference-only via the global memory pattern. | No — pointers, never primary. |

Until M2 lands PlanForge end-to-end, the cadence is: each slice gets a `docs/superpowers/plans/<date>-<slug>.md`, runs through the kernel via `buildplane run` or `buildplane run --packet`, and produces a slice receipt under `docs/operations/<slice>-receipt.md` (or inline in the PR body).

## 9. Implementation phases (aligned to v0.5 M0–M6)

Operating-model phases mirror the v0.5 milestones. Each phase records: (a) which agent role owns it, (b) acceptance contract, (c) ledger evidence.

| Phase | Window | Owner role | Scope | Acceptance |
|---|---|---|---|---|
| **Phase 0 — Operating model commit** | now | Director + Planner | This doc lands; the next M0 verification slice is named; the 2026-04-13 autonomous buildout plan annotated as superseded. | Doc on `main` (after operator merge); link in `docs/architecture/README.md`. |
| **Phase 1 — M0 permissions verification + hardening** | Week 0–1 | Planner + Implementer + Reviewer + Adversarial Reviewer | PR #113 already gates Claude Code unsafe permissions behind explicit `unsafeMode` and records `claude-code-unsafe-mode-used` evidence. Verify the shipped boundary end-to-end: audit all spawn call sites for residual ambient-authority flags, add an integration test that exercises default-safe and explicit-unsafe paths, and freeze a CI assertion that the default path never injects `--dangerously-skip-permissions`. | `pnpm check` + `cargo test` pass; integration evidence proves default-safe spawn and explicit unsafe evidence emission; dist/default-spawn assertion green; Reviewer + Codex sign off; slice receipt filled. |
| **Phase 2 — M1 per-event signing** | Week 1–5 | Planner + Implementer + Reviewer | Ed25519 detached signatures in `bp-ledger`; verification on read; tape-root checkpoint events every N events. Updated `ledger-client` wire protocol. | Signature verification test green; wire protocol fixture freshness check passes; external-verifier reference script in `scripts/` reads and verifies a sample tape. |
| **Phase 3 — M2 PlanForge consolidation** | Week 5–11 | Planner + Implementer + Reviewer + Doc Agent | Consolidate PlanForge feature branches to `main`. Complete `compile → validate → preview → admit → execute → receipt`. Receipt is a signed ledger event. Replay survives mid-cycle crash. | End-to-end demo run from `bp goal "..."` to recorded receipt; crash-and-resume integration test green; admission denied path tested. |
| **Phase 4 — M3 capability bundle as digest-referenced object** | Week 11–14 | Planner + Implementer + Reviewer | Add `capability_bundle`, `acceptance_contract`, `provenance_ref`, `trust_scope` to `UnitPacket`. Policy broker validates on every tool call. Worktree sandbox enforces `fs_write` scope check against bundle. | Out-of-scope file write is rejected with a `quarantine` event; bundle digest appears in admission receipt and ledger; integration tests cover both allow and deny paths. |
| **Phase 5 — M4 acceptance contract + tape-replay verification** | Week 14–20 | Planner + Implementer + Reviewer + Adversarial Reviewer | Diff-scope + CI-status + lint-clean acceptance contract validator. Receipt verification by tape replay. Quarantine path for failed contracts. | A failing contract produces `CONTRACT_FAILED` and no merge; passing contract produces a verifiable receipt; external script verifies independently. |
| **Phase 6 — M5 Mission Control web v1** | Week 20–25 | Planner + Implementer + Doc Agent + Reviewer | Read-only timeline scrubber + approval inbox + signed approval events. Local-loopback only with a per-machine token. | Operator can approve a packet via the web UI; the approval becomes a signed ledger event; no remote listener allowed without token. |
| **Phase 7 — M6 vertical slice demo + v0.5.0-alpha** | Week 25–26 | Director + all roles | The rate-limiting demo from the v0.5 design §7. Demo video. v0.5.0-alpha tag. | Demo recorded; tag pushed by operator; release notes generated by Doc Agent. |

## 10. First concrete tasks (next 7 days)

These are the actionable tasks unlocked by this operating model. The first one is what this session is producing right now.

1. **Land this operating-model doc** on `docs/buildplane-agent-orchestration-fresh` branch. Open the PR with the `buildplane:auto-merge` label deliberately omitted; this is an architecture-bearing doc and must be human-reviewed.
2. **Add link from `docs/architecture/README.md`** to this file. (Done in the same PR.)
3. **Annotate the 2026-04-13 autonomous buildout plan** with a "Superseded by" banner pointing here. (Done in the same PR.)
4. **Open the M0 verification slice plan** `docs/superpowers/plans/2026-05-22-m0-permissions-verification.md` — owner: Planner. Scope: verify the PR #113 unsafe-permissions boundary end-to-end; audit all Claude/Codex/native spawn sites for residual ambient-authority flags; add an integration test under `test/` covering default-safe and explicit-unsafe paths; assert the default spawn path never injects `--dangerously-skip-permissions`; refresh fixtures only if the evidence shape changes.
5. **Open the M1 design spec** `docs/superpowers/specs/2026-05-22-tape-per-event-signing.md` — owner: Planner. Cover key management, Ed25519 detached signatures, tape-root checkpoint cadence, wire-protocol additions to `packages/ledger-client`.
6. **Pre-flight the auto-merge probe** for an arbitrary recent PR locally:
   `node scripts/ci/pr-auto-merge-eligibility.mjs --pr 116 --review-pass --json`
   to confirm the eligibility surface is healthy and to seed the operator's mental model.
7. **Inventory open feature branches** referenced in the v0.5 design §1 using read-only `gh pr list`, `git branch -r`, and `git ls-remote --heads` probes only (PlanForge variants, BP5B admission persistence, BP6A/6B run-loop wiring, `buildplane-inspector-mvp`). Capture them in a single status note so Phase 3's consolidation has a clean starting list; do not delete, push, rename, or close branches from this task.

Tasks 4 and 5 are the next two slice plans. Tasks 6 and 7 are operator hygiene; either Director or Planner can do them.

## 11. Operator approvals required to act on this doc

This doc is itself a Buildplane artifact and follows the same contract.

- **Doc merge:** human operator clicks merge after CI green. Auto-merge label NOT applied (architecture-bearing doc).
- **Phase 1 (M0) start:** operator approves the M0 verification slice plan before any agent edits `packages/adapters-models/src/claude-code-executor.ts` or adjacent worker-spawn paths.
- **Phase 2 (M1) signing keys:** operator decides where keys live (`~/.buildplane/keys/` per-machine vs. per-operator) before any code change.
- **Auto-merge label provisioning:** operator confirms the `buildplane:auto-merge` label exists in the repo and is restricted via branch protection / CODEOWNERS.

Until these approvals land, agents only **plan and draft** — no destructive or remote actions.

## 12. What this doc explicitly does not do

- Does not enable auto-merge for itself.
- Does not introduce new packages, dependencies, or runtime surfaces.
- Does not change CI gates, branch protection, label rules, or release plumbing.
- Does not modify any `.ts`, `.rs`, `.toml`, or schema file.
- Does not commit to specific external services (Linear board layout, Slack channels, Hermes column shape). Those remain pointers.

It is a single Markdown artifact whose only job is to give every future agent — fresh window, fresh session, fresh contributor — a coherent operating model so that v0.5 ships.

## 13. References

- v0.5 design: [`docs/superpowers/specs/2026-05-21-buildplane-v05-design.md`](../superpowers/specs/2026-05-21-buildplane-v05-design.md)
- v∞ vision: [`docs/superpowers/specs/2026-05-21-buildplane-vinf-world-class-design.md`](../superpowers/specs/2026-05-21-buildplane-vinf-world-class-design.md)
- Direction snapshot: [`docs/superpowers/specs/2026-05-21-buildplane-direction.md`](../superpowers/specs/2026-05-21-buildplane-direction.md)
- Package architecture: [`docs/architecture/buildplane-package-architecture.md`](./buildplane-package-architecture.md)
- PlanForge contract: [`docs/architecture/planforge.md`](./planforge.md)
- Admission receipts: [`docs/architecture/run-admission-receipts.md`](./run-admission-receipts.md)
- Memory schema: [`docs/architecture/buildplane-memory-schema.md`](./buildplane-memory-schema.md)
- Slice receipt template: [`docs/operations/slice-receipt-template.md`](../operations/slice-receipt-template.md)
- Auto-merge probe: [`scripts/ci/pr-auto-merge-eligibility.mjs`](../../scripts/ci/pr-auto-merge-eligibility.mjs)
- CI: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
- Orchestrator: [`packages/kernel/src/orchestrator.ts`](../../packages/kernel/src/orchestrator.ts)
- Run loop types: [`packages/kernel/src/run-loop.ts`](../../packages/kernel/src/run-loop.ts)
- Packet schema: [`packages/kernel/src/packet.ts`](../../packages/kernel/src/packet.ts)
- Superseded operating cadence: [`docs/superpowers/plans/2026-04-13-buildplane-autonomous-buildout.md`](../superpowers/plans/2026-04-13-buildplane-autonomous-buildout.md)
