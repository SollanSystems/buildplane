# M2-S2 — Admission-cycle + activity tape event vocabulary (Rust + TS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four signed L0 tape event kinds — `plan_admitted`, `plan_receipt`, `activity_started`, `activity_completed` — to the `bp-ledger` Rust spine and its hand-maintained TypeScript mirror, so PlanForge admission/receipt and Temporal-style activity bracketing have a verifiable wire vocabulary; and fold the three M2-S1 review nits into the first task.

**Architecture:** Each new kind follows the established `bp-ledger` add-event-kind procedure: `EventKind` variant → versioned payload struct (`#[typeshare]`) → `Payload` enum arm → `canonicalize.rs` kind↔variant arms → typeshare regen → hand-edited `packages/ledger-client/src/payload.ts` union → deterministic fixture in `gen_fixtures.rs` → drift-test update. Sign-on-append and external-verifier coverage are proven by extending the M1-S7 signed-tape fixture generator with a `plan-cycle/` variant that `scripts/verify-signed-tape.mjs` validates end-to-end. Task 1 first hardens the freshly-landed `@buildplane/planforge` package (the S1 nits) since S2's events sign digests that package produces.

**Tech Stack:** Rust (serde, serde_json, typeshare, sha2, ed25519-dalek), TypeScript (pnpm workspace ESM, Vitest), Biome. No new dependencies.

---

## Context the implementer must hold

This is an **L0 trust-surface slice**. The four kinds become signable, replayable wire events. Get the wire shapes right: later slices (S3 admit, S5 activity bracketing, S6 receipt, S7 replay) build directly on these structs and CANNOT change them without a tape migration. **Round-trip + canonicalize + sign-on-append + external-verifier validation are the acceptance bar — not just "it compiles."**

Read these live before writing — mirror the **real** patterns, do not invent:

- **The add-event-kind procedure, fully**: `native/crates/bp-ledger/src/kind.rs` (the `EventKind` enum, `as_wire()`, and the two test arrays — both must list every new kind), `native/crates/bp-ledger/src/payload/mod.rs` (`pub mod` declarations + the externally-tagged `Payload` enum), `native/crates/bp-ledger/src/canonicalize.rs` (the `payload_variant_name` and `kind_to_variant` match arms — both must gain an arm per kind), `native/crates/bp-ledger/src/payload/run_lifecycle.rs` (the **closest struct template** — `RunAdmissionRecordedV1` + its `RunAdmissionDecision` enum show the exact derive/typeshare/serde discipline), and `native/crates/bp-ledger/src/payload/unit_lifecycle.rs` (shows `serde_json::Value` fields with `PartialEq`-only derives, and `#[serde(rename_all = "snake_case")]` enums).
- **The generators**: `native/crates/bp-ledger/src/bin/gen_fixtures.rs` (hand-authored one-fixture-per-variant; deterministic ids via `fixed_event_id`/`fixed_run_id`, NO `EventId::new()`/`Utc::now()`) and `native/crates/bp-ledger/src/bin/gen_signed_tape.rs` (M1-S7 signed-tape fixtures; `covered_events()` + `checkpoint_event()` + `sign_event(...)` + `tape_root_hash(...)`).
- **The TS mirror + drift alarm**: `packages/ledger-client/src/payload.ts` (hand-written externally-tagged union — typeshare cannot express it) and `packages/ledger-client/test/payload-drift.test.ts` (hardcodes `fixtures.length` and an exhaustive `switch` whose `never` default fails CI if a Rust variant lacks a TS case).
- **The integration-test template**: `native/crates/bp-ledger/tests/run_admission.rs` (round-trip, fail-closed serialization, `canonicalize_payload(kind, 1, json)`, and `canonical_event_bytes(&event)` assertions) and `native/crates/bp-ledger/tests/signing_on_append.rs` (sign-on-append pattern).
- **The M2 spec**: `docs/superpowers/specs/2026-05-29-planforge-m2-admit-cycle.md` §"Tape event vocabulary" (field lists) and §"Review requirements" (S2 is L0 → 2 reviewers, NOT auto-merge eligible).

**Design decisions (load-bearing — do not "simplify" away):**

- All four payloads carry **no per-payload `schema_version` field** — versioning lives on the `Event` envelope, matching every existing payload.
- `activity_completed.result` is `serde_json::Value` (opaque recorded model/tool/command output) → its struct derives `PartialEq` but **not** `Eq` (serde_json::Value is not `Eq`), exactly like `UnitStartedV1.policy`.
- Typed ids where the codebase already does: `run_id: RunId`, `admission_event_id: EventId` (mirroring `UnitFailedV1.terminating_event_id`). Plan/activity ids are free-form `String` (`plan_id`, `activity_id`). All digests are `String` in `sha256:<hex>` form. Timestamps are RFC3339 `String` (`decided_at`), matching `RunAdmissionRecordedV1`.
- Closed enums get `#[serde(rename_all = "snake_case")]` and `Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize`, matching `CancelCause`/`UnitOutcome`.

**Out of scope (record, do not silently expand):** no admit/dispatch/receipt/replay wiring (S3–S7); no kernel or CLI changes; no emit-path code. S2 is **vocabulary only** — the structs, their canonicalization, their fixtures, and proof they sign + verify. The `result`/`side_effects` semantics are exercised by fixtures, not by a live producer.

## File structure

