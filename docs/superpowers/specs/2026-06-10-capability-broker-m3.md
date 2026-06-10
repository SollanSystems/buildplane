# M3 Capability Broker Spec

| | |
|---|---|
| **Status** | Draft implementation contract for M3 |
| **Date** | 2026-06-10 |
| **Milestone** | Buildplane v0.5 M3 — Capability broker (digest-referenced bundles, per-tool-call validation, ambient-authority removal) |
| **Owning layers** | L1 Kernel (`packages/kernel`, `packages/runtime`) · Policy/broker (`packages/capability-broker`, `packages/policy`) · Tool sandbox (`packages/adapters-tools`) · L6 PlanForge attach path (`packages/planforge`, `apps/cli`) · L0 Tape (only if new quarantine/denial event — see S5) |
| **Depends on** | M2 **complete** on `main` (M2-GATE receipt `docs/operations/2026-06-09-m2-gate-receipt.md`, merge `fd598da`); `UnitPacket.provenance_ref` wired; `capability_bundle?` / `trust_scope?` reserved as `unknown` |
| **Companion docs** | [v0.5 design §8 M3](./2026-05-21-buildplane-v05-design.md) · [operating model Phase 4](../../architecture/buildplane-agent-operating-system.md) · [planforge](../../architecture/planforge.md) · [run admission receipts](../../architecture/run-admission-receipts.md) · [M2 admit-cycle spec](./2026-05-29-planforge-m2-admit-cycle.md) |

## Goal

Ship the **capability broker** milestone: each dispatched `UnitPacket` carries a **digest-referenced `CapabilityBundleV0`**, and **every tool invocation** (`write_file`, `run_command` in v0.5 scope) is checked against that bundle **before** execution. Violations **fail closed** — no silent degrade — and produce **durable quarantine evidence** (storage + signed tape when S5 lands).

M3 removes **ambient authority** inside the worktree tool surface: the sandbox today only prevents path escape; M3 adds **allowlisted write paths** and **allowlisted commands** derived from the admitted bundle.

This milestone does **not** ship M4 acceptance-contract gating or M5 Mission Control.

## Current state (on `main`, post M2-GATE)

- **`UnitPacket`** (`packages/kernel/src/run-loop.ts`): `provenance_ref` required for PlanForge dispatch; `capability_bundle?`, `acceptance_contract?`, `trust_scope?` typed as `unknown` and unused.
- **`packages/policy`**: run-level **side-effect grants** and `architecture.diff_scope` — evaluates receipts and admission policy, **not** per-tool-call broker checks on `adapters-tools`.
- **`packages/adapters-tools`**: `resolveSandboxedPath` enforces worktree root + symlink escape; **no** bundle-driven `fs_write` globs or command allowlists.
- **PlanForge**: admit → dispatch → resume → receipt on signed tape; tasks carry `allowedSideEffects` / `forbiddenSideEffects` in the **dry-run plan JSON** but those hints are **not** turned into executable capability bundles at dispatch.
- **Dispatch signature gate**: structural `event_signatures` check at admit/dispatch (D3); **full Ed25519 byte re-verification at the gate** is explicitly deferred to M3 (optional hardening slice — see S3b).
- **M6 demo contract** (v0.5 §7): worker `fs_write` limited to `src/` + `test/`, bash limited to `npm test`, `npm run lint`, `git` — M3 must make this **enforceable**, not documentary.

## Architecture decisions (defaults for M3 — change only via operator fork)

1. **Broker home → new `packages/capability-broker`.** Pure schema, canonical digest, parse/validate, and `evaluateToolInvocation`. Keeps `packages/policy` for run-admission / diff-scope / grant receipts; broker is the **tool-call gate**.
2. **Bundle sealing → digest-referenced only (v0.5).** The bundle is a canonical JSON object; `bundle_digest = digest(bundle)` uses the same discipline as `@buildplane/planforge` (`canonicalJson` + `sha256:`). No extra crypto seal in M3.
3. **Bundle on packet → typed `CapabilityBundleV0` on `UnitPacket.capability_bundle`.** Replace `unknown` with the runtime type; optional remains optional for non-PlanForge packets until they adopt bundles.
4. **Tool surface v0 → `write_file` + `run_command` only.** Model/host tool catalogs are out of scope; broker evaluates the two tools `adapters-tools` already exposes.
5. **Quarantine evidence → new signed tape event `capability_denied` (L0).** Payload records `run_id`, `bundle_digest`, `tool`, `reason`, `target` (path or command). Reuse existing run **blocker/quarantine** export paths where they already exist; tape event is the M6 verifier story.
6. **PlanForge attach → default bundle derived from admitted plan tasks** (`allowedSideEffects` → `fs_write` globs; verification commands → `run_command` allowlist seeds). Operator may override via JSON file in a later slice; S7 ships deterministic defaults from the toy fixture shape.
7. **Dogfooding (recommended, not blocking S1):** build M3-S4+ slices through `planforge admit` when the attach path exists — records the thesis for M6.

