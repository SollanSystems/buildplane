# M3-S2 — evaluateToolInvocation slice receipt

| | |
|---|---|
| **Status** | Backfill — slice merged 2026-06-10 without a receipt; documented during M3-GATE prep |
| **Date** | 2026-06-10 (merged); receipt backfilled 2026-06-15 |
| **Slice** | M3-S2 |
| **Landed as** | PR #186 → `main` (squash `4da9888`) |
| **Branch** | `feat/m3-s2-evaluate-tool-invocation` |

## Why this is a backfill

S2 (`evaluateToolInvocation`, PR #186) merged ahead of the S3–S6 train without its own slice receipt. The M3-S7/S8 close-out plan (Task 6) called for backfilling it so the milestone ledger is complete. The semantics documented here are the **locked S2 contract** that S3–S7b enforcement and the M3-GATE integration test all depend on — recorded here verbatim so the gate's "every tool invocation is checked against the bundle" claim rests on a written contract.

## Scope

`packages/capability-broker/src/evaluate.ts` (104 lines) — `evaluateToolInvocation(bundle, invocation, ctx)` returning an `allow`/`deny` decision for the two enforced tool surfaces (`write_file`, `run_command`). No tool wiring (S4/S7b), no kernel attach (S3). Pure decision function over a validated `CapabilityBundleV0`.

## Locked semantics (the contract S3–S8 enforce)

- **Fail-closed everywhere.** Any missing/empty capability field denies rather than allows: no `fsWrite` globs → `write_file` deny (`evaluate.ts:79-80`); no `run_command.allowlist` → `run_command` deny (`evaluate.ts:95-96`); unknown tool / malformed invocation → deny. There is no allow-by-default branch.
- **`write_file` — glob path match.** The target path is matched against the bundle's `fsWrite` globs (minimatch). **Absolute paths and `..`-escapes are rejected before globbing** (`evaluate.ts:25-34`), so a glob can never be defeated by an out-of-worktree or traversal path; `validateCapabilityBundle` additionally rejects `..` inside the bundle's own globs.
- **`run_command` — argv0 + space-prefix allowlist.** `commandMatchesAllowlist` (`evaluate.ts:48-67`) matches the command's first token (argv0) against each allowlist entry: exact equality, or an `"<entry> "` space-prefix. Argument vectors are **not** inspected (`_args` ignored). This is the deliberately narrow, locked grain — finer-than-argv0 argument policy is explicitly out of scope for M3.
  - **Known ceiling (carried to M4):** an allowlisted interpreter (`git`, `pnpm`) can launch arbitrary subprocesses via its own argv (`git -c core.pager=…`, `pnpm dlx …`), so for shell-capable allowlisted binaries the allowlist gates *which binary*, not *what it does*. Spawning runs without `shell:true`, so command-string metacharacter injection is neutralized, but the interpreter ceiling stands. Documented in `docs/architecture/capability-broker.md`; tightening it (or pairing it with a `net_egress` deny) is an M4-adjacent follow-up that lands with the `code-edit` side-effect-vocabulary slice.

## Verification

```bash
pnpm -C <worktree> exec vitest run packages/capability-broker/test/evaluate.test.ts   # allow/deny matrix, fail-closed defaults
pnpm -C <worktree> exec vitest run packages/capability-broker                          # whole-package green
```

`evaluate.test.ts` (3.7K) covers: in-scope `write_file` allow, out-of-scope deny, absolute/`..`-path deny, allowlisted-command allow, non-allowlisted deny, empty-allowlist/empty-glob deny-all.

## Review

Tier **L2** (broker decision logic, no L0/tape surface). Merged as part of the S1–S6 review train; the locked semantics were independently re-verified during the M3-GATE adversarial pass (`docs/operations/2026-06-15-m3-gate-receipt.md`) — the bypass lens confirmed no reachable deny-bypass and confirmed the argv0 ceiling as documented-and-intended, not a hole.

## Next slice

M3-S3 — attach the per-task `CapabilityBundleV0` to `UnitPacket` at dispatch (least privilege).