| File | Responsibility | Action |
|---|---|---|
| `packages/planforge/src/index.ts` | Drop internal parse helpers from the public surface (S1 nit 1) | Modify |
| `packages/planforge/src/preview.ts` | Comment the deliberate idempotencyKey `JSON.stringify` exception (S1 nit 2) | Modify |
| `packages/planforge/src/digest.ts` | Harden `canonicalJson` against top-level `undefined` (S1 nit 3) | Modify |
| `packages/planforge/test/surface.test.ts` | Assert public surface + no leaked internals | Create |
| `packages/planforge/test/digest.test.ts` | Add undefined-coercion cases | Modify |
| `native/crates/bp-ledger/src/kind.rs` | 4 new `EventKind` variants + `as_wire` + 2 test arrays | Modify |
| `native/crates/bp-ledger/src/payload/plan_lifecycle.rs` | `PlanAdmittedV1`, `PlanReceiptRecordedV1`, `PlanReceiptOutcome` | Create |
| `native/crates/bp-ledger/src/payload/activity.rs` | `ActivityStartedV1`, `ActivityCompletedV1`, `ActivityType` | Create |
| `native/crates/bp-ledger/src/payload/mod.rs` | 2 `pub mod` + 4 `Payload` enum arms | Modify |
| `native/crates/bp-ledger/src/canonicalize.rs` | 4 `payload_variant_name` + 4 `kind_to_variant` arms | Modify |
| `native/crates/bp-ledger/tests/plan_lifecycle.rs` | round-trip + canonicalize + canonical-bytes for the 2 plan kinds | Create |
| `native/crates/bp-ledger/tests/activity.rs` | round-trip + canonicalize + canonical-bytes for the 2 activity kinds | Create |
| `native/crates/bp-ledger/src/bin/gen_fixtures.rs` | 4 deterministic fixture entries | Modify |
| `native/crates/bp-ledger/src/bin/gen_signed_tape.rs` | `plan-cycle/` valid signed-tape variant containing all 4 kinds | Modify |
| `packages/ledger-client/src/generated/index.ts` | typeshare output (regenerated, not hand-edited) | Regenerate |
| `packages/ledger-client/src/payload.ts` | 4 imports + 4 union arms | Modify |
| `packages/ledger-client/fixtures/payload-variants.json` | regenerated (16→20 entries) | Regenerate |
| `test/fixtures/signed-tape/plan-cycle/tape.json` | regenerated signed-tape fixture | Regenerate |
| `packages/ledger-client/test/payload-drift.test.ts` | length 16→20 + 4 switch cases + presence assertions | Modify |
| `.changeset/*.md` | patch — `@buildplane/ledger-client` wire surface + `@buildplane/planforge` nit fixes | Create |
| `docs/operations/2026-05-30-m2-s2-tape-event-vocabulary-receipt.md` | slice receipt | Create |

**Branch:** `feat/m2-s2-tape-event-vocabulary`, cut from current `origin/main` (`5ac26d0`, which already contains `@buildplane/planforge`).

---

## Task 1: Fold the three M2-S1 review nits into `@buildplane/planforge`

S2's `plan_admitted`/`plan_receipt` events sign digests this package produces, so clean it first. Three isolated fixes; the dry-run golden fixture (`apps/cli/test/fixtures/planforge/expected-plan.json`) MUST stay byte-identical (real inputs are never top-level `undefined`).

**Files:** Modify `packages/planforge/src/{index,preview,digest}.ts`; Create `packages/planforge/test/surface.test.ts`; Modify `packages/planforge/test/digest.test.ts`

- [ ] **Step 1: Write the failing surface test** — `packages/planforge/test/surface.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as planforge from "../src/index.ts";

describe("@buildplane/planforge public surface", () => {
	it("exposes the stage + digest API", () => {
		for (const name of [
			"compile",
			"validate",
			"preview",
			"createPlanForgeDryRunPlan",
			"canonicalJson",
			"digest",
		]) {
			expect(typeof (planforge as Record<string, unknown>)[name]).toBe(
				"function",
			);
		}
	});

	it("does NOT leak internal parse helpers", () => {
		for (const internal of [
			"hasLine",
			"listValue",
			"sectionText",
			"hasForbiddenPlanForgeGoalIntent",
		]) {
			expect(internal in planforge).toBe(false);
		}
	});
});
```

- [ ] **Step 2: Run it — expect FAIL** (internals currently leak):

Run: `pnpm -C packages/planforge exec vitest run test/surface.test.ts`
Expected: FAIL — `hasLine in planforge` is `true`.

