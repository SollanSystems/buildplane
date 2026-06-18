# Capability broker (M3)

Reference for Buildplane's capability broker — the per-tool-call authority gate that
removes ambient authority from the worktree tool surface. Link, don't narrate.

## What it is

Each dispatched `UnitPacket` carries a **digest-referenced `CapabilityBundleV0`**, and
**every tool invocation** (`write_file`, `run_command` in v0.5 scope) is checked against
that bundle **before execution**. Violations **fail closed** — no silent degrade — and
produce durable quarantine evidence (a signed `capability_denied` tape event when a tape
port is present). The broker turns the M6 demo's worker constraints from *documentary*
into *enforceable*.

## Packages

| Package | Role |
|---|---|
| `@buildplane/capability-broker` | pure schema, canonical digest, parse/validate, `evaluateToolInvocation` |
| `@buildplane/planforge` | derives the default bundle from an admitted plan (per-task + plan-level) |
| `@buildplane/kernel` | `UnitPacket.capability_bundle` typed + validated at `parseUnitPacket` |
| `@buildplane/adapters-tools` | enforces the bundle on the real tool surface (`write_file` + `run_command`) |
| `apps/cli` | attaches the bundle at dispatch; wires the `capability_denied` tape emit |
| `bp-ledger` (`capability_broker.rs`) | L0 `capability_denied` payload (`CapabilityDeniedV1`) |

## Bundle schema v0 — `buildplane.capability_bundle.v0`

| Field | Required | Purpose |
|---|---|---|
| `schemaVersion` | yes | literal `"buildplane.capability_bundle.v0"` (unknown → reject parse) |
| `bundleId` | yes | stable id (plan-scoped) |
| `fsRead` | no | read globs (sandbox-only today) |
| `fsWrite` | no | `write_file` glob allowlist; **empty/absent = deny all writes** |
| `tools.write_file.enabled` | no | explicit `false` denies writes even if `fsWrite` listed |
| `tools.run_command.allowlist` | no | allowed command prefixes; **absent = deny `run_command`** |

Validation (`validateCapabilityBundle`, fail-closed): globs must be relative with no `..`
segments; allowlist entries non-empty, no NUL. `validate` returns a result type
(`{ok:false; errors}`), never throws.

## Digest discipline

`bundleDigest(bundle)` re-exports `@buildplane/planforge`'s canonical digest
(`canonicalJson` + `sha256:`) — the **same** discipline used for `planDigest` /
`inputDigest`. No forked algorithm, no extra crypto seal in M3 (sealing is
digest-reference only). Plan-level envelopes sort their `fsWrite` / `allowlist` arrays so
the digest is invariant to task order.

## Evaluation semantics (`evaluateToolInvocation`)

Returns `{decision:"allow"}` or `{decision:"deny"; reason; quarantine:true}`.

- **`write_file`**: deny if `tools.write_file.enabled === false`, or `fsWrite` empty, or the
  worktree-relative path escapes root, or it matches no `fsWrite` glob (`minimatch`, `dot:true`).
- **`run_command`**: deny if `tools.run_command.allowlist` is empty, or the command matches
  no entry. Match = argv0 equality **or** exact / `"${entry} "`-prefix on the trimmed command
  (locked in M3-S2 tests).

## Bundle derivation from an admitted plan (`@buildplane/planforge`)

Mapping from the admitted plan's task hints:

- `allowedSideEffects` → `fsWrite` globs (`local-doc`→`docs/**`; `local-fixture`→`apps/cli/test/fixtures/**`, `packages/**/test/fixtures/**`; `local-receipt`→`docs/operations/**`).
- `verificationCommands` → `run_command.allowlist` (argv0 of each command).

Two builders:

- **`buildDefaultCapabilityBundleForTask(plan, task)`** (M3-S3) — `bundleId = ${plan.id}:${task.id}`. **Attached per-`UnitPacket` at dispatch** = least privilege: each task's worker gets only its own task's capabilities.
- **`buildDefaultCapabilityBundleForPlan(plan)`** (M3-S7) — `bundleId = plan.id`; the deterministic sorted **union** of every task's bundle. The auditable run-wide **envelope** ("what can this plan's workers touch in aggregate") used by the M3 GATE integration test and the M6 demo narrative. An empty plan yields a deny-all envelope.

Operator JSON override of the default is deferred to a later slice; M3 ships deterministic defaults from the plan shape.

## Enforcement on the tool surface (`@buildplane/adapters-tools`)

`createToolRegistry(worktreeRoot, {capabilityBundle, onCapabilityDenied})` scopes both tools
to a worktree and runs the broker **before** the side effect:

- `writeFile` (M3-S4) — broker before sandbox path resolution; deny → structured error, no
  file written, `onCapabilityDenied` fired.
- `runCommand` (M3-S7b) — broker before `spawnSync`; deny → structured error, **never
  spawned**, `onCapabilityDenied` fired.

`onCapabilityDenied` is wired by `apps/cli` (`toolRegistryOptionsForPacket`) to
`emitCapabilityDenied` → a signed `capability_denied` tape event carrying `run_id`,
`bundle_digest`, `tool`, `reason`, `target`. The tape event is the M6 verifier story.

## L0 quarantine event — `capability_denied`

`CapabilityDeniedV1` (`bundle_digest`, `tool`, `reason`, `target`, `run_id`): a signed,
append-only record of a fail-closed denial. Added in M3-S5 (round-trips, signs on append,
verifier accepts; `bp-replay` match stays exhaustive). The `tool` field is a free string
covering both `write_file` and `run_command`.

## M6 demo constraints — interpretation

v0.5 §7's "`fs_write` ⊂ `src/`+`test/`, bash ⊂ `npm test`/`npm run lint`/`git`" is the
*illustration* of the enforceability the broker provides. The toy `goal-input.md` plan is
doc-oriented (`local-doc`/`local-fixture`/`local-receipt`; `git`/`pnpm`) — there is no
`code-edit` side-effect kind in `PLANFORGE_ALLOWED_SIDE_EFFECTS`. So the M3 GATE proves the
*principle* on the real fixture: a worker is fail-closed-confined to exactly the admitted
plan's declared write paths and command families.

## Deferred (not in M3)

- **Side-effect vocabulary** (`code-edit`→`src/**`/`test/**`): would let admitted plans
  authorize code edits — and unblocks genuine `planforge admit` dogfooding of code-editing
  slices.
- Full Ed25519 byte re-verification at the dispatch gate (S3b, optional).
- `net_egress` enforcement (schema/validate-only in v0).
- Operator JSON bundle override; host/model tool catalogs; sealed-capability crypto.

## See also

- Spec: `docs/superpowers/specs/2026-06-10-capability-broker-m3.md`
- v0.5 design §8 M3: `docs/superpowers/specs/2026-05-21-buildplane-v05-design.md`
- GATE receipt: `docs/operations/2026-06-15-m3-gate-receipt.md`
- Tape / digest contracts: `docs/ledger.md`, `CLAUDE.md` §"L0 trust surface"
