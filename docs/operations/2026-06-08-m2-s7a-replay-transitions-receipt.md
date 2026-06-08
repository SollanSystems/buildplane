# M2-S7a slice receipt — replay engine PlanForge cycle transitions

Evidence packet for the M2-S7a Rust replay-transition slice. Per `docs/operations/slice-receipt-template.md`.

## Slice identity

- Slice id: M2-S7a
- Milestone: M2 (PlanForge admission cycle)
- Goal: Teach `bp-replay` to reconstruct PlanForge admission-cycle state from signed tape events: `plan_admitted`, `activity_started`, `activity_completed`, and `plan_receipt`.
- Non-goals: production kernel startup/resume; CLI `buildplane resume`; TypeScript crash harness changes; new ledger event kinds; fork/VCR expansion; default-strategy recovery.
- Operator approval scope: L0 replay-surface slice under the M2 S7a boundary; no S7b implementation.
- Steward / agent: DWF-managed Buildplane slice.
- Started at: 2026-06-08 (DWF run)
- Completed at: 2026-06-08T13:24:37Z (PR #177 merged)

## Source of truth

- Base branch: `main`
- Base SHA: `fb86c82c6b1615e8d5df8a2b73eae7232b09135c` (origin/main after PR #176 version package merge at S7a draft-PR receipt time)
- Source docs / specs read: `docs/superpowers/specs/2026-05-29-planforge-m2-admit-cycle.md`, `CLAUDE.md`, S7-HARNESS plan/tests.
- Related issue / task / board item: M2 critical path S7a.
- Prior prerequisite PRs verified on `origin/main`: S7-HARNESS PR #174 merged at `5e1a0fbf70e2bc3bedebb3cc3d59c88e1bdc3a4d`; PR #176 release/versioning merged at `fb86c82c6b1615e8d5df8a2b73eae7232b09135c`.

## Workspace

- Worktree path: `/mnt/c/Dev/projects/buildplane-dwf-m2-s7-harness`
- Branch: `feat/m2-s7a-replay-transitions-dwf`
- Local HEAD SHA: `af227609e9d3b6b9b9e344a840c9071e472d5798`
- Remote branch SHA: `af227609e9d3b6b9b9e344a840c9071e472d5798` before merge; upstream gone after merge.
- Git identity verified: `Sollan Systems <khall0239@gmail.com>` in DWF draft-PR receipt.
- `core.filemode=false` verified: not reconstructed in this docs pass.
- Clean status before work: fresh DWF worktree from `origin/main`.
- Clean status after commit: DWF draft-PR receipt showed clean branch at `af227609e9d3b6b9b9e344a840c9071e472d5798`.

## Scope

- Files changed:
  - `native/crates/bp-replay/src/lib.rs`
  - `native/crates/bp-replay/src/state.rs`
  - `native/crates/bp-replay/src/transitions.rs`
  - `native/crates/bp-replay/tests/planforge_cycle.rs`
  - `native/crates/bp-replay/tests/transitions.rs`
- Diff stat: not reconstructed in this receipt; GitHub PR file list confirms five files.
- Added dependencies: none.
- Data migrations / durable schema changes: none.
- Tool / workflow permission changes: none.
- Deployment / publish / release side effects: none; GET-only deployment probe for PR head was empty in DWF draft-PR receipt.
- Secret-shaped added lines scan: PASS in DWF draft-PR receipt.

## Verification

Record commands exactly as run/recovered from the DWF draft-PR receipt and PR body.

- Focused tests: `cargo test --manifest-path native/Cargo.toml -p bp-replay -- --nocapture` — PASS.
- Package / area tests: `cargo test --manifest-path native/Cargo.toml -p bp-fork -- --nocapture` — PASS.
- Typecheck: n/a for Rust replay crate; native build below.
- Lint / format: `rustfmt --edition 2021 --check native/crates/bp-replay/src/lib.rs native/crates/bp-replay/src/state.rs native/crates/bp-replay/src/transitions.rs native/crates/bp-replay/tests/transitions.rs native/crates/bp-replay/tests/planforge_cycle.rs` — PASS.
- Build: `pnpm native:build` — PASS.
- Full-suite check, if run: `cargo test --manifest-path native/Cargo.toml` — PASS (native workspace) in DWF draft-PR receipt.
- Isolated reruns for flaky / timeout failures: none recorded.
- Direct CLI smoke / manual probe: real SQLite `ReplayEngine` PlanForge-cycle tests added in `native/crates/bp-replay/tests/planforge_cycle.rs`.
- Forbidden literal / ambient-authority grep: staged added-content secret-shape scan — PASS in DWF draft-PR receipt.

### Cross-language / digest (L0 ledger, signing, replay, digest slices)

- `u64` → TS `string` boundary verified: n/a — no new signed payload/wire field.
- Canonical digest byte-stability: n/a — no digest/canonicalization change.
- Ledger fixture freshness: n/a — no payload/typeshare change.
- Whole-workspace `cargo test` for enum-variant slices: PASS (`cargo test --manifest-path native/Cargo.toml`) to catch downstream match breaks.

## Review gate

### Ceremony tier

- Tier: `L0` (replay surface) — Opus + adversarial Codex required by CLAUDE.md.
- Roles satisfied: implementer TDD self-verify; independent spec review `PASS`; independent quality/security review `APPROVED` per DWF receipt `/home/khall/.hermes/profiles/auto-coder/workflows/buildplane-dwf-steward/runs/20260608T014327Z-s7a-draft-pr/receipt.json`. GitHub native reviewDecision later remained empty, so these are workflow-review receipts rather than GitHub approval objects.
- Tier justification: a broken replay transition can make signed-tape recovery reconstruct the wrong PlanForge phase or consume invalid activity results.

- Review task id / reviewer: DWF reviewers recorded in `20260608T014327Z-s7a-draft-pr/reviewer-reports.json`.
- Reviewed commit SHA: `af227609e9d3b6b9b9e344a840c9071e472d5798`
- Current PR head SHA: `af227609e9d3b6b9b9e344a840c9071e472d5798`
- Verdict: `PASS`
- Significant issues found: minor duplicate/orphan activity behavior risk.
- Issues reconciled by follow-up commit SHA: included in reviewed head `af227609e9d3b6b9b9e344a840c9071e472d5798` via focused tests for orphan and duplicate `activity_completed` behavior.
- Review notes / link: https://github.com/SollanSystems/buildplane/pull/177

## PR gate

- PR URL: https://github.com/SollanSystems/buildplane/pull/177
- PR number: 177
- Draft state: `true` at DWF draft-PR receipt; later `false` at post-merge readback.
- Base branch: `main`
- Head branch: `feat/m2-s7a-replay-transitions-dwf`
- Head SHA: `af227609e9d3b6b9b9e344a840c9071e472d5798`
- Merge state: merged externally after the stopped steward window.
- Review decision: empty in GitHub readback; workflow reviews recorded separately.
- Auto-merge opt-in label present: not reconstructed.
- Required auto-merge label: n/a; steward did not perform the merge.
- Required checks observed: `verify`, `verify-wrong-node`, CodeQL `Analyze (javascript-typescript)`, GitGuardian, Summary, and Mergify Merge Protections success in post-merge readback.
- Advisory checks observed: Mergify Merge Queue remained in-progress after merge.
- Deployment objects from GET-only probe: none for PR head in DWF draft-PR receipt; later stopped-state receipts found zero deployments for head/merge/main.
- Auto-merge eligibility result: not reconstructed.
- Auto-merge decision: no steward merge command was run; PR #177 merge was observed as external during stopped-state receipts.

## Post-merge verification

- Merge method: squash/merge via GitHub PR merge, exact method not reconstructed.
- Merge commit SHA: `93b5eaf40fee6d7540c5b65414e314816725a7d3`
- `origin/main` SHA after fetch: `93b5eaf40fee6d7540c5b65414e314816725a7d3`
- `origin/main` contains merge commit: yes; `origin/main` equals the merge commit.
- Default-branch CI: stopped-state DWF receipts found default-branch `release`, `verify`, `verify-wrong-node`, and CodeQL `Analyze` check-runs completed success.
- Deployment objects after merge: stopped-state DWF receipts found zero deployments for PR head, merge SHA, and `main` ref.
- Remote feature branch still exists: no; local branch upstream is gone in later worktree readback.
- Local worktree retained / removed: retained at `/mnt/c/Dev/projects/buildplane-dwf-m2-s7-harness` during 2026-06-08 reconciliation.
- Cleanup explicitly approved: no; cleanup remains separately gated.

## Exceptions / caveats

- This receipt was added retroactively because PR #177 did not include a `docs/operations` slice receipt.
- PR #177 deliberately did **not** implement S7b production kernel resume or change the TypeScript crash harness behavior.
- Duplicate `activity_completed` events keep the last recorded result, and orphan `activity_completed` events create a partial activity entry; S7b recovery must validate admissibility before consuming recorded completions.
- GitHub native reviews only show a Copilot `COMMENTED` review and empty `reviewDecision`; the L0 review evidence lives in DWF receipts, not GitHub review approval state.

## Next gate

- Next allowed action: M2-S7b — kernel crash recovery startup scan / resume / skip-reinvocation, fresh from `origin/main@93b5eaf40fee6d7540c5b65414e314816725a7d3` after this docs reconciliation lands or is consciously skipped.
- Actions explicitly not authorized: cleanup of stale worktrees/branches without explicit cleanup approval; auto-merge of S7b; widening S7b into default-strategy recovery or new wire-event work without plan/review.
- Fresh context required before continuing: re-ground from live `origin/main`, the M2 spec S7b lines 273-291, and the S7a orphan/duplicate admissibility caveat.