- [ ] **Step 3: Trim the public surface** — in `packages/planforge/src/index.ts`, replace the two re-export blocks so only the public API is surfaced. The helpers stay `export function` in `compile.ts`/`validate.ts` (so `preview.ts`'s `import { hasLine } from "./compile.js"` and any direct-path unit test keep working) — they are simply no longer re-exported from the package entrypoint:

```ts
export { compile, type PlanForgeCompileResult } from "./compile.js";
export { canonicalJson, digest } from "./digest.js";
export { preview } from "./preview.js";
export * from "./schema.js";
export { validate, type PlanForgeValidateResult } from "./validate.js";
```

(Remove `hasLine`, `listValue`, `sectionText` from the `./compile.js` re-export and `hasForbiddenPlanForgeGoalIntent` from the `./validate.js` re-export. Leave `createPlanForgeDryRunPlan` and its imports untouched.)

- [ ] **Step 4: Run surface test — expect PASS:**

Run: `pnpm -C packages/planforge exec vitest run test/surface.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Comment the deliberate idempotencyKey exception** — in `packages/planforge/src/preview.ts`, immediately above the `const fingerprintInput = JSON.stringify({` line (~L24), add:

```ts
	// Deliberate exception to the M2-S1 canonical-digest migration: the
	// idempotencyKey fingerprint MUST stay byte-identical to the pre-extraction
	// derivation, so it keeps insertion-order JSON.stringify over this
	// hand-ordered object rather than the canonical digest() helper. Switching
	// to digest() would silently rotate every plan's idempotencyKey. Do not "fix".
```

- [ ] **Step 6: Write failing digest-coercion tests** — append to `packages/planforge/test/digest.test.ts`:

```ts
it("canonicalJson coerces unsupported top-level values to null", () => {
	expect(canonicalJson(undefined)).toBe("null");
});

it("digest does not throw on top-level undefined (coerced to null)", () => {
	expect(() => digest(undefined)).not.toThrow();
	expect(digest(undefined)).toBe(digest(null));
});
```

(Ensure `canonicalJson` is in the existing import from `../src/digest.ts`.)

- [ ] **Step 7: Run them — expect FAIL** (`digest(undefined)` throws today):

Run: `pnpm -C packages/planforge exec vitest run test/digest.test.ts`
Expected: FAIL — `hash.update(undefined)` throws / `canonicalJson(undefined)` is `undefined`.

- [ ] **Step 8: Harden `canonicalJson`** — in `packages/planforge/src/digest.ts`, coerce the `undefined` that `JSON.stringify` returns for top-level `undefined`/function/symbol:

```ts
export function canonicalJson(value: unknown): string {
	// JSON.stringify returns undefined for a top-level undefined/function/symbol;
	// coerce to "null" so digest() never throws on hash.update(undefined).
	return JSON.stringify(canonicalize(value)) ?? "null";
}
```

- [ ] **Step 9: Run package tests — expect PASS:**

Run: `pnpm -C packages/planforge exec vitest run`
Expected: PASS (all files incl. surface + digest).

- [ ] **Step 10: Prove the dry-run golden fixture is unchanged** (behavioral lock — no digest rotation for real inputs):

Run: `pnpm -C apps/cli exec vitest run test/run-cli.test.ts -t planforge test/planforge-schema.test.ts`
Expected: PASS — `expected-plan.json` untouched.

- [ ] **Step 11: Commit:**

```bash
git add packages/planforge/src/index.ts packages/planforge/src/preview.ts packages/planforge/src/digest.ts packages/planforge/test/surface.test.ts packages/planforge/test/digest.test.ts
git commit -m "fix(planforge): fold M2-S1 review nits — trim public surface, comment idempotency exception, harden canonicalJson"
```

## Task 2: Rust — `plan_admitted` + `plan_receipt` payloads

**Files:** Create `native/crates/bp-ledger/src/payload/plan_lifecycle.rs`; Modify `native/crates/bp-ledger/src/payload/mod.rs`, `native/crates/bp-ledger/src/kind.rs`, `native/crates/bp-ledger/src/canonicalize.rs`; Create `native/crates/bp-ledger/tests/plan_lifecycle.rs`

- [ ] **Step 1: Create the payload module** — `native/crates/bp-ledger/src/payload/plan_lifecycle.rs`:

```rust
//! Plan lifecycle payloads (M2): PlanAdmitted, PlanReceiptRecorded.

use crate::id::EventId;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// `plan_admitted` payload — operator-approved PlanForge admission; the dispatch
/// authority. Signed by the kernel key; the operator identity is `decided_by`.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanAdmittedV1 {
    /// Stable PlanForge plan id (e.g. `pf-plan-<fingerprint>`).
    pub plan_id: String,
    /// Canonical digest of the admitted plan, `sha256:<hex>`.
    pub plan_digest: String,
    /// Canonical digest of the compiled input, `sha256:<hex>`.
    pub input_digest: String,
    /// Trusted base commit the plan was admitted against.
    pub trusted_base: String,
    /// Operator identity recorded as a payload field (kernel key signs the event).
    pub decided_by: String,
    /// Admission timestamp, RFC3339.
    pub decided_at: String,
    /// Deterministic idempotency key over normalized plan inputs.
    pub idempotency_key: String,
    /// Next step this admission authorizes.
    pub authorized_next_step: String,
}

/// `plan_receipt` payload — terminal signed receipt chaining to the admission event.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanReceiptRecordedV1 {
    pub plan_id: String,
    /// The `plan_admitted` event this receipt finalizes.
    pub admission_event_id: EventId,
    pub outcome: PlanReceiptOutcome,
    /// Actual side effects recorded for the completed plan.
    pub side_effects: Vec<String>,
    /// Canonical digest binding the recorded result, `sha256:<hex>`.
    pub result_digest: String,
    /// Receipt timestamp, RFC3339.
    pub decided_at: String,
}

/// Closed terminal outcome vocabulary for a plan receipt.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanReceiptOutcome {
    Completed,
    Failed,
    Aborted,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admitted() -> PlanAdmittedV1 {
        PlanAdmittedV1 {
            plan_id: "pf-plan-001".into(),
            plan_digest: "sha256:aa".into(),
            input_digest: "sha256:bb".into(),
            trusted_base: "deadbeef".into(),
            decided_by: "operator:khall".into(),
            decided_at: "2026-05-30T00:00:00Z".into(),
            idempotency_key: "planforge:v0:buildplane:deadbeef:abcd1234".into(),
            authorized_next_step: "dispatch_admitted_plan".into(),
        }
    }

    #[test]
    fn plan_admitted_v1_round_trips() {
        let p = admitted();
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<PlanAdmittedV1>(&s).unwrap());
    }

    #[test]
    fn plan_receipt_v1_round_trips() {
        let p = PlanReceiptRecordedV1 {
            plan_id: "pf-plan-001".into(),
            admission_event_id: EventId::new(),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:01:00Z".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<PlanReceiptRecordedV1>(&s).unwrap());
    }

    #[test]
    fn plan_receipt_outcome_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&PlanReceiptOutcome::Aborted).unwrap(),
            r#""aborted""#
        );
    }
}
```

- [ ] **Step 2: Register the module + `Payload` arms** — in `native/crates/bp-ledger/src/payload/mod.rs` add `pub mod plan_lifecycle;` (alphabetical, after `model_io`) and add two arms to the `Payload` enum after `RunAdmissionRecordedV1(...)`:

```rust
    PlanAdmittedV1(plan_lifecycle::PlanAdmittedV1),
    PlanReceiptRecordedV1(plan_lifecycle::PlanReceiptRecordedV1),
```

- [ ] **Step 3: Add the `EventKind` variants** — in `native/crates/bp-ledger/src/kind.rs`: add a `// PlanForge lifecycle (M2)` group with `PlanAdmitted,` and `PlanReceiptRecorded,` to the enum; add the two `as_wire` arms `Self::PlanAdmitted => "plan_admitted",` and `Self::PlanReceiptRecorded => "plan_receipt",`; and append `EventKind::PlanAdmitted, EventKind::PlanReceiptRecorded,` to BOTH the `as_wire_matches_serde_output` test array. (Wire names: `plan_admitted`, `plan_receipt`.)

- [ ] **Step 4: Add the `canonicalize.rs` arms** — in `native/crates/bp-ledger/src/canonicalize.rs`, add to `payload_variant_name`:

```rust
        Payload::PlanAdmittedV1(_) => "PlanAdmittedV1",
        Payload::PlanReceiptRecordedV1(_) => "PlanReceiptRecordedV1",
```

