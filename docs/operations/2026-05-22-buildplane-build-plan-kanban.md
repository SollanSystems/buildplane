# Buildplane build plan — Kanban queue (2026-05-22)

| | |
|---|---|
| **Status** | Active build-plan / Kanban queue for the next development window |
| **Date** | 2026-05-22 |
| **Owning project** | `buildplane` (this repo) |
| **Horizon** | The next M1 slices through the M1→M2 handoff. v0.5 milestone M0 is complete; M1 is in flight. |
| **Base** | `origin/main` at `99bb8e38839e306504c089e650cefc05c45c7819` (PR #123 canonical event hash fixture) |
| **Authority** | Operating model: [`docs/architecture/buildplane-agent-operating-system.md`](../architecture/buildplane-agent-operating-system.md). This file is queue/runtime state — not an architecture change. |
| **Supersedes for queue purposes** | The "First concrete tasks (next 7 days)" list in §10 of the operating model. Those items have landed; this file is the current queue. The operating model itself is not edited in this run (single-artifact constraint). |

This document is the live Kanban queue. It tells any fresh agent session (Director, Planner, Implementer, Reviewer, Adversarial Reviewer, Doc Agent, Release Agent), the Hermes operator-facing mirror, and the operator: **what is done, what is next, in what order, under what gates, blocked on what operator decisions, and exactly which card to pick up first.**

Treat it as data. It is queue state, not policy. Policy lives in the operating model.

## 1. Sequencing decision (binding)

The next development window proceeds in this exact order. Do not reorder without explicit operator approval recorded in this file.

1. **M1-S3** — Signature persistence and append-only protections. **Next card. Unblocked.**
2. **M1-S5** — Verification-on-read and replay status. Depends on S3.
3. **M1-S6** — Tape-root checkpoint payload and cadence. Depends on S3; can overlap with S5 once S3 lands.
4. **OPERATOR-DECISION-A** — Key-location policy. Required before any code in M1-S4. Recommended default: per-machine `~/.buildplane/keys/` with actor-scoped paths (see [M1 spec §"Key-management decision required before code"](../superpowers/specs/2026-05-22-tape-per-event-signing.md)).
5. **M1-S4** — Local keyring + signing on append. **Blocked** until OPERATOR-DECISION-A resolves.
6. **M1-S7** — External verifier script. Depends on S4 + S6 (needs both signatures and checkpoints to exercise).
7. **M1-GATE** — Full M1 gate per the M1 spec §"Full M1 gate".
8. **M2-PREP-1** — Fresh branch-inventory audit from current `origin/main`. Read-only. Refreshes the stale 2026-05-22 hygiene snapshot whose mainline SHA is `86cc2d3` (now `99bb8e3`).
9. **M2** — PlanForge consolidation begins only after M1-GATE passes and M2-PREP-1 produces a clean salvage list.

Why this order:

- **M1-S3 first**, not M1-S4, because S4 is blocked on the key-location operator decision the M1 spec already calls out. S3 is purely local SQLite work — adds the `event_signatures` table plus append-only triggers — and unblocks every subsequent slice that needs a place to put signatures.
- **M1-S5 next**, not M1-S6, because verification-on-read is the surface that callers downstream of M1 (admission, approval, merge) actually consume. Checkpoint cadence (S6) is useful but not load-bearing for downstream M-milestones until verification statuses exist.
- **M2 salvage deferred** until M1-S5 at minimum. The bp6b/BP5/BP6 lineage writes admission-persistence rows that will eventually need signed events; consolidating before the signed-tape contract is past verification-on-read risks re-doing migration work.
- **The 2026-04-13 autonomous-buildout cadence is superseded** by the operating model — do not pull a card from it. Use this file.

## 2. Current state (evidence)

Captured at session start. All read-only.

### 2.1 Mainline

- `origin/main`: `99bb8e38839e306504c089e650cefc05c45c7819`
- Latest merged work: PR #123 (`feat(ledger): add canonical event hash fixture`).
- Open PRs at snapshot time: none.

### 2.2 Milestone progress

| Milestone | Status | Evidence |
|---|---|---|
| **M0** — Permissions verification + hardening | **Complete** | PR #113 gated `--dangerously-skip-permissions` behind `unsafeMode`. PR #118 (`test(adapters-models): verify Claude unsafe permissions gate`) verified the boundary end-to-end. Plan: [`docs/superpowers/plans/2026-05-22-m0-permissions-verification.md`](../superpowers/plans/2026-05-22-m0-permissions-verification.md). |
| **M1-S1** — Signed event schema contract | **Complete** | PR #116. Detached `EventSignatureV1` / `ActorKeyRef` types; TS fixture + schema test locked. |
| **M1-S2** — Canonical event hash + fixture parity | **Complete** | PR #123. Rust `canonical_event_hash` returns `sha256:<hex>`; fixture and TS test pinned to the same hash; envelope shape unchanged. |
| **M1-S3** — Signature persistence + append-only protections | **Next** | Unblocked. See §4 for the card. |
| **M1-S4** — Local keyring + signing on append | **Blocked** | Requires OPERATOR-DECISION-A (key location). |
| **M1-S5** — Verification-on-read + replay status | Queued | Depends on M1-S3. |
| **M1-S6** — Tape-root checkpoint payload + cadence | Queued | Depends on M1-S3. |
| **M1-S7** — External verifier script | Queued | Depends on M1-S4 + M1-S6. |
| **M2** — PlanForge consolidation | Deferred | Waits on M1-GATE and M2-PREP-1. |
| **M3–M6** | Not yet active | Owned by operating model §9. |

### 2.3 Branch / remote state

Read-only probes at session start:

- Open PRs: none.
- Remote feature branch matching M1/M2 search:
  - `bp6b-run-loop-admission-wiring` at `46095118a55d799fe77fac3382ccad2c14e38ba2`. Lineage candidate for M2 admission/run-loop consolidation. **Do not mutate** — inspect against `origin/main` only.
  - `prototype-main`, `docs/salvage-jtbd-runs-artifacts-20260503` exist but are out of the next-window scope.
- Local worktree signals (BP5/BP6 admission lineage, planforge schema extraction, inspector-mvp) recorded in [`docs/superpowers/plans/2026-05-22-branch-inventory-and-auto-merge-preflight.md`](../superpowers/plans/2026-05-22-branch-inventory-and-auto-merge-preflight.md). That snapshot's "Mainline state" SHA (`86cc2d3`) is now stale relative to `99bb8e3`; M2-PREP-1 refreshes it.

### 2.4 Toolchain (verified at session start)

| Surface | Version | Role |
|---|---|---|
| Node.js | v24.13.1 (pinned by `.node-version` / `engines.node`) | TS kernel runtime |
| pnpm | 10.33.2 (lockfile pins `packageManager: pnpm@10.0.0`) | Workspace manager |
| Rust | 1.94.1 stable | Native crates |
| Claude Code CLI | 2.1.148 | Implementer / Reviewer host |
| Codex CLI | installed | Adversarial Reviewer host |
| gh CLI | 2.92.0 | Read-only PR/label probes |
| Hermes Agent | v0.14.0 (MCP connected) | Operator-facing kanban mirror only — must not dispatch runs |

Optional MCP connectors with auth/path issues at session start (`Slack`, `Google-Calendar`, `Vercel`, `gsd-workflow`, `devbrain` WSL path): **not blocking** for repo-local Buildplane planning. Defer their repair until they are actually needed by a card.

## 3. Model routing (binding, normative)

Routing is delegated to the operating-model §4 routing table. Repeated here for the next-window cards so no agent has to chase a link.

| Role on this queue | Model | Host | Reason |
|---|---|---|---|
| Planner / Architect (per-card plan + acceptance contract) | **Opus 4.7** (`claude-opus-4-7`) | Claude Code planning session, no worker dispatch | Synthesis; touches L0 ledger contract. |
| Implementer (M1-S3, S5, S6, S7 code + tests) | **Sonnet 4.6** (`claude-sonnet-4-6`) | Claude Code worker via `packages/adapters-models/src/claude-code-executor.ts` with `unsafeMode = false` | Cost-correct; strong tool-use. |
| Test-Writer | **Sonnet 4.6** | Paired with Implementer in the same worker session | TDD red→green→refactor (`superpowers:test-driven-development`). |
| Independent Reviewer | **Opus 4.7** | Fresh Claude Code session, read-only access to the diff | Independence requirement. Different context window than Implementer. |
| Adversarial Reviewer | **Codex** (latest GPT-5/o-series via Codex CLI) | `bp-host-codex` / `packages/adapters-codex` with `--full-auto` flagged as authority-relevant (M0 audit) | Diverse failure modes. Required for every M1 slice (L0 trust surface). |
| Debugger (post-failure) | **Opus 4.7** | Claude Code planning session | Cross-receipt synthesis. |
| Doc Agent (slice receipts, README touch-ups) | **Haiku 4.5** (`claude-haiku-4-5-20251001`) | Claude Code worker, `fs_write` restricted to `docs/**`, `CHANGELOG.md`, `.changeset/**` | Narrow scope; cheap. |
| Branch-inventory / search subagents | **Haiku** | Read-only `gh` / `git ls-remote` / Grep / Read | Read-only listing. Never Opus. |

Hard rules carried from the operating model:

- Every `Agent`/subagent call **MUST** pass an explicit `model` parameter. Inheriting Opus on a Read/Glob sweep is forbidden.
- No `--dangerously-skip-permissions` as ambient authority. PR #113's `unsafeMode` gate is the only path; default remains `false`.
- Reviewer cannot be the same context as Implementer. Different session, different window.
- Opus only for synthesis. Read-only listings/probes always route to Haiku.

## 4. Kanban card list

Cards below are the **current queue**. Card IDs are stable; downstream slice plans/receipts must reference these IDs.

Columns: **READY** (pickable now), **BLOCKED** (waiting on operator or upstream), **QUEUED** (ordered behind a card in the same column).

### 4.1 READY

#### Card `M1-S3` — Signature persistence + append-only protections

- **Owner role:** Planner (Opus) → Implementer + Test-Writer (Sonnet) → Reviewer (Opus, fresh session) → Adversarial Reviewer (Codex).
- **Status:** **READY — execute next.**
- **Depends on:** M1-S2 (complete, PR #123).
- **Scope (from M1 spec §M1-S3):**
  - Add `event_signatures` SQLite table per the proposed shape in [`docs/superpowers/specs/2026-05-22-tape-per-event-signing.md`](../superpowers/specs/2026-05-22-tape-per-event-signing.md).
  - Add `event_signatures_no_update` and `event_signatures_no_delete` triggers.
  - Reject signature append for a missing event.
  - Reject duplicate signature append for an event.
  - Allow reads of historical unsigned events (verification status surfacing is M1-S5, not here).
- **Files likely to change:** `native/crates/bp-ledger/src/storage/sqlite.rs`, `native/crates/bp-ledger/tests/append_only.rs`, `native/crates/bp-ledger/tests/round_trip.rs`. Possibly a new `bp-ledger` migration under whatever SQLite migration convention the storage module already uses (read first; do not invent).
- **Acceptance contract:**
  - Append-only invariants are test-covered (update fails, delete fails, duplicate fails, missing-event signature fails).
  - Historical event reads remain possible.
  - No change to the event envelope.
  - No keyring or signing behavior introduced here.
- **Verification gate (per M1 spec):**
  ```bash
  cargo test --manifest-path native/Cargo.toml -p bp-ledger append_only signature
  cargo test --manifest-path native/Cargo.toml -p bp-ledger round_trip
  ```
  Then the full slice gate:
  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  cargo test --manifest-path native/Cargo.toml
  pnpm verify:published-bootstrap
  ```
- **Review gates:**
  - Independent Reviewer (Opus, fresh session) verdict `PASS` per the slice-receipt vocabulary.
  - Codex adversarial review required — M1-S3 is L0 trust surface (ledger schema + append-only behavior).
  - Reviewer cannot be the Implementer's session.
- **Side-effect boundaries (durable for this card):**
  - No push, no PR open, no merge, no branch deletion, no remote label/branch-protection edits without operator approval. Operator clicks merge.
  - No edits to `.github/`, `scripts/ci/pr-auto-merge-eligibility.mjs`, or release plumbing.
  - No introduction of `--dangerously-skip-permissions` defaults.
  - No fixture refresh that touches signed events without recording a regenerate command in the receipt.
  - Changeset file required if the change is package-visible.
- **Auto-merge candidacy:** **Not eligible.** L0 schema change → human merge per operating model §7.2. Do not apply the `buildplane:auto-merge` label.
- **Operator approvals required to start:** none beyond standard "operator may inspect the slice plan" — this card has no novel authority needs.
- **Slice receipt:** mandatory. Use [`docs/operations/slice-receipt-template.md`](./slice-receipt-template.md). Commit alongside the slice plan.

#### Card `M1-S3-PLAN` — Open the M1-S3 slice plan (prerequisite for `M1-S3`)

- **Owner role:** Planner (Opus).
- **Status:** **READY — must precede `M1-S3` execution.**
- **Output:** `docs/superpowers/plans/<YYYY-MM-DD>-m1-s3-signature-persistence.md` written from the M1 spec §M1-S3 scope, with files-to-change, acceptance contract, verification commands, review requirements, and side-effect boundaries restated. Linked from this Kanban file.
- **Side-effect boundary:** docs-only. No source changes.

### 4.2 BLOCKED

#### Card `OPERATOR-DECISION-A` — Key-location policy

- **Owner:** Operator (human). Cannot be delegated to any agent.
- **Status:** **BLOCKED on operator.**
- **Question:** Where do M1 Ed25519 signing keys live? Recommended default in the M1 spec is per-machine `~/.buildplane/keys/` with actor-scoped paths:
  - `kernel/<key-id>.ed25519`
  - `worker/<worker-id>/<key-id>.ed25519`
  - `operator/<operator-id>/<key-id>.ed25519` (only after approval events ship)
- **Why blocking now:** The M1 spec §"Key-management decision required before code" makes this an explicit pre-code gate for M1-S4. Code in M1-S4 must not be written before the operator accepts or overrides this default.
- **Resolution form:** Operator records "approved" or "overridden with: <alt path / scheme>" in this card's status, plus a Decision log entry under operating model §11 if the operator chooses a different policy.

#### Card `M1-S4` — Local keyring + signing on append

- **Owner role:** Planner (Opus) → Implementer + Test-Writer (Sonnet) → Reviewer (Opus) → Adversarial Reviewer (Codex).
- **Status:** **BLOCKED on OPERATOR-DECISION-A.**
- **Depends on:** M1-S3 (READY) + OPERATOR-DECISION-A (BLOCKED).
- **Acceptance preview** (from M1 spec §M1-S4):
  - Test fixture keys can sign deterministically.
  - Signed append stores event + matching detached signature before reporting success.
  - Failure in signed mode fails closed on event append.
  - No private-key bytes in logs/errors.
- **Auto-merge candidacy:** Not eligible. Touches signing keys → operating model §7.2 manual-review list.

### 4.3 QUEUED (after M1-S3)

#### Card `M1-S5` — Verification-on-read + replay status

- **Owner role:** Planner (Opus) → Implementer + Test-Writer (Sonnet) → Reviewer (Opus) → Adversarial Reviewer (Codex).
- **Depends on:** M1-S3. Can proceed before M1-S4 (verification-on-read returns `unsigned` for events without signatures; that is the spec'd state).
- **Acceptance preview:** All six verification statuses covered: `verified`, `unsigned`, `missing_key`, `hash_mismatch`, `bad_signature`, `unsupported_algorithm`. Replay remains read-only. M1+ strict paths fail closed on non-verified events.
- **Auto-merge candidacy:** Not eligible — L0/L1 trust surface.

#### Card `M1-S6` — Tape-root checkpoint payload + cadence

- **Owner role:** Planner (Opus) → Implementer + Test-Writer (Sonnet) → Reviewer (Opus) → Adversarial Reviewer (Codex).
- **Depends on:** M1-S3. Can overlap with M1-S5.
- **Acceptance preview:** Checkpoint payload generated into TS; checkpoint events emit at configurable cadence (default 256/run, smaller in tests); root recomputes deterministically; fixture freshness passes.
- **Generated-types regeneration commands** (mandatory in receipt):
  ```bash
  pnpm ledger:gen
  pnpm ledger:gen-fixtures
  git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
  ```
- **Auto-merge candidacy:** Not eligible — L0 schema change.

#### Card `M1-S7` — External verifier script

- **Owner role:** Planner (Opus) → Implementer (Sonnet) → Doc Agent (Haiku) → Reviewer (Opus).
- **Depends on:** M1-S4 + M1-S6. Adversarial review still required because the verifier is the externally-trusted check.
- **Acceptance preview:** `scripts/verify-signed-tape.mjs` succeeds on a valid signed tape; fails on tampered payload, bad signature, missing key, bad checkpoint root; one operator-facing command added to `docs/ledger.md`.
- **Auto-merge candidacy:** Not eligible while it ships; subsequent doc-only refinements of `docs/ledger.md` may be eligible if reviewed.

#### Card `M1-GATE` — Full M1 acceptance run

- **Owner role:** Doc Agent (Haiku) prepares the receipt; Reviewer (Opus) signs the verdict.
- **Trigger:** After M1-S7 lands.
- **Acceptance:** Run the full M1 spec §"Full M1 gate" sequence end-to-end on a clean checkout and record exit codes in the receipt:
  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  cargo test --manifest-path native/Cargo.toml
  pnpm ledger:gen-fixtures
  git diff --exit-code
  ```
- **Auto-merge candidacy:** Receipt-only docs commit may be auto-merge eligible if it is the only change in its PR.

### 4.4 QUEUED (M1→M2 handoff)

#### Card `M2-PREP-1` — Refresh branch-inventory + auto-merge probe snapshot

- **Owner role:** Planner (Opus) for synthesis; subagent reads are Haiku.
- **Depends on:** M1-GATE (so M2 starts from a stable ledger contract).
- **Scope:**
  - Re-run the read-only probes from [`docs/superpowers/plans/2026-05-22-branch-inventory-and-auto-merge-preflight.md`](../superpowers/plans/2026-05-22-branch-inventory-and-auto-merge-preflight.md) against current `origin/main`.
  - Classify `bp6b-run-loop-admission-wiring` against current `origin/main`: salvageable, partially superseded, or fully superseded by signed-tape work.
  - Classify each local BP5/BP6 admission worktree (`bp5bf-admission-secret-hygiene`, `bp5a-admission-event-contract`, `bp5b-admission-receipt-persistence`, `bp6a-run-loop-admission-checkpoint`) the same way.
  - Re-run the auto-merge probe on the latest merged PR and confirm the eligibility surface is still healthy.
- **Output:** new dated snapshot under `docs/superpowers/plans/<YYYY-MM-DD>-branch-inventory-and-auto-merge-preflight.md`. Do not edit the 2026-05-22 snapshot — keep it for lineage.
- **Side-effect boundary:** docs-only. No branch deletion, no force-push, no PR mutation.

#### Card `M2-KICKOFF` — M2 PlanForge consolidation kickoff

- **Owner role:** Planner (Opus). Implementer cohort assigned per the consolidated branch list.
- **Depends on:** M2-PREP-1.
- **Scope:** Per operating model §9 Phase 3 — `compile → validate → preview → admit → execute → receipt` with receipt as a signed ledger event; replay survives mid-cycle crash.
- **Not yet expanded in this Kanban.** M2 will get its own dated build-plan artifact when M1-GATE passes.

## 5. Dependency graph (summary)

```
M0 (done) ──► M1-S1 (done, #116) ──► M1-S2 (done, #123) ──► M1-S3 (READY)
                                                              │
                                                              ├──► M1-S5 (queued)
                                                              └──► M1-S6 (queued)

OPERATOR-DECISION-A (blocked) ──► M1-S4 (blocked) ──┐
                                                    ├──► M1-S7 (queued) ──► M1-GATE ──► M2-PREP-1 ──► M2-KICKOFF
                                              M1-S6 ┘
```

## 6. Acceptance gates (binding)

Every card on this queue obeys these gates. They are restated from the operating model so a fresh agent does not have to chase the link.

### 6.1 Local minimum before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test          # runs `pnpm native:build && vitest --run`
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm verify:published-bootstrap
```

Targeted reruns allowed. Partial runs that omit `cargo test` are treated as `BLOCKED_INSUFFICIENT_EVIDENCE`.

### 6.2 CI mirror

CI is canonical for full parallel runs and adds: ledger payload-fixture freshness check (`pnpm ledger:gen-fixtures` clean diff), no `dist/` directories before build, dev bootstrap smoke (`buildplane init` + `run --raw` + `status` + `inspect`), worktree-clean assertion after smoke, wrong-Node guard.

### 6.3 Review gates (per slice)

- **Independent Reviewer (Opus, fresh session)** verdict in `{PASS, REQUEST_CHANGES, BLOCKED_INSUFFICIENT_EVIDENCE, BLOCKED_UNSAFE_TO_RUN, BASELINE_FAILURE}`. Only `PASS` unblocks PR handoff.
- **Adversarial Reviewer (Codex)** required for every M1 slice (L0 trust surface) and for any slice listed under operating model §7.2 manual-review categories.
- **Reviewed SHA** must equal the PR head SHA at merge time. Auto-merge probe enforces this via `--expected-head`.
- **Slice receipt** filled per `slice-receipt-template.md` and committed alongside the slice plan.

### 6.4 Auto-merge eligibility

No M1 slice on this queue is auto-merge eligible. The `buildplane:auto-merge` label is **not** applied to any M1 PR. Operator clicks merge after all gates pass and the probe reports `AUTO_MERGE_READY` (or an explicit operator override is recorded in the receipt).

The probe is read-only:
```bash
node scripts/ci/pr-auto-merge-eligibility.mjs \
  --pr <n> \
  --review-receipt <path-to-independent-review> \
  --expected-head <sha> \
  --expected-base <branch> \
  --json
```

Use `--review-pass` instead of `--review-receipt` only when an independent PASS verdict exists but is not stored in a local receipt file.

## 7. Side-effect boundaries (durable for this queue)

Agents working off this queue **NEVER**:

- Push to `main` directly.
- Force-push to any branch.
- Rewrite published history.
- Add or remove the `buildplane:auto-merge` label.
- Edit branch protection or required-check configuration.
- Open PRs with `--no-verify`-committed history.
- Merge a PR they reviewed if they also implemented it.
- Bypass required checks (`--admin`, branch-protection overrides).
- Use `--dangerously-skip-permissions` as ambient authority on the Claude Code worker.
- Resurrect stale branches in place — salvage moves to a fresh branch from current `origin/main`.
- Dispatch real Buildplane worker runs from a Kanban-mirror surface (Hermes is read-only mirror).
- Touch GitHub Actions, release plumbing, or `scripts/published-bootstrap/**` from inside an M1 implementation slice.

Allowed without operator approval:

- Read source / tests / docs / native crates / scripts.
- Create or edit Markdown planning artifacts under `docs/superpowers/plans/` and `docs/operations/`.
- Create local commits on isolated branches.
- Run local verification commands.
- Run read-only `gh` / `git ls-remote` probes.

## 8. Operator approvals required

The operator must explicitly approve, in writing in this file or via a linked decision log entry, before the corresponding event:

| Approval | Required before | Default if approved |
|---|---|---|
| **OPERATOR-DECISION-A** — Key-location policy | Any code change in M1-S4 (keyring/signing-on-append) | Per-machine `~/.buildplane/keys/` with actor-scoped subpaths (M1 spec §"Key-management decision required before code") |
| **M1 PR merges** | Any M1 slice merge | Operator clicks merge; auto-merge label NOT applied |
| **M2 kickoff** | Starting M2-KICKOFF | Triggered after M1-GATE PASS + M2-PREP-1 snapshot lands |
| **`buildplane:auto-merge` label provisioning** | Any auto-merge candidate | Operator confirms label exists and is restricted via branch protection / CODEOWNERS (operating model §11) |
| **Branch / worktree cleanup** | Deleting any local worktree or remote branch flagged in branch-inventory snapshots | Operator approves per-branch; no batch deletion |

## 9. Exact first card to execute next

**Pick up card `M1-S3-PLAN` first**, then `M1-S3`.

The first physical step (Planner, Opus, planning session — no worker dispatch):

1. Read `docs/superpowers/specs/2026-05-22-tape-per-event-signing.md` §M1-S3 and §"Persistence model".
2. Read `native/crates/bp-ledger/src/storage/sqlite.rs` and any existing migration convention in the same module. Do not invent a migration scheme — match what is there.
3. Read `native/crates/bp-ledger/tests/append_only.rs` and `native/crates/bp-ledger/tests/round_trip.rs` to understand the existing test shape.
4. Draft `docs/superpowers/plans/<YYYY-MM-DD>-m1-s3-signature-persistence.md`: scope, files-to-change, acceptance contract, verification commands, review requirements, side-effect boundaries. Use the M1 spec §M1-S3 + this Kanban card §4.1 as the contract.
5. Commit the slice plan locally on a fresh branch named `feat/m1-s3-signature-persistence` cut from `origin/main` (`99bb8e3`). Do not push.
6. Hand off to Implementer (Sonnet) once operator confirms the slice plan looks right.

Implementer entry (Sonnet, in an isolated worktree):

1. `superpowers:test-driven-development` red phase: write the four append-only invariant tests first — update fails, delete fails, duplicate fails, missing-event-signature fails — plus the "historical unsigned event read still works" test.
2. Implement the `event_signatures` table + triggers in `sqlite.rs`.
3. Run the M1-S3 targeted gate, then the full local gate per §6.1.
4. Fill the slice receipt.
5. Hand off to the independent Reviewer (Opus, fresh session) and the Adversarial Reviewer (Codex) per §6.3. **No PR open until both verdicts land.**

## 10. Blockers / open decisions

| ID | Blocker | Owner | Resolution form |
|---|---|---|---|
| **OPERATOR-DECISION-A** | M1-S4 cannot start without key-location policy | Operator | Record "approved per-machine `~/.buildplane/keys/`" or override in §4.2 of this file |
| **AUTO-MERGE-LABEL-PROVISION** | Auto-merge candidacy across the program needs label + CODEOWNERS confirmation (operating model §11) | Operator | One-line confirmation; no M1 slice is currently blocked on this |
| **MCP optional connectors** | Slack / Google-Calendar / Vercel / `gsd-workflow` / `devbrain` are not connected | Optional | Defer until a card actually needs them; do not let them gate M1 |
| **Stale "next 7 days" list in operating-model §10** | Lists tasks 1–7 that are essentially all done | Doc Agent (next docs slice) | Out of scope for this run (single-artifact constraint). Record in §11 below; address in a separate operating-model touch-up PR after M1-GATE. |
| **Branch-inventory snapshot mainline SHA is stale** | The 2026-05-22 hygiene snapshot quotes `origin/main = 86cc2d3`; current is `99bb8e3` | M2-PREP-1 | Resolved naturally when M2-PREP-1 runs |

## 11. Follow-ups (recorded, not executed in this run)

Single-artifact constraint: this file is the only durable change in this run. The items below are recorded so a later docs slice can address them.

1. **Operating-model §10 "First concrete tasks (next 7 days)"** is now historical:
   - Item 1 (land operating-model doc): merged.
   - Item 2 (add link from `docs/architecture/README.md`): present in current README.
   - Item 3 (annotate the 2026-04-13 buildout plan as superseded): operating-model header already records the supersession; verify the banner in the 2026-04-13 plan itself when next touching it.
   - Item 4 (M0 verification slice plan): merged via #118; plan file exists at `docs/superpowers/plans/2026-05-22-m0-permissions-verification.md`.
   - Item 5 (M1 design spec): merged via #122; lives at `docs/superpowers/specs/2026-05-22-tape-per-event-signing.md`.
   - Item 6 (auto-merge probe pre-flight) and Item 7 (branch inventory): captured in `docs/superpowers/plans/2026-05-22-branch-inventory-and-auto-merge-preflight.md` (mainline SHA stale; see §10).
   - **Recommended follow-up:** a Doc Agent slice after M1-GATE rewrites §10 of the operating model to point at the current Kanban queue (this file) rather than a hard-coded task list. Do not touch §1–§8 in that same slice — keep the change minimal.
2. **Phase status table (operating-model §9)** — Phase 0 status should flip from "now" to "complete" after the M1-GATE doc slice; Phase 1 (M0) should flip to "complete".
3. **Hermes Kanban mirror surface** — operating model §8 names Hermes as a read-only mirror. The mirror does not currently subscribe to this file. A later doc/integration slice can specify the format the mirror reads (likely the §4 card list); until then, the operator views this file directly.

## 12. References

- Canonical operating model: [`docs/architecture/buildplane-agent-operating-system.md`](../architecture/buildplane-agent-operating-system.md)
- M1 signed-tape spec: [`docs/superpowers/specs/2026-05-22-tape-per-event-signing.md`](../superpowers/specs/2026-05-22-tape-per-event-signing.md)
- M0 verification plan: [`docs/superpowers/plans/2026-05-22-m0-permissions-verification.md`](../superpowers/plans/2026-05-22-m0-permissions-verification.md)
- Branch-inventory snapshot (2026-05-22, mainline SHA stale): [`docs/superpowers/plans/2026-05-22-branch-inventory-and-auto-merge-preflight.md`](../superpowers/plans/2026-05-22-branch-inventory-and-auto-merge-preflight.md)
- Slice receipt template: [`docs/operations/slice-receipt-template.md`](./slice-receipt-template.md)
- Auto-merge probe: [`scripts/ci/pr-auto-merge-eligibility.mjs`](../../scripts/ci/pr-auto-merge-eligibility.mjs)
- CI: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
- v0.5 design (lineage): [`docs/superpowers/specs/2026-05-21-buildplane-v05-design.md`](../superpowers/specs/2026-05-21-buildplane-v05-design.md)
- Superseded buildout cadence: [`docs/superpowers/plans/2026-04-13-buildplane-autonomous-buildout.md`](../superpowers/plans/2026-04-13-buildplane-autonomous-buildout.md)