## Non-goals for M3

Deferred to named milestones:

- **M4** — acceptance contract validator (diff-scope + CI + lint on finalize); `acceptance_contract?` stays unused except typing.
- **M5** — Mission Control / web approval inbox.
- **Network egress enforcement** — `net_egress` may appear in schema v0 as **documentation + validate-only**; kernel enforcement deferred unless a slice explicitly adds it (optional S4b).
- **Multi-tier sandbox escape detection**, host tool catalogs (Claude/Codex native tools), sealed-capability crypto.
- **Kernel orchestrator startup-scan auto-resume** (waived at M2 Gate C Path i) — not reopened in M3.
- **Memory outcome routing** — remains frozen per M2-GATE until operator reopens.

## Capability bundle schema (v0)

Wire shape `buildplane.capability_bundle.v0`:

| Field | Required | Purpose |
|---|---|---|
| `schemaVersion` | yes | literal `"buildplane.capability_bundle.v0"` |
| `bundleId` | yes | stable id (UUID or plan-scoped string) |
| `fsRead` | no | glob paths relative to worktree root (default `["**"]` when omitted for read via sandbox only) |
| `fsWrite` | no | glob allowlist for `write_file`; **empty/absent = deny all writes** once broker enforced |
| `tools.run_command.allowlist` | no | list of allowed command **prefixes** (first token match after shell split); absent = deny `run_command` |
| `tools.write_file.enabled` | no | default `true` when `fsWrite` non-empty; explicit `false` denies writes even if paths listed |

Validation rules (fail closed):

- Unknown `schemaVersion` → reject parse.
- Glob patterns must be relative (no leading `/`, no `..` segments after normalize).
- `allowlist` entries must be non-empty strings, no NUL.

Digest: `bundle_digest = digest(bundle)` via `@buildplane/planforge` canonical digest **or** re-exported shared helper from `capability-broker` (S1 must not fork digest algorithms).

## Tool invocation evaluation

Broker API (pure):

```ts
evaluateToolInvocation(
  bundle: CapabilityBundleV0,
  invocation: { tool: "write_file"; path: string } | { tool: "run_command"; command: string; args?: string[] },
  ctx: { worktreeRoot: string },
): { decision: "allow" } | { decision: "deny"; reason: string; quarantine: true }
```

Evaluation order:

1. Parse/normalize path or command relative to worktree.
2. For `write_file`: require `tools.write_file.enabled !== false` and path matches at least one `fsWrite` glob.
3. For `run_command`: require command prefix matches an `allowlist` entry (argv0 or joined prefix per implementation — **locked in S2 tests**).

## Implementation slices

Critical path: **S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8**. S5 (new tape kind) may start digest vocabulary work after S1 locks bundle canonicalization, but must not merge before S1 digest tests are on `main`.

### M3-S1 — `packages/capability-broker` schema + canonical digest + validate

Files likely to change:

- `packages/capability-broker/` (new): `src/{schema,parse,validate,digest,index}.ts`, `package.json`, `tsconfig.json`, `test/`
- `.changeset/*.md` (minor — new package)

Acceptance:

- Exports `CapabilityBundleV0`, `parseCapabilityBundle`, `validateCapabilityBundle`, `bundleDigest`.
- Digest invariant to key order; golden vector test documented.
- Invalid bundles fail with structured errors (no throw from validate — `ok: false` result type).

Verification:

```bash
pnpm -C <worktree> exec vitest run packages/capability-broker
```

Review: **L3** — single independent Reviewer (schema package only).

### M3-S2 — `evaluateToolInvocation` (pure broker)

Files:

- `packages/capability-broker/src/evaluate.ts`, `test/evaluate.test.ts`

Acceptance:

- Allow/deny matrix tests: in-scope write, out-of-scope write, allowlisted command, forbidden command, disabled write tool.
- Glob semantics documented in test names (e.g. `src/**`, `test/**`).

Verification:

```bash
pnpm -C <worktree> exec vitest run packages/capability-broker/test/evaluate.test.ts
```

Review: **L2** — 2-role (implementer + independent Reviewer).

### M3-S3 — Typed `UnitPacket.capability_bundle` + attach at PlanForge dispatch

Files:

- `packages/kernel/src/run-loop.ts`, `packages/kernel/test/packet.test.ts`
- `packages/planforge/src/bundle.ts` (default bundle builder from plan tasks)
- `apps/cli/src/run-cli.ts` (dispatch attaches bundle + `bundle_digest` on payload/metadata as spec’d)