and to `kind_to_variant`:

```rust
        "plan_admitted" => "PlanAdmittedV1",
        "plan_receipt" => "PlanReceiptRecordedV1",
```

- [ ] **Step 5: Write the integration test** — `native/crates/bp-ledger/tests/plan_lifecycle.rs` (mirror `tests/run_admission.rs`):

```rust
use bp_ledger::canonicalize::{canonical_event_bytes, canonicalize_payload};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
use bp_ledger::payload::Payload;
use chrono::Utc;

fn admitted() -> PlanAdmittedV1 {
    PlanAdmittedV1 {
        plan_id: "pf-plan-001".into(),
        plan_digest: "sha256:aa".into(),
        input_digest: "sha256:bb".into(),
        trusted_base: "deadbeef".into(),
        decided_by: "operator:khall".into(),
        decided_at: "2026-05-30T00:00:00Z".into(),
        idempotency_key: "planforge:v0:buildplane:deadbeef:abcd1234".into(),
        authorized_next_step: "dispatch_admitted_plan".into(),
    }
}

#[test]
fn plan_kinds_use_wire_names() {
    assert_eq!(EventKind::PlanAdmitted.as_wire(), "plan_admitted");
    assert_eq!(EventKind::PlanReceiptRecorded.as_wire(), "plan_receipt");
    assert_eq!(
        serde_json::to_string(&EventKind::PlanAdmitted).unwrap(),
        r#""plan_admitted""#
    );
}

#[test]
fn plan_admitted_canonicalizes_by_kind_and_variant() {
    let payload = Payload::PlanAdmittedV1(admitted());
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("plan_admitted", 1, value).unwrap() {
        Payload::PlanAdmittedV1(p) => {
            assert_eq!(p.plan_id, "pf-plan-001");
            assert_eq!(p.authorized_next_step, "dispatch_admitted_plan");
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

#[test]
fn plan_admitted_rejects_mismatched_kind() {
    let value = serde_json::to_value(Payload::PlanAdmittedV1(admitted())).unwrap();
    assert!(canonicalize_payload("plan_receipt", 1, value).is_err());
}

#[test]
fn plan_receipt_canonical_bytes_carry_chain_and_digest() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::PlanReceiptRecorded,
        occurred_at: Utc::now(),
        payload: Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
            plan_id: "pf-plan-001".into(),
            admission_event_id: EventId::new(),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:01:00Z".into(),
        }),
    };
    let json = String::from_utf8(canonical_event_bytes(&event).unwrap()).unwrap();
    assert!(json.contains("plan_receipt"));
    assert!(json.contains("admission_event_id"));
    assert!(json.contains("result_digest"));
    assert!(json.contains("completed"));
}
```

- [ ] **Step 6: Run the plan-lifecycle tests + unit tests — expect PASS:**

Run: `cargo test --manifest-path native/Cargo.toml -p bp-ledger plan_lifecycle`
Expected: PASS (module unit tests + integration tests). Also confirm the kind test array still passes: `cargo test --manifest-path native/Cargo.toml -p bp-ledger kind`.

- [ ] **Step 7: Commit:**

```bash
git add native/crates/bp-ledger/src/payload/plan_lifecycle.rs native/crates/bp-ledger/src/payload/mod.rs native/crates/bp-ledger/src/kind.rs native/crates/bp-ledger/src/canonicalize.rs native/crates/bp-ledger/tests/plan_lifecycle.rs
git commit -m "feat(ledger): add plan_admitted + plan_receipt payload kinds (M2-S2)"
```

## Task 3: Rust — `activity_started` + `activity_completed` payloads

**Files:** Create `native/crates/bp-ledger/src/payload/activity.rs`; Modify `native/crates/bp-ledger/src/payload/mod.rs`, `native/crates/bp-ledger/src/kind.rs`, `native/crates/bp-ledger/src/canonicalize.rs`; Create `native/crates/bp-ledger/tests/activity.rs`

- [ ] **Step 1: Create the payload module** — `native/crates/bp-ledger/src/payload/activity.rs`:

```rust
//! Activity bracketing payloads (M2): ActivityStarted, ActivityCompleted.
//! These bracket every I/O activity for Temporal-style replay — on replay the
//! kernel reads the recorded `result` and never re-invokes the model/tool.

use crate::id::RunId;
use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// `activity_started` payload — write-ahead bracket appended (and signed) BEFORE
/// an I/O activity is invoked, so a crash mid-invoke is recoverable.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityStartedV1 {
    pub run_id: RunId,
    /// Stable per-run activity id; pairs with the completing event.
    pub activity_id: String,
    pub activity_type: ActivityType,
    /// Canonical digest of the activity input, `sha256:<hex>`.
    pub input_digest: String,
}

/// `activity_completed` payload — records the activity result for replay.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivityCompletedV1 {
    pub run_id: RunId,
    pub activity_id: String,
    /// Canonical digest binding `result`, `sha256:<hex>`.
    pub result_digest: String,
    /// Recorded model/tool/command output, replayed verbatim instead of re-invoking.
    pub result: serde_json::Value,
}

/// Closed activity-type vocabulary.
#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityType {
    Model,
    Tool,
    Command,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::RunId;
    use serde_json::json;

    #[test]
    fn activity_started_v1_round_trips() {
        let p = ActivityStartedV1 {
            run_id: RunId::new(),
            activity_id: "act-1".into(),
            activity_type: ActivityType::Model,
            input_digest: "sha256:dd".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ActivityStartedV1>(&s).unwrap());
    }

    #[test]
    fn activity_completed_v1_round_trips_with_opaque_result() {
        let p = ActivityCompletedV1 {
            run_id: RunId::new(),
            activity_id: "act-1".into(),
            result_digest: "sha256:ee".into(),
            result: json!({"content": "ok", "tool_calls": []}),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<ActivityCompletedV1>(&s).unwrap());
    }

    #[test]
    fn activity_type_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&ActivityType::Command).unwrap(), r#""command""#);
    }
}
```

