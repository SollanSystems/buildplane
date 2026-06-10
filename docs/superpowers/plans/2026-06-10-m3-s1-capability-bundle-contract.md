# M3-S1 — `packages/capability-broker` schema + canonical digest + validate

> **For agentic workers:** Use subagent-driven development or executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `@buildplane/capability-broker` with runtime `CapabilityBundleV0`, strict parse/validate (fail closed), and `bundleDigest` using the **same canonical digest discipline** as PlanForge — no tool enforcement yet (S2+).

**Architecture:** New leaf package under `packages/capability-broker`. Digest reuses `@buildplane/planforge` `canonicalJson` / `digest` (workspace dependency) to avoid a second canonicalization algorithm. Validate returns `Result` types, not throws, for broker callers.

**Tech Stack:** TypeScript (pnpm workspace, ESM), Vitest, Biome. Dependency: `@buildplane/planforge` (digest only in S1).

**Spec:** `docs/superpowers/specs/2026-06-10-capability-broker-m3.md` (M3-S1 section).

---

## Context the implementer must hold

- **L3 slice** — no tape writes, no kernel wiring, no adapter changes.
- **Do not** implement `evaluateToolInvocation` (S2).
- **Do not** change `UnitPacket` types yet (S3).
- Mirror package layout from `packages/policy` / `packages/planforge` (`package.json`, `tsconfig.json`, `exports`).

Read before coding:

- `packages/planforge/src/digest.ts` — import `digest` / `canonicalJson` from `@buildplane/planforge`.
- `docs/superpowers/specs/2026-06-10-capability-broker-m3.md` — schema table + validation rules.
- `packages/planforge/package.json` — workspace `name`, `exports`, `scripts` pattern.

---

## File structure

| File | Action |
|---|---|
| `packages/capability-broker/package.json` | Create (`@buildplane/capability-broker`) |
| `packages/capability-broker/tsconfig.json` | Create |
| `packages/capability-broker/src/schema.ts` | `CapabilityBundleV0` + tool sub-shapes |
| `packages/capability-broker/src/parse.ts` | JSON → unknown → typed narrow |
| `packages/capability-broker/src/validate.ts` | `validateCapabilityBundle` → `{ ok: true, bundle } \| { ok: false, errors }` |
| `packages/capability-broker/src/digest.ts` | `bundleDigest(bundle)` → `digest(bundle)` |
| `packages/capability-broker/src/index.ts` | Public exports |
| `packages/capability-broker/test/{schema,parse,validate,digest}.test.ts` | Unit tests |
| `.changeset/*.md` | Minor — new published workspace package |

---

## Task 1: Scaffold package + smoke test

- [ ] **Step 1:** Copy manifest/tsconfig pattern from `packages/planforge`; set `"name": "@buildplane/capability-broker"`, depend on `@buildplane/planforge": "workspace:*"`.
- [ ] **Step 2:** `src/index.ts` exports `CAPABILITY_BUNDLE_SCHEMA_VERSION` constant only initially.
- [ ] **Step 3:** Failing test imports `validateCapabilityBundle`:

```ts
import { describe, expect, it } from "vitest";
import { validateCapabilityBundle } from "../src/index.js";

describe("capability-broker smoke", () => {
  it("exports validateCapabilityBundle", () => {
    expect(typeof validateCapabilityBundle).toBe("function");
  });
});
```

- [ ] **Step 4:** Run — expect FAIL:

```bash
pnpm -C packages/capability-broker exec vitest run test/smoke.test.ts
```

- [ ] **Step 5:** `pnpm install` at repo root if workspace does not resolve the new package.

---

## Task 2: Schema types

- [ ] **Step 1:** Implement `schema.ts` with `CAPABILITY_BUNDLE_SCHEMA_VERSION = "buildplane.capability_bundle.v0"` and interfaces matching the M3 spec table (`bundleId`, optional `fsRead`, `fsWrite`, `tools.write_file`, `tools.run_command.allowlist`).
- [ ] **Step 2:** Test asserts version constant and that a minimal valid object type-checks in a fixture helper.

---

## Task 3: Parse + validate (fail closed)

- [ ] **Step 1:** `parse.ts` — accept `unknown`, require plain object, `schemaVersion` exact match, string `bundleId`, optional arrays with element type checks.
- [ ] **Step 2:** `validate.ts` — glob rules: relative only, reject `..` escape after normalize; allowlist entries non-empty; return `{ ok: false, errors: string[] }` for all failures.
- [ ] **Step 3:** Tests:

| Case | Expect |
|---|---|
| Minimal valid bundle | `ok: true` |
| Wrong schemaVersion | `ok: false` |
| Absolute glob `/etc/**` | `ok: false` |
| `..` in glob | `ok: false` |
| Empty allowlist string | `ok: false` |

```bash
pnpm -C packages/capability-broker exec vitest run test/parse.test.ts test/validate.test.ts
```

---

## Task 4: Canonical bundle digest

- [ ] **Step 1:** `digest.ts` — `bundleDigest(bundle: CapabilityBundleV0): string` delegates to `digest` from `@buildplane/planforge`.
- [ ] **Step 2:** Test key-order invariance (same as planforge digest test).
- [ ] **Step 3:** Golden vector — freeze one bundle JSON + expected `sha256:` hex in test (document in slice receipt).

```bash
pnpm -C packages/capability-broker exec vitest run test/digest.test.ts
```

---

## Task 5: Wire exports + full package test run

- [ ] **Step 1:** `index.ts` exports schema types, `parseCapabilityBundle`, `validateCapabilityBundle`, `bundleDigest`, constant.
- [ ] **Step 2:** Smoke test passes.
- [ ] **Step 3:** Add `.changeset` minor for `@buildplane/capability-broker`.
- [ ] **Step 4:** Scoped typecheck:

```bash
pnpm exec tsc --build packages/capability-broker/tsconfig.json --pretty false
pnpm -C packages/capability-broker exec vitest run
```

---

## Task 6: Commit discipline

- [ ] Conventional commits (lowercase verb), e.g.:
  - `feat(capability-broker): scaffold package (M3-S1)`
  - `feat(capability-broker): add bundle schema parse validate`
  - `feat(capability-broker): bundle digest via planforge canonical`
  - `chore: changeset for capability-broker`
- [ ] Slice receipt: `docs/operations/2026-06-10-m3-s1-capability-bundle-contract-slice-receipt.md` (use template) before PR.
- [ ] Open PR from `feat/m3-s1-capability-broker` cut from `origin/main` after spec PR merges (or stack on `feat/m3-spec` if operator prefers single train).

---

## Out of scope (S1)

- `evaluateToolInvocation` (S2)
- `UnitPacket` typing (S3)
- `adapters-tools` / ledger / PlanForge dispatch
- `capability_denied` event (S5)

---

## Verification summary (slice gate)

```bash
pnpm -C <worktree> exec vitest run packages/capability-broker
pnpm exec tsc --build packages/capability-broker/tsconfig.json --pretty false
```

CI `verify` is canonical for full monorepo gate before merge.