Acceptance:

- Packets from PlanForge dispatch include a validated `CapabilityBundleV0` and stable digest.
- Non-PlanForge packets without bundle: broker not invoked (backward compatible) until opt-in.

Verification:

```bash
pnpm -C <worktree> exec vitest run packages/kernel/test/packet.test.ts packages/planforge apps/cli/test/run-cli.test.ts -t planforge
```

Review: **L1** — 2-role; + adversarial Codex if dispatch gate logic changes materially.

### M3-S3b — (optional) Full Ed25519 byte verification at dispatch gate

Files: admit/dispatch readers, `admitted-plan-reader.ts` path.

Acceptance: dispatch refuses tampered `canonical_event_bytes` before attach.

Review: **L0** if touches tape verify path.

### M3-S4 — `adapters-tools` enforces `fs_write` via broker

Files:

- `packages/adapters-tools/src/write-file.ts`, `sandbox.ts` helpers, tests

Acceptance:

- Out-of-scope write throws/rejects with broker reason; in-scope succeeds.

Verification:

```bash
pnpm -C <worktree> exec vitest run packages/adapters-tools
```

Review: **L2**.

### M3-S5 — L0 tape event `capability_denied` + TS/Rust vocabulary

Files:

- `native/crates/bp-ledger/...` (kind + payload + canonicalize)
- `packages/ledger-client` generated fixtures
- `bp-replay` exhaustive match update

Acceptance:

- Event round-trips, signs on append, verifier accepts; whole-workspace `cargo test` green.

Verification:

```bash
cargo test --manifest-path native/Cargo.toml
pnpm ledger:gen && pnpm ledger:gen-fixtures
git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
```

Review: **L0** — Opus + adversarial Codex; not auto-merge eligible.

### M3-S6 — Runtime broker hook + quarantine emit on deny

Files:

- `packages/runtime` and/or kernel tool execution path, `apps/cli` ledger emit helper

Acceptance:

- Denied tool call does not mutate filesystem; `capability_denied` appended when tape port available.

Verification:

```bash
pnpm -C <worktree> exec vitest run packages/runtime packages/kernel
```

Review: **L1** — 2-role; Codex if ledger subprocess touched.

### M3-S7 — PlanForge default bundle from admitted plan

Files:

- `packages/planforge` mapping `allowedSideEffects` / `verificationCommands` → bundle v0

Acceptance:

- Toy `goal-input.md` plan produces bundle matching M6 demo constraints (documented in test).

Verification:

```bash
pnpm -C <worktree> exec vitest run packages/planforge/test/bundle.test.ts
```

Review: **L2**.

### M3-S8 — M3-GATE: integration + receipt + docs

Files:

- `test/workflow/capability-broker-m3-gate.test.ts` (allow write in scope, deny out-of-scope, export tape optional)
- `docs/architecture/capability-broker.md` (new)
- `docs/operations/2026-06-10-m3-gate-receipt.md`

Acceptance:

- Integration test proves deny path + allow path; CI `verify` green on merge commit.

Verification:

```bash
pnpm -C <worktree> exec vitest run test/workflow/capability-broker-m3-gate.test.ts
```

Review: **L1/L2** — Opus + Codex on gate test; M3-GATE receipt.

## Full M3 gate

Before marking M3 complete:

```bash
pnpm lint        # CI verify canonical
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path native/Cargo.toml
pnpm ledger:gen-fixtures
git diff --exit-code
```

Per-slice: TDD RED → GREEN → commit; `pnpm -C <worktree> exec vitest run <paths>`; changeset when `packages/*` or `apps/*` published surface changes; conventional commits lowercase verb; L0 PRs admin-merge without `buildplane:auto-merge`.

## Review requirements (M3)

| Tier | Slices | Ceremony |
|---|---|---|
| **L0** | S5 (new tape kind); S3b if shipped | 4-role or minimum Opus + adversarial Codex per `CLAUDE.md` |
| **L1** | S3, S6 | 2-role; Codex if trust boundary changes |
| **L2** | S2, S4, S7 | 2-role |
| **L3** | S1, S8 docs-only portions | 1 independent Reviewer |

Reviewer verdict `PASS` must bind reviewed SHA to PR head.

## Memory program

Outcome routing and promotion remain **OFF** (M2-GATE freeze). M3-GATE receipt must restate freeze unless operator reopens.

## First next task

**M3-S1** — scaffold `@buildplane/capability-broker`, implement `CapabilityBundleV0`, parse/validate, and `bundleDigest` with canonical digest tests. See `docs/superpowers/plans/2026-06-10-m3-s1-capability-bundle-contract.md`.