- [ ] **Step 2: Register the module + `Payload` arms** — in `native/crates/bp-ledger/src/payload/mod.rs` add `pub mod activity;` (alphabetical, first `pub mod`) and add two arms after the plan-lifecycle arms from Task 2:

```rust
    ActivityStartedV1(activity::ActivityStartedV1),
    ActivityCompletedV1(activity::ActivityCompletedV1),
```

- [ ] **Step 3: Add the `EventKind` variants** — in `native/crates/bp-ledger/src/kind.rs`: under the `// PlanForge lifecycle (M2)` group add `ActivityStarted,` and `ActivityCompleted,`; add `as_wire` arms `Self::ActivityStarted => "activity_started",` and `Self::ActivityCompleted => "activity_completed",`; and append `EventKind::ActivityStarted, EventKind::ActivityCompleted,` to the `as_wire_matches_serde_output` test array.

- [ ] **Step 4: Add the `canonicalize.rs` arms** — in `payload_variant_name`:

```rust
        Payload::ActivityStartedV1(_) => "ActivityStartedV1",
        Payload::ActivityCompletedV1(_) => "ActivityCompletedV1",
```

and in `kind_to_variant`:

```rust
        "activity_started" => "ActivityStartedV1",
        "activity_completed" => "ActivityCompletedV1",
```

- [ ] **Step 5: Write the integration test** — `native/crates/bp-ledger/tests/activity.rs`:

```rust
use bp_ledger::canonicalize::{canonical_event_bytes, canonicalize_payload};
use bp_ledger::event::Event;
use bp_ledger::id::{EventId, RunId};
use bp_ledger::kind::EventKind;
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::Payload;
use chrono::Utc;
use serde_json::json;

#[test]
fn activity_kinds_use_wire_names() {
    assert_eq!(EventKind::ActivityStarted.as_wire(), "activity_started");
    assert_eq!(EventKind::ActivityCompleted.as_wire(), "activity_completed");
}

#[test]
fn activity_started_canonicalizes_by_kind_and_variant() {
    let payload = Payload::ActivityStartedV1(ActivityStartedV1 {
        run_id: RunId::new(),
        activity_id: "act-1".into(),
        activity_type: ActivityType::Tool,
        input_digest: "sha256:dd".into(),
    });
    let value = serde_json::to_value(&payload).unwrap();
    match canonicalize_payload("activity_started", 1, value).unwrap() {
        Payload::ActivityStartedV1(p) => {
            assert_eq!(p.activity_id, "act-1");
            assert_eq!(p.activity_type, ActivityType::Tool);
        }
        other => panic!("unexpected variant: {other:?}"),
    }
}

#[test]
fn activity_completed_canonical_bytes_carry_result_and_digest() {
    let event = Event {
        id: EventId::new(),
        run_id: RunId::new(),
        parent_event_id: None,
        schema_version: Event::CURRENT_SCHEMA_VERSION,
        kind: EventKind::ActivityCompleted,
        occurred_at: Utc::now(),
        payload: Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id: RunId::new(),
            activity_id: "act-1".into(),
            result_digest: "sha256:ee".into(),
            result: json!({"content": "ok"}),
        }),
    };
    let bytes = canonical_event_bytes(&event).unwrap();
    let s = String::from_utf8(bytes).unwrap();
    assert!(s.contains("activity_completed"));
    assert!(s.contains("result_digest"));
    assert!(s.contains("\"result\""));
}

#[test]
fn activity_completed_rejects_mismatched_kind() {
    let value = serde_json::to_value(Payload::ActivityCompletedV1(ActivityCompletedV1 {
        run_id: RunId::new(),
        activity_id: "act-1".into(),
        result_digest: "sha256:ee".into(),
        result: json!({}),
    }))
    .unwrap();
    assert!(canonicalize_payload("activity_started", 1, value).is_err());
}
```

- [ ] **Step 6: Run the activity tests — expect PASS:**

Run: `cargo test --manifest-path native/Cargo.toml -p bp-ledger activity`
Expected: PASS.

- [ ] **Step 7: Run the whole bp-ledger lib + canonicalize suite (regression):**

Run: `cargo test --manifest-path native/Cargo.toml -p bp-ledger`
Expected: PASS (every existing test still green; the round_trip/canonicalize suites cover the new arms).

- [ ] **Step 8: Commit:**

```bash
git add native/crates/bp-ledger/src/payload/activity.rs native/crates/bp-ledger/src/payload/mod.rs native/crates/bp-ledger/src/kind.rs native/crates/bp-ledger/src/canonicalize.rs native/crates/bp-ledger/tests/activity.rs
git commit -m "feat(ledger): add activity_started + activity_completed payload kinds (M2-S2)"
```

## Task 4: Regenerate TS bindings, hand-edit the union, regenerate fixtures, update the drift alarm

**Files:** Modify `native/crates/bp-ledger/src/bin/gen_fixtures.rs`, `packages/ledger-client/src/payload.ts`, `packages/ledger-client/test/payload-drift.test.ts`; Regenerate `packages/ledger-client/src/generated/index.ts`, `packages/ledger-client/fixtures/payload-variants.json`

- [ ] **Step 1: Add the four fixture entries** — in `native/crates/bp-ledger/src/bin/gen_fixtures.rs`, extend the `use` block for the two new modules and append four entries to the END of the `out` vec (after the `TapeCheckpointV1` entry). Imports to add:

```rust
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
```

Entries (deterministic — reuse `fixed_event_id`/`fixed_run_id`):

