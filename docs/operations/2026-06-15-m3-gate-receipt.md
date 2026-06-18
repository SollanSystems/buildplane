# M3-GATE — Capability broker acceptance

| | |
|---|---|
| **Status** | Gate green + code-clean review; **pending close-PR admin-merge** (CI/merge rows finalized post-merge) |
| **Date** | 2026-06-15 |
| **Gate** | `M3-GATE` |
| **Milestone** | M3 — Capability broker (digest-referenced bundles, per-tool-call validation: `write_file` + `run_command`) |
| **Close branch** | `feat/m3-s7-planforge-default-bundle` (cut from `origin/main` @ `4da9888`) |
| **Close commit** | `____` (S8 close commit on this PR) |
| **Scope** | S7 plan-level envelope + S7b run_command enforcement + S8 GATE integration test/arch doc/this receipt |

## Verdict

**M3 enforcement is COMPLETE and enforceable.** Every admitted-plan tool invocation — `write_file` **and** `run_command` — is checked against the capability bundle, fail-closed, **before** the side effect (file write / process spawn). The full M3 gate is green and an independent adversarial review found **no reachable bypass of any deny the broker promises**.

The milestone-close ceremony is closed by this receipt + the CLAUDE.md milestone-map update committed alongside it. (The GATE review's two `FAIL` criteria were the *absence* of exactly those two artifacts; both are resolved by the S8 close commit.)

## Slice ledger

| Slice | Subject | Landed as |
|---|---|---|
| S1 | `@buildplane/capability-broker` — schema / parse / validate / digest | PR #185 (spec+plan #184) |
| S2 | `evaluateToolInvocation` (allow/deny decision; argv0+prefix allowlist, glob `fsWrite`, fail-closed) | PR #186 → `4da9888` (receipt **backfilled** `docs/operations/2026-06-10-m3-s2-evaluate-tool-invocation-slice-receipt.md`) |
| S3–S6 | attach per-task bundle at dispatch · enforce `write_file` · `capability_denied` tape · runtime deny-emit hook | PR #187 → `80be820` |
| — | version packages | PR #188 → `49153c4` |
| S7 | PlanForge plan-level capability **envelope** (sorted union of per-task bundles) | this PR — `d9fccd4` (+ review-response `6d40d57`); receipt `2026-06-15-m3-s7-plan-bundle-slice-receipt.md` |
| S7b | `run_command` allowlist enforcement on the tool surface (gap-closure) | this PR — `89bd765`; receipt `2026-06-15-m3-s7b-run-command-enforcement-slice-receipt.md` |
| S8 | M3-GATE: allow/deny integration test · architecture doc · this receipt · CLAUDE.md close | this PR — `b314b65` (test), `7b897cd` (arch doc) |

## Full-gate evidence

Run `2026-06-15` on close branch (`pnpm -C <worktree> …`; lint is CI-`verify`-canonical per the biome-OOM trap):

```
native:build (cargo -p bp-cli)        OK
typecheck (tsc --build)               OK
vitest run (full suite)               177 files / 1245 tests passed · 1 skipped · 0 failed
cargo test (whole native workspace)   OK · 0 failed across all crates
build (tsc --build)                   OK
git diff --exit-code generated/fixtures   clean (no Rust payload change)
```

Gate script + log: `/tmp/m3-gate-verify.sh` → `GATE-RESULT: PASS (all steps green)`. The `published-bootstrap-stage` snapshot test passed inside the suite; the CI `verify` job (runtime-closure assertion, capability-broker vendored via #187) is the canonical closure check on the PR.

## Acceptance evidence

`test/workflow/capability-broker-m3-gate.test.ts` proves, through the **real** `createToolRegistry` over the toy `goal-input.md` plan's validated envelope:

- `write_file docs/generated-note.md` → **allow** (file written); `write_file src/secret.ts` → **deny** (no file, quarantine hook fired `{tool:"write_file", target:"src/secret.ts"}`).
- `run_command git status --short` → **allow**; `run_command curl http://evil.example` → **deny** (never spawned — broker short-circuits before `spawnSync`).

S7 unit tests additionally prove: envelope = sorted union of per-task bundles (independently derived, no dropped task); empty plan → deny-all shape; deterministic digest equal to the broker's `bundleDigest` (no forked algorithm).

## Review ceremony (S7 L2 + S8 GATE)

- **S7 (L2, 2-role):** independent reviewer (fresh-context) **PASS** on `d9fccd4`; acceptance verifier raised R-001 (empty-plan coverage) + R-002 (tautological union test), both **fixed** in review-response `6d40d57`. The one verifier criterion marked FAIL ("TDD RED not provable from a single green commit") was dispositioned as a process-evidence note (RED watched in-session; repo squash-merges) — not a code defect.
- **S7b + S8 (GATE, L1/L2 — Opus + adversarial pass over the full S7+S7b+S8 diff):** independent multi-lens review (Opus adversarial-bypass · Opus correctness/regression · Sonnet acceptance-checklist · Opus synthesis with adversarial re-judgement).
  - **Code verdict: PASS.** The bypass lens found **no reachable deny-bypass**: `run-command.ts` consults the broker as its first statement and returns before any `spawnSync` on deny; `index.ts` threads one `toolOpts` to **both** `write_file` and `run_command` (the genuine S7b fix); the plan-level union emits only bounded globs and `evaluate.ts` rejects absolute/`..` paths before globbing; the live `apps/cli` dispatch path (`toolRegistryOptionsForPacket`) does forward the dispatched packet's bundle to `run_command`.
  - **Confirmed nits (dismissed as blockers, carried forward):** (1) **argv0-only allowlist ceiling** — the toy plan allowlists `git`/`pnpm`, both of which can launch arbitrary subprocesses via their own argv (`git -c core.pager=…`, `pnpm dlx …`); this is the **locked S2 grain** (argv0 + space-prefix; finer argv policy out of scope), documented in `docs/architecture/capability-broker.md`, and is **not** a failure of any deny the code claims to make (spawns run without `shell:true`, so command-string metacharacter injection is neutralized) — but it caps the guarantee and must be tightened (or paired with a `net_egress` deny) when the M4 `code-edit` vocabulary slice adds real build/test commands. (2) test files are excluded from `tsc --build`, so test type-assignability isn't statically checked (production code is fully in-graph and clean).
  - **Adversarial-Codex note:** the adversarial role was fulfilled by an independent Opus red-team bypass lens; the Codex CLI was not invoked this pass (mirrors the M2-GATE precedent where Codex was quota-limited and the gate proceeded on Opus + parent adjudication). Adding the literal Codex pass is an available, non-blocking follow-up.

## Memory program freeze (restated)

Outcome routing and memory-promotion expansions remain **OFF / opt-in / default-OFF** — `run_outcomes` has **no consumer**; main behavior is byte-for-byte unchanged. The freeze holds **until the operator explicitly reopens it**; the planned single rent-paying integration is feeding `run_outcomes` into **M4** acceptance/trust scoring. M3 did not touch this surface.

## Deferred (tracked, non-blocking)

- **Side-effect vocabulary** — `PLANFORGE_ALLOWED_SIDE_EFFECTS` has no `code-edit`/`packages/**` kind, so an admitted plan cannot authorize editing source. Extending it (`code-edit` → `src/**`/`test/**`) is the natural M4-adjacent unblocker for real `planforge admit` **dogfooding** (open fork) — and is where the argv0-ceiling tightening should land.
- **Full Ed25519 byte re-verification at the dispatch gate** (spec S3b, optional hardening) — not shipped; structural `event_signatures` check stands.
- **`net_egress` enforcement** — schema-v0 documentation/validate-only; kernel enforcement deferred.
- **argv0-only `run_command` ceiling** (above) and **test-file `tsc` coverage** — review nits, deferred.

## PR gate

- PR: **draft**, single M3-close PR (S7 + S7b + S8). Base `main`, head `feat/m3-s7-planforge-default-bundle`.
- L1/L2 — **operator admin-merge**; no `buildplane:auto-merge` label.

## CI evidence (finalized post-merge)

| Check | Status | Run URL |
|---|---|---|
| `verify` (PR head) | pending | `____` |
| `Analyze (javascript-typescript)` | pending | `____` |
| Mergify Merge Protections | pending | `____` |

Post-merge `main` CI on the squash commit is the canonical ongoing-health gate.
