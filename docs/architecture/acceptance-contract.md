# Acceptance contract (M4)

Reference for Buildplane's acceptance contract — the per-task finalization gate that
admits a worker's result only when its diff stays in scope **and** its checks pass, before
the worktree is merged. Link, don't narrate.

## What it is

Each dispatched PlanForge task derives a deterministic **`AcceptanceContractV0`** (diff-scope
globs + check commands). At finalization — **after execution, before merge** — the kernel
runs the checks in the worktree, evaluates the verdict, appends a **signed
`acceptance_recorded` L0 event**, and only then merges (on pass) or quarantines (on reject).
Rejections **fail closed**: the worktree is never merged and is preserved as the quarantine
artifact. The gate turns the M6 demo's "advance only when reality matches the contract" from
*documentary* into *enforceable*. It is **opt-in** (`--enforce-acceptance`): default dispatch
is byte-for-byte unchanged.

## Packages

| Package | Role |
|---|---|
| `@buildplane/planforge` | derives `AcceptanceContractV0` + `contract_digest` from an admitted plan/task |
| `@buildplane/policy` | pure `evaluateAcceptanceContract` (diff-scope + check results) + `evaluateAcceptanceDiffScope`; `RejectedPolicyDecision{kind:"acceptance.contract"}` |
| `@buildplane/kernel` | finalization gate in `runPacketAsync`; `BuildplaneAcceptancePort` / evidence port; `trustGates.acceptanceContract` |
| `apps/cli` | per-task contract derivation, `profileRegistry` + `policyProfile` wiring, `emitAcceptanceRecorded` |
| `bp-ledger` (`acceptance.rs`) | L0 `acceptance_recorded` payload (`AcceptanceRecordedV1`) |

## Contract schema v0 — `AcceptanceContractV0`

| Field | Purpose |
|---|---|
| `contract_version` | literal `"v0"` |
| `diff_scope.allowed_globs` | write globs a worker's diff must stay inside (least-privilege) |
| `diff_scope.denied_globs` | optional explicit deny globs |
| `checks[].command` | independent worktree check commands; each must exit 0 |

`acceptanceContractDigest(contract)` is the canonical `sha256:` content address via the
**same** `canonicalJson` digest as `planDigest` / `bundleDigest` — no forked algorithm. The
signed event carries this digest so replay can reconstruct and re-verify the contract from
`plan_admitted`.

## Derivation from an admitted plan (`deriveAcceptanceContract(plan, task)`)

Derived deterministically from the same admitted plan shape the capability broker uses, so
the acceptance scope == the capability-write scope:

- `diff_scope.allowed_globs` = the task's `capability_bundle.fsWrite` (`buildDefaultCapabilityBundleForTask`'s globs — `local-doc`→`docs/**`, etc.).
- `checks` = the task's `verificationCommands`, order-preserved and de-duplicated.

PlanForge stays a zero-dependency leaf — its `AcceptanceContractV0` is structurally
compatible with (not imported from) the kernel type.

## Pure evaluation (`@buildplane/policy`)

`evaluateAcceptanceContract(contract, evidence)` is a pure function over
`{changedFiles, checkResults}`, returning a `RejectedPolicyDecision{kind:"acceptance.contract"}`
or `null` (pass):

- **diff-scope** reuses `evaluateArchitectureDiffScope` — a changed file outside
  `allowed_globs` (or inside `denied_globs`) blocks.
- **checks** — any `checkResults` entry with a non-zero `exitCode` blocks.

`evaluateAcceptanceDiffScope(changedFiles, contract)` returns the structured
`{status, outOfScopeFiles}` recorded on the signed event, using the same matcher so the
recorded `out_of_scope_files` equal what the gate blocked on.

## Finalization gate — Point A (`runPacketAsync`)

The gate sits in `evaluateAndRecordAcceptanceAsync`, called inside the retry loop **after
`executeOnceWithChangedFiles`, before `policy.evaluateRun` → `finalizeRun` → `commitAndMergeWorkspace`**.
The worktree is still alive, so a rejection never touches the project root — fail-closed for
free. Per task, when a contract is resolved for the packet:

1. Collect each `contract.checks[].command` via the `acceptanceEvidencePort`
   (`collectAcceptanceCheckResults` shells the commands in the worktree), yielding
   `{command, exitCode}`.
2. **Re-collect changed files _after_ the checks ran.** A check (e.g. a `--fix` or a snapshot
   update) can mutate the worktree; those files must be in the diff-scope decision or an
   out-of-scope write could merge on a zero exit. This re-collection is the load-bearing
   reason the gate runs checks before diffing.
3. Evaluate `evaluateAcceptanceContract`; compute the structured diff-scope.
4. Emit the signed `acceptance_recorded` verdict via the `acceptancePort` (`flush`ed —
   write-ahead, **before** any merge or quarantine).