```rust
        serde_json::to_value(Payload::PlanAdmittedV1(PlanAdmittedV1 {
            plan_id: "pf-plan-fixture".into(),
            plan_digest: "sha256:aa".into(),
            input_digest: "sha256:bb".into(),
            trusted_base: "deadbeef".into(),
            decided_by: "operator:fixture".into(),
            decided_at: "2026-05-30T00:00:00Z".into(),
            idempotency_key: "planforge:v0:buildplane:deadbeef:fixture".into(),
            authorized_next_step: "dispatch_admitted_plan".into(),
        })).unwrap(),

        serde_json::to_value(Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
            plan_id: "pf-plan-fixture".into(),
            admission_event_id: fixed_event_id(5),
            outcome: PlanReceiptOutcome::Completed,
            side_effects: vec!["fs.write:declared_scope".into()],
            result_digest: "sha256:cc".into(),
            decided_at: "2026-05-30T00:00:10Z".into(),
        })).unwrap(),

        serde_json::to_value(Payload::ActivityStartedV1(ActivityStartedV1 {
            run_id: fixed_run_id(),
            activity_id: "act-1".into(),
            activity_type: ActivityType::Model,
            input_digest: "sha256:dd".into(),
        })).unwrap(),

        serde_json::to_value(Payload::ActivityCompletedV1(ActivityCompletedV1 {
            run_id: fixed_run_id(),
            activity_id: "act-1".into(),
            result_digest: "sha256:ee".into(),
            result: json!({"content": "ok"}),
        })).unwrap(),
```

- [ ] **Step 2: Regenerate the typeshare bindings:**

Run: `pnpm ledger:gen`
Expected: `packages/ledger-client/src/generated/index.ts` now contains `PlanAdmittedV1`, `PlanReceiptRecordedV1`, `PlanReceiptOutcome`, `ActivityStartedV1`, `ActivityCompletedV1`, `ActivityType`, and the four new `EventKind` members. (This file is generated — do NOT hand-edit it.)

- [ ] **Step 3: Hand-edit the TS union** — in `packages/ledger-client/src/payload.ts`, add the four type imports (alphabetical) to the existing `import type { … } from "./generated/index.js";` block:

```ts
	ActivityCompletedV1,
	ActivityStartedV1,
	PlanAdmittedV1,
	PlanReceiptRecordedV1,
```

and add four union arms (place the two plan arms after `RunAdmissionRecordedV1` and the two activity arms after the unit group, or simply append all four before `TapeCheckpointV1` — order is cosmetic):

```ts
	| { PlanAdmittedV1: PlanAdmittedV1 }
	| { PlanReceiptRecordedV1: PlanReceiptRecordedV1 }
	| { ActivityStartedV1: ActivityStartedV1 }
	| { ActivityCompletedV1: ActivityCompletedV1 }
```

- [ ] **Step 4: Regenerate the fixtures:**

