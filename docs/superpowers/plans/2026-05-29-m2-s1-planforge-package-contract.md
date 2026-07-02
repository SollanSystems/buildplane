# M2-S1 — `packages/planforge` extraction + runtime contract + canonical digest

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the shipped PlanForge dry-run (`compile → validate → preview`) out of `apps/cli/src/run-cli.ts` into a new, unit-testable `packages/planforge` package; promote `PlanForgeInput` and the full (non-preview) `PlanForgeReceipt` to exported runtime types; and replace the non-canonical `JSON.stringify` plan digest with a stable canonical serializer shared with the signed tape path — **without changing dry-run behavior**, with the golden fixture (`apps/cli/test/fixtures/planforge/expected-plan.json`) as the behavioral lock.

**Architecture:** A new workspace package `@buildplane/planforge` owns the schema (constants + interfaces, incl. the two newly-promoted runtime types) and the three pure stages. The CLI `planforge dry-run` handler becomes a thin caller that imports the package; `apps/cli/src/planforge-schema.ts` re-exports from the package so existing importers keep compiling. The one intended behavior change is the digest: `planDigest`/`inputDigest` move to a canonical serializer (frozen key order, matching `bp-ledger`'s `canonicalize.rs` discipline), which changes the pinned digest in the golden fixture exactly once — documented in the slice receipt with the prior↔new values.

**Tech Stack:** TypeScript (pnpm workspace, ESM), Vitest, Biome. No new runtime deps; the canonical serializer is a small in-package helper (deterministic key-sorted JSON → `node:crypto` SHA-256).

---

## Context the implementer must hold

This is an **L6 slice, not an L0 slice** — it adds no signing and writes no tape. It is a refactor + type promotion + one isolated digest change. The trust surface (signed `plan_admitted`/`plan_receipt`) arrives in S2/S3; S1's only job is to make the contract clean and the digest signable.

Read these live before moving anything — move the **real** code, do not re-derive it:

- **The dry-run pipeline** (`apps/cli/src/run-cli.ts:5531` `createPlanForgeDryRunPlan`): compile via `sectionText`/`listValue` (`:5480`), the forbidden-intent guard `hasForbiddenPlanForgeGoalIntent` (`:5510`), the five validation checks, and the `receiptPreview` assembly (`:5732–5755`). Note the hardcoded stubs that **stay** in dry-run: `generatedAt` (`:5741`), `dryRun:true` (`:5742`), `sideEffects:[]` (`:5743`), `admittedBy:"buildplane-kernel"` (`:5740`) — S1 does not unstub these (that is S3/S6). `inputEvidenceName = basename(inputPath)` (`:5536`) feeds the idempotency key; preserve it exactly.
- **The schema** (`apps/cli/src/planforge-schema.ts`): exported constants `PLANFORGE_VALIDATION_STATUSES`, `PLANFORGE_REQUIRED_EVIDENCE`, `PLANFORGE_TASK_IDS`, `PLANFORGE_ALLOWED_SIDE_EFFECTS`, `PLANFORGE_FORBIDDEN_SIDE_EFFECTS`, and interfaces `PlanForgeValidationCheck`, `PlanForgeValidation`, `PlanForgeTask`, `PlanForgeReceiptPreview`, `PlanForgePlan`. `PlanForgeInput` and the full `PlanForgeReceipt` are **doc-only today** (`docs/architecture/planforge.md:113–205`) — S1 promotes them to runtime types matching that doc shape.
- **The golden fixture** (`apps/cli/test/fixtures/planforge/expected-plan.json`) and `apps/cli/test/planforge-schema.test.ts`: the behavioral lock. The only field allowed to change is the digest (Task 4), and only with a documented one-time fixture update.
- **A package shape to mirror**: `packages/policy/{package.json,tsconfig.json,src/index.ts}` (a simple existing leaf package) — copy its `package.json` name scope, `exports`, `scripts`, and `tsconfig` extends shape; do not invent a new layout.

**Design decision (load-bearing — do not "simplify" away):** the canonical digest helper must be deterministic regardless of object key insertion order (sort keys recursively before serializing) so the digest that S2/S3 sign is reproducible across Rust and TS. Prove this with a key-reordering test, not just a snapshot.

**Out of scope (record, do not silently drop):** unstubbing `dryRun`/`sideEffects`/`generatedAt`/`admittedBy` (S3/S6); any tape/signing wiring (S2/S3); dynamic task generation beyond the existing `PF1`/`PF2` (later). S1 keeps dry-run output identical except the digest.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `packages/planforge/package.json` | New `@buildplane/planforge` package manifest (mirror `packages/policy`) | Create |
| `packages/planforge/tsconfig.json` | Extends `tsconfig.base.json` like sibling packages | Create |
| `packages/planforge/src/schema.ts` | All PlanForge constants + interfaces; **adds** runtime `PlanForgeInput` + full `PlanForgeReceipt` | Create (moved) |
| `packages/planforge/src/digest.ts` | `canonicalJson(value)` + `digest(value): "sha256:<hex>"` — key-sorted, deterministic | Create |
| `packages/planforge/src/{compile,validate,preview}.ts` | The three stages lifted from `createPlanForgeDryRunPlan` | Create (moved) |
| `packages/planforge/src/index.ts` | Public surface: `compile`, `validate`, `preview`, `createPlanForgeDryRunPlan`, all schema types | Create |
| `packages/planforge/test/{schema,digest,dry-run}.test.ts` | Package-local unit tests incl. digest-determinism | Create |
| `apps/cli/src/planforge-schema.ts` | Re-export from `@buildplane/planforge` (back-compat shim) | Modify |
| `apps/cli/src/run-cli.ts` | `planforge dry-run` handler delegates to the package; dead local helpers removed | Modify |
| `apps/cli/test/fixtures/planforge/expected-plan.json` | One-time digest update (Task 4) | Modify |
| `pnpm-workspace.yaml` / root `tsconfig.json` | Register the new package if globs don't already cover `packages/*` | Modify (only if needed) |
| `.changeset/*.md` | Minor — new package surface | Create |

---

## Task 1: Scaffold `@buildplane/planforge` and prove it builds + imports

**Files:** Create `packages/planforge/{package.json,tsconfig.json,src/index.ts,test/smoke.test.ts}`

- [ ] **Step 1: Read the template** — open `packages/policy/package.json` and `packages/policy/tsconfig.json`. Mirror the `name` scope (`@buildplane/policy` → `@buildplane/planforge`), `type`, `exports`/`main`, `scripts`, and `tsconfig` `extends`.
- [ ] **Step 2: Create the manifest + tsconfig** with no dependencies beyond what `policy` declares (workspace `*` + the base toolchain). `src/index.ts` starts as `export {};`.
- [ ] **Step 3: Write a failing smoke test** `packages/planforge/test/smoke.test.ts` importing a not-yet-existent symbol:

```ts
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

describe("@buildplane/planforge", () => {
  it("exports compile", () => {
    expect(typeof compile).toBe("function");
  });
});
```

- [ ] **Step 4: Run it — expect FAIL** (`compile` not exported):

```bash
pnpm -C packages/planforge exec vitest run test/smoke.test.ts
```

- [ ] **Step 5: Confirm workspace registration** — `pnpm install` resolves `@buildplane/planforge`; if `pnpm-workspace.yaml`'s `packages/*` glob already covers it, no edit is needed. Do not commit yet (Task 3 makes the smoke test pass).

## Task 2: Move the schema + promote `PlanForgeInput` and full `PlanForgeReceipt`

**Files:** Create `packages/planforge/src/schema.ts`; Modify `apps/cli/src/planforge-schema.ts`

- [ ] **Step 1: Move** every export currently in `apps/cli/src/planforge-schema.ts` into `packages/planforge/src/schema.ts` verbatim (constants + interfaces).
- [ ] **Step 2: Add the two promoted runtime types** matching `docs/architecture/planforge.md:113–205`: `PlanForgeInput` (with `schemaVersion: "planforge.input.v0"`, `goal`, `repository`, `constraints`, `evidence`, `idempotencyKey`) and the full `PlanForgeReceipt` (`schemaVersion: "planforge.receipt.v0"`, all receipt fields — superset of `PlanForgeReceiptPreview`). Keep `PlanForgeReceiptPreview` as-is for the dry-run path.
- [ ] **Step 3: Turn `apps/cli/src/planforge-schema.ts` into a re-export shim**: `export * from "@buildplane/planforge";` (or named re-exports if the CLI relies on a narrower surface). No importer of the old path should break.
- [ ] **Step 4: Port the schema test** — copy `apps/cli/test/planforge-schema.test.ts`'s assertions into `packages/planforge/test/schema.test.ts` (constants match the golden values). Keep the original CLI test green via the shim.
- [ ] **Step 5: Run both — expect PASS:**

```bash
pnpm -C packages/planforge exec vitest run test/schema.test.ts
pnpm -C apps/cli exec vitest run test/planforge-schema.test.ts
```

## Task 3: Move compile / validate / preview; CLI delegates

**Files:** Create `packages/planforge/src/{compile,validate,preview}.ts`, `src/index.ts`; Modify `apps/cli/src/run-cli.ts`

- [ ] **Step 1: Lift the stage code** from `createPlanForgeDryRunPlan` (`run-cli.ts:5531`) and its helpers (`sectionText`/`listValue` `:5480`, `hasForbiddenPlanForgeGoalIntent` `:5510`) into the package: `compile.ts` (markdown → parsed input + `inputEvidenceName` basename anchor), `validate.ts` (the five checks → `PlanForgeValidation`), `preview.ts` (assemble `PlanForgePlan` with the **unchanged** stubs `dryRun:true`/`sideEffects:[]`/`admittedBy`/`generatedAt`). Re-export a `createPlanForgeDryRunPlan(input, opts)` from `index.ts` with the same signature the CLI calls.
- [ ] **Step 2: Make the CLI delegate** — in `run-cli.ts`, replace the inlined pipeline with a call into `@buildplane/planforge`; delete the now-dead local helpers. Leave the `:3454` subcommand gate and the `--write/--execute/--admit` block **exactly as-is** (S3 touches them, not S1).
- [ ] **Step 2a:** the package compile/validate/preview functions must accept the input path basename so `inputEvidenceName = basename(inputPath)` (`:5536`) is preserved — the idempotency key depends on it. Thread it through; do not re-derive it differently.
- [ ] **Step 3: Smoke test now passes** — `compile` is exported (Task 1 Step 3 goes green).
- [ ] **Step 4: Golden-fixture parity** — run the existing CLI dry-run test; output must equal `expected-plan.json` **except** the digest fields, which Task 4 handles. If anything other than the digest differs, the move was lossy — fix the port:

```bash
pnpm -C apps/cli exec vitest run test/run-cli.test.ts -t planforge
```

## Task 4: Canonical, signable plan digest (the one intended behavior change)

**Files:** Create `packages/planforge/src/digest.ts`, `packages/planforge/test/digest.test.ts`; Modify the preview path + `expected-plan.json`

- [ ] **Step 1: Write `digest.ts`** — `canonicalJson(value)` recursively sorts object keys and serializes deterministically; `digest(value) = "sha256:" + sha256(utf8(canonicalJson(value)))` via `node:crypto`. This mirrors `bp-ledger` `canonicalize.rs` discipline (frozen ordering) so an S2 `plan_admitted` can sign the same bytes.
- [ ] **Step 2: Write a determinism test** `digest.test.ts` proving key order does not matter:

```ts
import { describe, expect, it } from "vitest";
import { digest } from "../src/digest.ts";

describe("canonical digest", () => {
  it("is invariant to object key order", () => {
    expect(digest({ a: 1, b: { c: 2, d: 3 } })).toBe(digest({ b: { d: 3, c: 2 }, a: 1 }));
  });
});
```

- [ ] **Step 3: Replace the `JSON.stringify` digest** (`run-cli.ts:5752`, now in `preview.ts`) — compute `inputDigest`/`planDigest` via `digest(...)` over the canonical input/plan-minus-receiptPreview. Keep the `idempotencyKey` derivation otherwise unchanged.
- [ ] **Step 4: One-time golden update** — the pinned `planDigest`/`inputDigest` in `expected-plan.json` change. Recompute, update the fixture, and **record the prior `sha256:d73b27…`/`sha256:1a2924…` → new values in the slice receipt** with a one-line rationale (canonicalization). No other fixture field changes.
- [ ] **Step 5: Run the package + CLI dry-run tests — expect PASS:**

```bash
pnpm -C packages/planforge exec vitest run
pnpm -C apps/cli exec vitest run test/run-cli.test.ts -t planforge test/planforge-schema.test.ts
```

## Task 5: Full gate, changeset, slice receipt

**Files:** Create `.changeset/<slug>.md`, `docs/operations/2026-05-29-m2-s1-planforge-package-receipt.md`

- [ ] **Step 1: Changeset** — `pnpm changeset` (minor; new `@buildplane/planforge` package + CLI internal refactor). Lowercase summary.
- [ ] **Step 2: Full gate** (CI `verify` job is canonical; `biome check .` OOMs locally — record that caveat, do not block on it):

```bash
pnpm typecheck
pnpm -C packages/planforge exec vitest run
pnpm -C apps/cli exec vitest run test/run-cli.test.ts test/planforge-schema.test.ts
pnpm build
# pnpm lint  -> CI-canonical (WSL OOM); note exit status from CI, not local
```

- [ ] **Step 3: Slice receipt** — fill `docs/operations/slice-receipt-template.md` as `…m2-s1-planforge-package-receipt.md`: slice id `M2-S1`; commands above + exit codes; files changed; the prior↔new digest values + rationale; "no L0 surface → single reviewer" note; out-of-scope follow-ups (unstubbing, tape wiring → S3/S6).
- [ ] **Step 4: Commit** (atomic, lowercase verb):

```bash
git add packages/planforge apps/cli/src/planforge-schema.ts apps/cli/src/run-cli.ts apps/cli/test/fixtures/planforge/expected-plan.json .changeset docs/operations/2026-05-29-m2-s1-planforge-package-receipt.md
git commit -m "feat(planforge): M2-S1 extract packages/planforge + runtime contract + canonical digest"
```

> **Push/PR:** route through a fresh subagent (whole-repo `biome check .` OOMs in the orchestrator session); solo PR needs admin-merge; the operator clicks merge.

---

## Review & side-effect boundaries (M2-S1 — L6, no signing)

- **Independent Reviewer (Opus, fresh session)** verdict `PASS` — different context than the implementer. Focus: was the dry-run pipeline moved faithfully (no lost validation/forbidden-intent guard), is the shim non-breaking, is the digest change isolated and fixture-documented?
- **No adversarial Codex reviewer required** — S1 adds no signing/verification/key/checkpoint behavior (that gate begins at S2).
- **No** push, PR open, merge, branch-protection/label edits, or `.github/`/release-plumbing changes from inside this slice — operator clicks merge.
- **Auto-merge:** not from the orchestrator. Treat as standard (non-L0) — single reviewer + admin-merge.
- Reviewed SHA must equal the PR head SHA at merge.

## Self-review (completed against the M2 spec §M2-S1)

- **Spec coverage:** ✅ new `packages/planforge` with `PlanForgeInput`/`PlanForgePlan`/full `PlanForgeReceipt` runtime types (Tasks 1–2); ✅ dry-run output equals the golden fixture except a documented one-time digest update (Tasks 3–4); ✅ canonical serializer shared with the signed path (Task 4).
- **Behavioral lock:** the existing CLI dry-run + schema tests stay green throughout via the re-export shim; the only intended diff is the digest, proven canonical by a key-reordering test (not a bare snapshot).
- **Placeholder scan:** none — every task carries an exact file set, command, and expected pass/fail.
- **Boundary fidelity:** the `:3454` subcommand gate and the `--write/--execute/--admit` block are untouched (S3 owns them); the four hardcoded stubs remain stubbed (S3/S6 own them); `inputEvidenceName = basename` is preserved so the idempotency key is stable.