5. **passed →** proceed to the existing `finalizeRun → commitAndMergeWorkspace`.
6. **rejected →** `finalizeRun` with the pre-evaluated `RejectedPolicyDecision{acceptance.contract}`
   (reuses the proven reject short-circuit — no merge), **worktree preserved** (no
   `deleteWorkspace`) as the quarantine artifact. The dispatch loop breaks on the first
   non-passed task (same chain-break rule as plan dispatch).

## L0 signed event — `acceptance_recorded`

`AcceptanceRecordedV1` (`plan_id`, `admission_event_id`, `contract_digest`, `outcome`,
`diff_scope_status`, `out_of_scope_files`, `checks[]`, `evaluated_at`): a signed, append-only
record of the finalization verdict. Every numeric field is a **String** on the wire (the
U64 → TS-`number` hazard); a check's `status` is `passed` iff its `exit_code` is `0`. Added in
M4-S2 (round-trips, signs on append, verifier accepts; `bp-replay` match stays exhaustive).
The event chains to the signed `plan_admitted` via `admission_event_id`.

### Write-ahead ordering

The verdict is appended **and signed before** the workspace is merged or quarantined — the
same write-ahead discipline as M2's `activity_started`. Recording the verdict is a hard gate:
if the `acceptancePort` throws, the run is finalized as an `acceptance-record-failed`
infrastructure failure with the worktree retained — the run never escapes unfinalized.

## Reject → quarantine flow

A rejected run is **not** a crash: the signed `acceptance_recorded{rejected}` is durable, the
`RejectedPolicyDecision` is recorded, the project root is untouched, and the worktree survives
under `.buildplane/workspaces/<runId>` carrying the offending diff for inspection. No
`plan_receipt` reports `completed`.

## HEAD-advance fail-closed guard

The diff-scope arm diffs against the worktree `HEAD`. A worker — or an unsandboxed check —
that `git commit`s inside the detached worktree advances `HEAD`, so `git diff HEAD` reports an
empty diff and a committed (possibly out-of-scope) delta would merge on a zero exit. The gate
compares the **current worktree HEAD against the immutable recorded base SHA** and rejects
fail-closed on any advance (recording `diff_scope_status:"blocked"`), independent of the
check exits. The recorded base SHA is the only trustworthy anchor. (A null HEAD — worktree not
a readable git repo — is already fail-closed by `collectWorkspaceChangedFiles` returning a
`diff-unavailable` out-of-scope sentinel; this guard closes the distinct readable-but-moved
bypass.)

## Opt-in posture (`--enforce-acceptance`)

The gate is **fail-open-when-unconfigured, fail-closed-when-configured**. With no
`trustGates.acceptanceContract` resolved for the packet, `evaluateAndRecordAcceptanceAsync`
returns `null` with no side effects — main dispatch is byte-for-byte unchanged. `apps/cli`
opts a run in with `planforge dispatch --enforce-acceptance`: it derives one contract per task,
exposes each through a per-task `PolicyProfile` (`planforge-<planId>-<taskId>`) in a
`profileRegistry`, routes each packet under its profile name, and wires the `acceptancePort` to
`emitAcceptanceRecorded` over the signed tape. A freshly-created worktree has no installed
dependencies, so the toy plan's `pnpm`-family checks cannot run there yet — hence opt-in, not
default; provisioning worktree dependencies so real checks run on every dispatch is a later
slice.

## Known follow-up

- **The sync `runPacket` path is unguarded.** `evaluateAcceptanceBeforeFinalization` (sync) has
  no `acceptancePort` write-ahead and no HEAD-advance guard. This is **not reachable today** —
  PlanForge dispatch routes through `runPacketAsync` **only** (the sync path is confirmed not
  load-bearing for PlanForge). Bringing the sync path to parity is deferred until a non-async
  caller needs the gate.
- Worktree dependency provisioning (so real checks run on every dispatch, removing the
  `--enforce-acceptance` opt-in).
- Feeding `run_outcomes` into acceptance/trust scoring — the designated first rent-paying
  consumer that unfreezes the memory program (a later M4 slice, out of M4 core scope).

## See also

- Spec: `docs/superpowers/specs/2026-06-18-m4-acceptance-contract-design.md`
- Slice receipts: `docs/operations/2026-06-19-m4-s1-acceptance-finalization-gate-slice-receipt.md`,
  `docs/operations/2026-06-19-m4-s2-acceptance-recorded-slice-receipt.md`; S3 changesets
  `.changeset/m4-s3-finalization-gate.md`, `.changeset/m4-s3-head-advance-fail-closed.md`.
- GATE test: `test/workflow/acceptance-contract-m4-gate.test.ts`
- Capability broker (shared diff-scope derivation): `docs/architecture/capability-broker.md`
- Tape / digest contracts: `docs/ledger.md`, `CLAUDE.md` §"L0 trust surface"