Run: `pnpm ledger:gen-fixtures`
Expected: `packages/ledger-client/fixtures/payload-variants.json` grows from 16 to 20 entries (the 4 appended). The signed-tape fixtures also regenerate (Task 5 modifies their generator — run order: do Task 5's generator edit before relying on the plan-cycle output, but this command is safe to run now and again in Task 5).

- [ ] **Step 5: Update the drift alarm** — in `packages/ledger-client/test/payload-drift.test.ts`:
  - add the four type imports (`PlanAdmittedV1`, etc.) only if asserting their shape (optional);
  - change `expect(fixtures.length).toBe(16);` → `toBe(20);`
  - add four `case` labels to the exhaustive `switch` (before `default`): `case "PlanAdmittedV1":`, `case "PlanReceiptRecordedV1":`, `case "ActivityStartedV1":`, `case "ActivityCompletedV1":`
  - add presence assertions in the first `it`:

```ts
		expect(names).toContain("PlanAdmittedV1");
		expect(names).toContain("PlanReceiptRecordedV1");
		expect(names).toContain("ActivityStartedV1");
		expect(names).toContain("ActivityCompletedV1");
```

  - add a wire-name assertion (mirrors the existing `EventKind.RunAdmissionRecorded` check):

```ts
		expect(EventKind.PlanAdmitted).toBe("plan_admitted");
		expect(EventKind.ActivityCompleted).toBe("activity_completed");
```

- [ ] **Step 6: Run the drift + ledger-client suite — expect PASS:**

Run: `pnpm -C packages/ledger-client exec vitest run`
Expected: PASS (drift alarm sees 20 known variants; exhaustive switch compiles — no `never` error).

- [ ] **Step 7: Prove byte-stable regeneration** (run the generators twice; no diff):

```bash
pnpm ledger:gen && pnpm ledger:gen-fixtures
git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures
```

Expected: exit 0 (no drift on re-run).

- [ ] **Step 8: Commit:**

```bash
git add native/crates/bp-ledger/src/bin/gen_fixtures.rs packages/ledger-client/src/payload.ts packages/ledger-client/src/generated/index.ts packages/ledger-client/fixtures/payload-variants.json packages/ledger-client/test/payload-drift.test.ts
git commit -m "feat(ledger-client): mirror M2 plan/activity kinds in TS union + fixtures + drift alarm"
```

## Task 5: Sign-on-append + external-verifier coverage (`plan-cycle/` signed tape)

Prove the four kinds sign on append and that the external verifier validates a tape containing them. Approach: add a NEW `plan-cycle/` variant to the M1-S7 signed-tape generator (leaving the existing `valid`/`tampered`/`bad-root` fixtures untouched), then verify it with `scripts/verify-signed-tape.mjs`.

**Files:** Modify `native/crates/bp-ledger/src/bin/gen_signed_tape.rs`; Regenerate `test/fixtures/signed-tape/plan-cycle/tape.json`; Create/Modify a verifying test

- [ ] **Step 1: Read** `native/crates/bp-ledger/src/bin/gen_signed_tape.rs` end-to-end and `native/crates/bp-ledger/tests/signed_tape_fixture.rs` to see how the existing `valid` variant is asserted. Reuse `fixed_event_id`/`fixed_run_id`/`at`/`signer`/`entry`/`write_tape`/`tape_root_hash`/`sign_event` verbatim.

- [ ] **Step 2: Add a `plan_cycle_events()` builder** to `gen_signed_tape.rs` — a run that exercises all four kinds in tape order, each signed, with a checkpoint covering them. Add the imports for the new payloads and build:

```rust
fn plan_cycle_events() -> Vec<Event> {
    let run_id = fixed_run_id();
    vec![
        Event {
            id: fixed_event_id(21),
            run_id,
            parent_event_id: None,
            schema_version: 1,
            kind: EventKind::RunStarted,
            occurred_at: at("2026-05-30T00:00:00Z"),
            payload: Payload::RunStartedV1(RunStartedV1 {
                packet_hash: "sha256:aa".into(),
                git_head: "dead".into(),
                workspace_path: "/ws".into(),
                config: BTreeMap::new(),
                parent_run_id: None,
                parent_event_id: None,
            }),
        },
        Event {
            id: fixed_event_id(22),
            run_id,
            parent_event_id: Some(fixed_event_id(21)),
            schema_version: 1,
            kind: EventKind::PlanAdmitted,
            occurred_at: at("2026-05-30T00:00:01Z"),
            payload: Payload::PlanAdmittedV1(PlanAdmittedV1 {
                plan_id: "pf-plan-fixture".into(),
                plan_digest: "sha256:aa".into(),
                input_digest: "sha256:bb".into(),
                trusted_base: "dead".into(),
                decided_by: "operator:fixture".into(),
                decided_at: "2026-05-30T00:00:01Z".into(),
                idempotency_key: "planforge:v0:buildplane:dead:fixture".into(),
                authorized_next_step: "dispatch_admitted_plan".into(),
            }),
        },
        Event {
            id: fixed_event_id(23),
            run_id,
            parent_event_id: Some(fixed_event_id(22)),
            schema_version: 1,
            kind: EventKind::ActivityStarted,
            occurred_at: at("2026-05-30T00:00:02Z"),
            payload: Payload::ActivityStartedV1(ActivityStartedV1 {
                run_id,
                activity_id: "act-1".into(),
                activity_type: ActivityType::Model,
                input_digest: "sha256:dd".into(),
            }),
        },
        Event {
            id: fixed_event_id(24),
            run_id,
            parent_event_id: Some(fixed_event_id(23)),
            schema_version: 1,
            kind: EventKind::ActivityCompleted,
            occurred_at: at("2026-05-30T00:00:03Z"),
            payload: Payload::ActivityCompletedV1(ActivityCompletedV1 {
                run_id,
                activity_id: "act-1".into(),
                result_digest: "sha256:ee".into(),
                result: json!({"content": "ok"}),
            }),
        },
        Event {
            id: fixed_event_id(25),
            run_id,
            parent_event_id: Some(fixed_event_id(24)),
            schema_version: 1,
            kind: EventKind::PlanReceiptRecorded,
            occurred_at: at("2026-05-30T00:00:04Z"),
            payload: Payload::PlanReceiptRecordedV1(PlanReceiptRecordedV1 {
                plan_id: "pf-plan-fixture".into(),
                admission_event_id: fixed_event_id(22),
                outcome: PlanReceiptOutcome::Completed,
                side_effects: vec!["fs.write:declared_scope".into()],
                result_digest: "sha256:cc".into(),
                decided_at: "2026-05-30T00:00:04Z".into(),
            }),
        },
    ]
}

fn plan_cycle_checkpoint(tape_root: String) -> Event {
    Event {
        id: fixed_event_id(26),
        run_id: fixed_run_id(),
        parent_event_id: Some(fixed_event_id(25)),
        schema_version: 1,
        kind: EventKind::TapeCheckpoint,
        occurred_at: at("2026-05-30T00:00:05Z"),
        payload: Payload::TapeCheckpointV1(TapeCheckpointV1 {
            run_id: fixed_run_id(),
            checkpoint_index: 0,
            through_event_id: fixed_event_id(25),
            through_event_count: 5,
            previous_checkpoint_event_id: None,
            tape_root_hash: tape_root,
            algorithm: TapeRootAlgorithm::Sha256Linear,
        }),
    }
}
```

- [ ] **Step 3: Emit the `plan-cycle` variant** in `main()` of `gen_signed_tape.rs`, after the existing three variants (reuse the exact `valid`-variant signing pattern):

```rust
    // plan-cycle: a full PlanForge admission cycle (M2-S2) — every event signed,
    // checkpoint root correct. Proves the external verifier validates the new kinds.
    {
        let events = plan_cycle_events();
        let sigs: Vec<EventSignatureV1> =
            events.iter().map(|e| sign_event(e, &key, &signer(), signed_at).unwrap()).collect();
        let ordered: Vec<String> = sigs.iter().map(|s| s.canonical_event_hash.clone()).collect();
        let root = tape_root_hash(&ordered);
        let cp = plan_cycle_checkpoint(root);
        let cp_sig = sign_event(&cp, &key, &signer(), signed_at).unwrap();
        let mut entries: Vec<Value> = events.iter().zip(&sigs).map(|(e, s)| entry(e, s)).collect();
        entries.push(entry(&cp, &cp_sig));
        write_tape(&out_dir, "plan-cycle", &key, entries);
    }
```

Add the payload imports at the top of the file:

```rust
use bp_ledger::payload::activity::{ActivityCompletedV1, ActivityStartedV1, ActivityType};
use bp_ledger::payload::plan_lifecycle::{
    PlanAdmittedV1, PlanReceiptOutcome, PlanReceiptRecordedV1,
};
```

- [ ] **Step 4: Regenerate the signed-tape fixtures:**

Run: `pnpm ledger:gen-fixtures`
Expected: `test/fixtures/signed-tape/plan-cycle/tape.json` is created; `valid/`, `tampered/`, `bad-root/` are unchanged (`git status` shows only the new `plan-cycle/` path).

- [ ] **Step 5: Validate with the external verifier — expect exit 0:**

Run: `node scripts/verify-signed-tape.mjs --fixture test/fixtures/signed-tape/plan-cycle`
Expected: exit 0, all signatures valid, checkpoint root correct. (If the script's flag differs, mirror the invocation `signed_tape_fixture.rs` / the M1-S7 receipt uses for the `valid` variant.)

- [ ] **Step 6: Add a Rust assertion** that the plan-cycle tape verifies, mirroring the `valid`-case test in `native/crates/bp-ledger/tests/signed_tape_fixture.rs` (load `test/fixtures/signed-tape/plan-cycle/tape.json`, verify every event signature against `trusted_keys`, recompute the checkpoint root). If `signed_tape_fixture.rs` iterates a variant list, add `"plan-cycle"` to the valid set; otherwise add a parallel `#[test] fn plan_cycle_tape_is_valid()`.

- [ ] **Step 7: Run the signed-tape test — expect PASS:**

Run: `cargo test --manifest-path native/Cargo.toml -p bp-ledger signed_tape`
Expected: PASS.

- [ ] **Step 8: Commit:**

```bash
git add native/crates/bp-ledger/src/bin/gen_signed_tape.rs native/crates/bp-ledger/tests/signed_tape_fixture.rs test/fixtures/signed-tape/plan-cycle
git commit -m "test(ledger): plan-cycle signed-tape fixture exercises M2 kinds end-to-end (M2-S2)"
```

## Task 6: Full gate, changeset, slice receipt

**Files:** Create `.changeset/m2-s2-tape-event-vocabulary.md`, `docs/operations/2026-05-30-m2-s2-tape-event-vocabulary-receipt.md`

- [ ] **Step 1: Changeset** — `.changeset/m2-s2-tape-event-vocabulary.md` (lowercase summary). The TS surface that changes is `@buildplane/ledger-client` (new union arms + generated types) and `@buildplane/planforge` (nit fixes); both are `private` but changesets versions them for monorepo coordination:

```md
---
"@buildplane/ledger-client": patch
"@buildplane/planforge": patch
---

add M2 plan/activity signed tape event kinds (plan_admitted, plan_receipt, activity_started, activity_completed) to the TS payload union + fixtures; fold M2-S1 planforge review nits
```

- [ ] **Step 2: Full M2 gate** (CI `verify` is canonical; `biome check .` OOMs locally in WSL — record the caveat, take lint exit status from CI):

```bash
pnpm typecheck
cargo test --manifest-path native/Cargo.toml -p bp-ledger
pnpm -C packages/ledger-client exec vitest run
pnpm -C packages/planforge exec vitest run
pnpm -C apps/cli exec vitest run test/run-cli.test.ts -t planforge
pnpm ledger:gen && pnpm ledger:gen-fixtures
git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures test/fixtures/signed-tape
pnpm build
```

Expected: all PASS; the `git diff --exit-code` is clean (byte-stable regeneration).

- [ ] **Step 3: Slice receipt** — fill `docs/operations/slice-receipt-template.md` as `docs/operations/2026-05-30-m2-s2-tape-event-vocabulary-receipt.md`: slice id `M2-S2`; base SHA `5ac26d0`; the commands above + exit codes; files changed; the four new wire kinds + their variant names; the three folded S1 nits; **L0 surface → 2 reviewers (Opus + adversarial Codex), NOT auto-merge eligible** (no `buildplane:auto-merge` label); out-of-scope follow-ups (admit S3, dispatch S4, activity bracketing S5, receipt S6, replay S7).

- [ ] **Step 4: Commit:**

```bash
git add .changeset/m2-s2-tape-event-vocabulary.md docs/operations/2026-05-30-m2-s2-tape-event-vocabulary-receipt.md
git commit -m "docs(ledger): M2-S2 changeset + slice receipt"
```

> **Push/PR:** do NOT push or open a PR from inside this slice. After the implementer finishes and commits, the orchestrator runs the L0 two-reviewer gate (independent Opus Reviewer + adversarial Codex), then a **fresh push subagent** opens the PR (whole-repo `biome check .` OOMs in the orchestrator session). Solo PR → admin-merge by the operator; no auto-merge label.

---

## Review & side-effect boundaries (M2-S2 — L0 trust surface)

- **Two reviewers, both required** (per spec §"Review requirements"): an independent read-only **Opus Reviewer** (fresh session) verdict `PASS` on the PR head SHA, AND an **adversarial Codex reviewer**. **Not auto-merge eligible** — do not apply `buildplane:auto-merge`.
- Opus reviewer focus: are the four wire shapes correct and minimal per the spec field lists; are kind↔variant arms exhaustive (both directions); is the TS union a faithful mirror; do round-trip/canonicalize/sign-on-append/external-verifier all pass; is fixture regeneration byte-stable; are the three S1 nits actually fixed without rotating the dry-run golden digest.
- Codex adversarial focus: serialization edge cases (the `serde_json::Value` `result`; the `Eq`-vs-`PartialEq` derive split), kind/variant mismatch handling (`canonicalize_payload` rejects wrong kind), determinism of the generators (no `EventId::new()`/`Utc::now()` in fixture/tape generators), and that `plan-cycle` does not perturb the M1-S7 `valid`/`tampered`/`bad-root` fixtures.
- **No** push, PR open, merge, branch-protection/ruleset edits, `.github/` or release-plumbing changes from inside this slice.
- Reviewed SHA must equal the PR head SHA at merge.

## Self-review (against the M2 spec §M2-S2)

- **Spec coverage:** ✅ four kinds (`plan_admitted`/`plan_receipt`/`activity_started`/`activity_completed`) via the add-event-kind procedure (Tasks 2–4); ✅ round-trip + canonicalize + sign-on-append + external verifier validates a tape containing them (Tasks 2,3,5); ✅ fixture freshness byte-stable on regeneration (Task 4 Step 7, Task 6 Step 2); ✅ three S1 nits folded into the first task (Task 1).
- **Field coverage:** PlanAdmittedV1 ⊇ {plan_id, plan_digest, input_digest, trusted_base, decided_by, decided_at, idempotency_key, authorized_next_step}; PlanReceiptRecordedV1 ⊇ {plan_id, admission_event_id, outcome, side_effects, result_digest, decided_at}; ActivityStartedV1 ⊇ {run_id, activity_id, activity_type, input_digest}; ActivityCompletedV1 ⊇ {run_id, activity_id, result_digest, result} — all per the spec table.
- **Type consistency:** `PlanReceiptOutcome` (Task 2) and `ActivityType` (Task 3) are referenced identically in fixtures (Task 4) and the signed-tape generator (Task 5). `ActivityCompletedV1` derives `PartialEq` only (no `Eq`) everywhere it appears.
- **Placeholder scan:** none — every step carries exact paths, code, commands, expected pass/fail.
- **Boundary fidelity:** vocabulary only — no kernel/CLI/emit wiring (S3–S7 own those); existing M1-S7 signed-tape fixtures untouched (new `plan-cycle/` variant); dry-run golden fixture unchanged by the digest hardening.
