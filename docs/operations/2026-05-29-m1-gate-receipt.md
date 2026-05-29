# M1-GATE — Full M1 (per-event signing) acceptance

| | |
|---|---|
| **Status** | M1 COMPLETE |
| **Date** | 2026-05-29 |
| **Gate** | `M1-GATE` |
| **Milestone** | M1 — per-event signing |
| **Base** | `main` at `8a98ea6` |
| **Scope** | Independent confirmation of the full M1 (per-event signing) milestone gate across slices S1–S7. Docs-only receipt. |
| **Operator side effects** | Docs-only. No code, CI, fixture, or release change. No auto-merge label. Operator merges. |

## Verdict

**M1 COMPLETE** — all per-event-signing slices S1–S7 are merged to `main` at
`8a98ea6`. The canonical full gate (the `verify` job = `pnpm check`) is green on
PR #158, and the shipped external verifier produces the correct accept/reject
exit codes against the three committed fixtures on a clean `main`.

## Slice ledger

| Slice | Subject | Landed as |
|---|---|---|
| S1 | per-event signing foundation | PR #116 |
| S2 | signing append path | PR #123 |
| S3 | signature persistence | receipt `2026-05-22-m1-s3-signature-persistence-receipt.md` |
| S4 | (signing slice) | PR #150 |
| S5 | verification-on-read | PR #126 |
| S6 | tape-root checkpoints | PR #152 |
| S7 | external signed-tape verifier | PR #158 (squash `8a98ea6`) |

S7 (PR #158) is the final M1 slice; its squash merge sets `main` to `8a98ea6`,
which is the commit this gate is signed against.

## Canonical full-gate evidence (PR #158 CI)

The `verify` job is the full `pnpm check` — lint, typecheck, test, build,
`cargo test`, fixture-freshness, plus the dev-bootstrap smoke. Per the
operating-model gate §6.2, the CI `verify` job is the **canonical** full-gate
signal (CI environment over the local WSL sandbox).

`gh pr checks 158` at gate-signing time:

| Check | Status | Duration | Run |
|---|---|---|---|
| `verify` (full `pnpm check`) | **pass** | 7m53s | https://github.com/SollanSystems/buildplane/actions/runs/26645551191/job/78529999905 |
| `verify-wrong-node` | pass | 43s | https://github.com/SollanSystems/buildplane/actions/runs/26645551191/job/78529999963 |
| `Analyze (javascript-typescript)` (CodeQL) | pass | 3m53s | https://github.com/SollanSystems/buildplane/actions/runs/26645550899/job/78529999855 |
| GitGuardian Security Checks | pass | 1s | https://dashboard.gitguardian.com |

(The two Mergify advisory checks — Merge Protections, Merge Queue — were
`pending`; they are not part of the canonical full gate. The Mergify `Summary`
check was `pass`.)

The `verify` job PASS on #158 is the authoritative confirmation that the full
`pnpm check` gate holds at `8a98ea6`.

## Local clean-main confirmation (`8a98ea6`)

The shipped external verifier (`scripts/verify-signed-tape.mjs`, pure Node, no
build) was run against the three committed fixtures on a clean `main` at
`8a98ea6`. Exit codes recorded exactly as observed:

| Command | Exit | Evidence |
|---|---|---|
| `node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/valid` | `0` | All 4 events `verified`, checkpoint `root_ok`, `OK: signed tape verified`. |
| `node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/tampered` | `1` | One event `hash_mismatch`, checkpoint `root_mismatch` (expected `sha256:ada2126a…` got `sha256:11177b43…`), `FAIL: signed tape did not verify` — failed as expected. |
| `node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/bad-root` | `1` | All events `verified`, checkpoint `root_mismatch` (expected `sha256:0000…` got `sha256:ada2126a…`), `FAIL: signed tape did not verify` — failed as expected. |

`valid=0`, `tampered=1`, `bad-root=1` — the verifier accepts a well-formed
signed tape and fail-closes on both a tampered event hash and a wrong checkpoint
root, on clean `main`. This is the expected fail-closed behavior.

## Lint caveat (sandbox)

Whole-repo `pnpm lint` (`biome check .`) OOMs in the local WSL sandbox
(`Linter process terminated abnormally (possibly out of memory)` — a memory
ceiling, not a code defect; it reproduces even scoped to a couple of files). CI
is canonical and is the authority here: the `verify` job on #158 includes the
lint step and is **pass**, so the lint gate is confirmed green in CI. This
receipt adds only markdown (which Biome does not lint), so no lint signal changes.

## Unblocks

- **M2-PREP-1** — refresh the stale `2026-05-22` branch-inventory snapshot
  against current `main`.
- Which then unblocks **M2** — PlanForge consolidation.

## Side-effect boundaries honored

- Docs-only: the only file created is this receipt
  (`docs/operations/2026-05-29-m1-gate-receipt.md`).
- No code, CI, fixture, or release change.
- No push beyond the docs branch; no merge; no auto-merge label; no tag.
- No branch-protection or ruleset edits.
- All Step-1 verification was read-only (the verifier smoke and `gh pr checks`).
- The operator clicks merge — this gate receipt is not auto-merge eligible.
