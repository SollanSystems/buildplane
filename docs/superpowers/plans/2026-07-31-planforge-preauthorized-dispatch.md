# PlanForge Preauthorized Dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one PlanForge task dispatchable under a signed plan admission — `plan_admitted` → sealed V5 admission carrying `provenance_ref` → `open_candidate_session` accepting `PreauthorizationRef` → candidate → acceptance → promotion.

**Architecture:** Nothing new is invented. `CandidateApprovalV1::PreauthorizationRef` already exists and is already parsed off the wire; `ResolvedGovernedV5CandidateAuthorityV1` already carries `provenance_ref`; `plan_admitted` already has a payload, a builder, a kernel reader, and an orchestrator gate. The only structural blocker is a single guard in `open_candidate_session` that rejects every approval except `OperatorRequested`. This slice unlocks that guard behind a verified provenance binding, adds the missing `plan_admitted` write path, and closes a fail-open the binding depends on.

**Tech Stack:** Rust (`bp-authority-broker`, `bp-ledger`), TypeScript (`packages/kernel`, `packages/planforge`, `apps/cli`), vitest, cargo test, biome.

**Spec:** `docs/superpowers/specs/2026-07-31-planforge-candidate-transaction-design.md` §9.

## Global Constraints

- Node 24.13.1, pnpm 10, Rust stable. Build native before tests: `pnpm native:build`.
- Slice verify command is `pnpm -C . exec vitest run <paths>`. **NEVER** `pnpm --filter buildplane test` — it breaks vitest aliases and silently stalls.
- Commit subjects lead with a **lowercase** verb (commitlint rejects upper-case leads).
- Changeset required **only** if a published `packages/*` or `apps/*` surface changes.
- Task 4 touches admission authority. It is an **L0 change: full four-role ceremony** (implementer TDD self-verify + independent Opus reviewer in a fresh session + adversarial Codex + independent acceptance-criteria verifier). Do not apply `buildplane:auto-merge`.
- Adding an L0 **event kind** is out of scope — this slice adds none. If you find yourself editing `kind.rs`, stop; you have left the plan.
- `packages/planforge` is a zero-dependency leaf by policy. Do not add imports to it from kernel or ledger-client.
- Whole-repo `biome check .` works but is slow under load; scope to changed files. CI `verify` is canonical.

---

## File Structure

| File | Responsibility |
|---|---|
| `native/crates/bp-authority-broker/src/candidate_approval.rs` | **NEW.** Pure approval-authorization decision. No I/O, no ledger, no keys — takes an approval plus a resolved authority and returns accept/reject. Exists so the security decision is unit-testable without a ledger fixture. |
| `native/crates/bp-authority-broker/src/candidate_approval_contract_tests.rs` | **NEW.** Exhaustive tests for that decision. |
| `native/crates/bp-authority-broker/src/lib.rs` | Declare the two new modules. |
| `native/crates/bp-authority-broker/src/governed_session_protected_host.rs` | Replace the blanket guard with a call to the pure decision. |
| `packages/kernel/src/ports.ts` | Add `PlanAdmissionPort`, mirroring `BuildplaneAcceptancePort`. |
| `packages/kernel/src/orchestrator.ts` | Close the empty-`provenance_ref` fail-open. |
| `apps/cli/src/plan-admission-port.ts` | **NEW.** CLI-layer impl wrapping a signed tape emitter. |
| `apps/cli/src/run-cli.ts` | Replace the `planforge admit` throw with the real path. |
| `test/ledger-integration/planforge-preauthorized-dispatch.test.ts` | **NEW.** End-to-end proof plus signed-tape verification. |

---

## Task 1: Pure candidate-approval decision

Isolates the security decision from all I/O so it can be tested exhaustively. This is the load-bearing change of the slice.

**Files:**
- Create: `native/crates/bp-authority-broker/src/candidate_approval.rs`
- Create: `native/crates/bp-authority-broker/src/candidate_approval_contract_tests.rs`
- Modify: `native/crates/bp-authority-broker/src/lib.rs`

**Interfaces:**
- Consumes: `CandidateApprovalV1` (`governed_session_client.rs`), `ResolvedGovernedV5CandidateAuthorityV1` (`bp_ledger::storage::sqlite`).
- Produces: `pub(crate) fn authorize_candidate_approval_v1(approval: &CandidateApprovalV1, resolved: &ResolvedGovernedV5CandidateAuthorityV1) -> Result<(), CandidateApprovalRejectionV1>` and `pub(crate) enum CandidateApprovalRejectionV1`. Task 2 calls this.

- [ ] **Step 1: Write the failing tests**

Create `native/crates/bp-authority-broker/src/candidate_approval_contract_tests.rs`:

```rust
use crate::candidate_approval::{
    authorize_candidate_approval_v1, CandidateApprovalRejectionV1,
};
use crate::governed_session_client::CandidateApprovalV1;
use bp_ledger::storage::sqlite::ResolvedGovernedV5CandidateAuthorityV1;
use bp_ledger::{EventId, RunId};

fn resolved_with_provenance(provenance_ref: &str) -> ResolvedGovernedV5CandidateAuthorityV1 {
    ResolvedGovernedV5CandidateAuthorityV1 {
        run_id: RunId::from_uuid(uuid::Uuid::from_u128(1)),
        dispatch_event_id: EventId::from(1_u64),
        admission_event_id: EventId::from(2_u64),
        workflow_id: "wf-1".to_owned(),
        unit_id: "unit-1".to_owned(),
        attempt: 1,
        provenance_ref: provenance_ref.to_owned(),
        base_commit_sha: "a".repeat(40),
        repository_binding_digest: "sha256:aa".to_owned(),
        dispatch_envelope_digest: "sha256:bb".to_owned(),
        governed_packet_digest: "sha256:cc".to_owned(),
        sandbox_profile_digest: "sha256:dd".to_owned(),
    }
}

#[test]
fn operator_requested_is_authorized_regardless_of_provenance() {
    let resolved = resolved_with_provenance("");
    assert_eq!(
        authorize_candidate_approval_v1(&CandidateApprovalV1::OperatorRequested, &resolved),
        Ok(())
    );
}

#[test]
fn preauthorization_ref_matching_provenance_is_authorized() {
    let resolved = resolved_with_provenance("evt-000000000042");
    assert_eq!(
        authorize_candidate_approval_v1(
            &CandidateApprovalV1::PreauthorizationRef("evt-000000000042".to_owned()),
            &resolved,
        ),
        Ok(())
    );
}

#[test]
fn preauthorization_ref_mismatching_provenance_is_rejected() {
    let resolved = resolved_with_provenance("evt-000000000042");
    assert_eq!(
        authorize_candidate_approval_v1(
            &CandidateApprovalV1::PreauthorizationRef("evt-000000000099".to_owned()),
            &resolved,
        ),
        Err(CandidateApprovalRejectionV1::ProvenanceMismatch)
    );
}

#[test]
fn preauthorization_ref_against_empty_provenance_is_rejected() {
    let resolved = resolved_with_provenance("");
    assert_eq!(
        authorize_candidate_approval_v1(
            &CandidateApprovalV1::PreauthorizationRef("evt-000000000042".to_owned()),
            &resolved,
        ),
        Err(CandidateApprovalRejectionV1::ProvenanceAbsent)
    );
}

#[test]
fn preauthorized_envelope_source_remains_unsupported() {
    let resolved = resolved_with_provenance("evt-000000000042");
    assert_eq!(
        authorize_candidate_approval_v1(
            &CandidateApprovalV1::PreauthorizedEnvelopeSource("{}".to_owned()),
            &resolved,
        ),
        Err(CandidateApprovalRejectionV1::UnsupportedApproval)
    );
}
```

- [ ] **Step 2: Declare the modules**

In `native/crates/bp-authority-broker/src/lib.rs`, beside the other module declarations:

```rust
mod candidate_approval;
#[cfg(test)]
mod candidate_approval_contract_tests;
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path native/Cargo.toml -p bp-authority-broker candidate_approval`
Expected: FAIL — `unresolved import crate::candidate_approval`.

- [ ] **Step 4: Write the minimal implementation**

Create `native/crates/bp-authority-broker/src/candidate_approval.rs`:

```rust
use crate::governed_session_client::CandidateApprovalV1;
use bp_ledger::storage::sqlite::ResolvedGovernedV5CandidateAuthorityV1;

/// Why a candidate approval was refused. Kept separate from the host's coarse
/// provider error so the decision can be tested without a ledger fixture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CandidateApprovalRejectionV1 {
    /// The resolved admission carries no provenance, so a preauthorization
    /// reference cannot be bound to a plan admission.
    ProvenanceAbsent,
    /// The preauthorization reference is not the admission's provenance.
    ProvenanceMismatch,
    /// Approval variant not supported on this surface.
    UnsupportedApproval,
}

/// Decide whether an approval may open a candidate session against an already
/// resolved (signature- and window-validated) V5 admission.
///
/// `OperatorRequested` is unconditional: the operator is present, and the
/// resolver has already proven exactly one live sealed admission binds this
/// packet. `PreauthorizationRef` is the standing-authority path, so it must
/// additionally bind to the plan admission that authorized the dispatch —
/// an absent provenance is refused rather than treated as a wildcard.
pub(crate) fn authorize_candidate_approval_v1(
    approval: &CandidateApprovalV1,
    resolved: &ResolvedGovernedV5CandidateAuthorityV1,
) -> Result<(), CandidateApprovalRejectionV1> {
    match approval {
        CandidateApprovalV1::OperatorRequested => Ok(()),
        CandidateApprovalV1::PreauthorizationRef(reference) => {
            if resolved.provenance_ref.is_empty() {
                return Err(CandidateApprovalRejectionV1::ProvenanceAbsent);
            }
            if resolved.provenance_ref != *reference {
                return Err(CandidateApprovalRejectionV1::ProvenanceMismatch);
            }
            Ok(())
        }
        CandidateApprovalV1::PreauthorizedEnvelopeSource(_) => {
            Err(CandidateApprovalRejectionV1::UnsupportedApproval)
        }
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path native/Cargo.toml -p bp-authority-broker candidate_approval`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the whole native workspace**

Run: `cargo test --manifest-path native/Cargo.toml`
Expected: PASS. Run the **whole** workspace, not `-p` — a sibling crate's exhaustive match can break on a new enum.

- [ ] **Step 7: Commit**

```bash
git add native/crates/bp-authority-broker/src/candidate_approval.rs \
        native/crates/bp-authority-broker/src/candidate_approval_contract_tests.rs \
        native/crates/bp-authority-broker/src/lib.rs
git commit -m "feat(broker): add the pure candidate-approval decision"
```

---

## Task 2: Accept PreauthorizationRef in open_candidate_session

**L0 change — full four-role ceremony.**

**Files:**
- Modify: `native/crates/bp-authority-broker/src/governed_session_protected_host.rs`

**Interfaces:**
- Consumes: `authorize_candidate_approval_v1` from Task 1.
- Produces: no new public surface; behaviour change only.

- [ ] **Step 1: Replace the blanket guard**

In `governed_session_protected_host.rs`, inside `impl ProtectedGovernedSessionHostStateV1`, the function `open_candidate_session` currently opens:

```rust
    if !matches!(approval, CandidateApprovalV1::OperatorRequested) {
        return Err(ProtectedGovernedSessionProviderErrorV1::DurableAuthority);
    }
    let config = self.validated_startup.config();
    let resolved = self
        .ledger
        .store()
        .resolve_governed_v5_candidate_authority_v1(
```

Delete those first three lines, and insert the authorization check **immediately after** `resolved` is bound — the decision needs the resolved authority, so it cannot stay at the top:

```rust
    let config = self.validated_startup.config();
    let resolved = self
        .ledger
        .store()
        .resolve_governed_v5_candidate_authority_v1(
            &ResolveGovernedV5CandidateAuthorityRequestV1 {
                run_id: config.run_id,
                packet_source: packet_source.into(),
            },
            &config.v5_admission_authority,
            &config.activity_authority,
        )
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
    authorize_candidate_approval_v1(approval, &resolved)
        .map_err(|_| ProtectedGovernedSessionProviderErrorV1::DurableAuthority)?;
```

Leave the rest of the function unchanged.

- [ ] **Step 2: Add the import**

At the top of `governed_session_protected_host.rs`, beside the other `crate::` imports:

```rust
use crate::candidate_approval::authorize_candidate_approval_v1;
```

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path native/Cargo.toml -p bp-authority-broker`
Expected: compiles clean, no unused-import warning.

- [ ] **Step 4: Run the whole native workspace**

Run: `cargo test --manifest-path native/Cargo.toml`
Expected: PASS.

**Why no new test here:** the decision is exhaustively covered by Task 1, and the surrounding function is unchanged. Adding a ledger-fixture test for the same predicate would duplicate coverage at much higher cost. The end-to-end proof is Task 6.

- [ ] **Step 5: Commit**

```bash
git add native/crates/bp-authority-broker/src/governed_session_protected_host.rs
git commit -m "feat(broker): authorize preauthorized candidate sessions against admission provenance"
```

---

## Task 3: Close the provenance fail-open

Task 2's binding is worthless if a dispatch can simply omit `provenance_ref`.

**Files:**
- Modify: `packages/kernel/src/orchestrator.ts`
- Test: `packages/kernel/test/orchestrator-provenance.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: finalization now rejects a governed packet whose `provenance_ref` is empty.

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/test/orchestrator-provenance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { requireProvenanceRef } from "../src/orchestrator.js";

describe("requireProvenanceRef", () => {
	it("accepts a non-empty provenance ref", () => {
		expect(requireProvenanceRef("evt-000000000042")).toBe("evt-000000000042");
	});

	it("rejects an empty provenance ref rather than skipping the admission check", () => {
		expect(() => requireProvenanceRef("")).toThrow(
			/provenance_ref is required/i,
		);
	});

	it("rejects a whitespace-only provenance ref", () => {
		expect(() => requireProvenanceRef("   ")).toThrow(
			/provenance_ref is required/i,
		);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C . exec vitest run packages/kernel/test/orchestrator-provenance.test.ts`
Expected: FAIL — `requireProvenanceRef` is not exported.

- [ ] **Step 3: Implement**

In `packages/kernel/src/orchestrator.ts`, add near the other module-level helpers:

```ts
/**
 * A governed packet must name the `plan_admitted` that authorized it. An empty
 * ref previously skipped the admission check entirely, which made the check
 * opt-out by omission — exactly the property a preauthorized dispatch cannot
 * afford.
 */
export function requireProvenanceRef(provenanceRef: string): string {
	const trimmed = provenanceRef.trim();
	if (trimmed.length === 0) {
		throw new Error(
			"governed dispatch provenance_ref is required: no plan_admitted named.",
		);
	}
	return trimmed;
}
```

Then change the fail-open. It currently reads:

```ts
			const provenanceRef = ctx.validatedPacket.provenance_ref;
			if (provenanceRef) {
```

Replace those two lines with:

```ts
			const provenanceRef = requireProvenanceRef(
				ctx.validatedPacket.provenance_ref,
			);
			{
```

The block body is unchanged; the bare block keeps the existing indentation and scoping intact.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C . exec vitest run packages/kernel/test/orchestrator-provenance.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the kernel and CLI suites for regressions**

Run: `pnpm -C . exec vitest run packages/kernel/test apps/cli/test`
Expected: PASS. Existing packets that relied on the empty-ref skip will now fail — that is the point. If a **fixture** trips, give it a real provenance ref; do not weaken the guard.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/orchestrator.ts packages/kernel/test/orchestrator-provenance.test.ts
git commit -m "fix(kernel): require provenance_ref instead of skipping the admission check"
```

---

## Task 4: PlanAdmissionPort and its CLI implementation

`plan_admitted` has a payload, a builder, a reader, and a gate — but no writer.

**Files:**
- Modify: `packages/kernel/src/ports.ts`
- Create: `apps/cli/src/plan-admission-port.ts`
- Test: `apps/cli/test/plan-admission-port.test.ts` (create)

**Interfaces:**
- Consumes: `buildPlanAdmittedPayload` from `@buildplane/planforge` (`admit.ts:63`), which already throws `PlanForgeAdmitRejectedError` unless `plan.validation.status` is PASS.
- Produces: `PlanAdmissionPort` with `recordPlanAdmission(input: PlanAdmissionRecordInput): Promise<string>` returning the signed event id. Task 5 calls it.

- [ ] **Step 1: Add the port to the kernel**

In `packages/kernel/src/ports.ts`, beside `BuildplaneAcceptancePort`:

```ts
export interface PlanAdmissionRecordInput {
	readonly planId: string;
	readonly planDigest: string;
	readonly inputDigest: string;
	readonly trustedBase: string;
	readonly decidedBy: string;
	/** RFC3339 admission timestamp. */
	readonly decidedAt: string;
	readonly idempotencyKey: string;
	/** Next step this admission authorizes, e.g. `dispatch`. */
	readonly authorizedNextStep: string;
}

/**
 * Kernel-facing seam for appending the signed `plan_admitted` event. Mirrors
 * {@link BuildplaneAcceptancePort}: the concrete impl lives in the CLI layer and
 * wraps a signed ledger TapeEmitter. Resolves only once the event is durably on
 * the tape, so a dispatch can name the returned id as its `provenance_ref`.
 */
export interface PlanAdmissionPort {
	recordPlanAdmission(input: PlanAdmissionRecordInput): Promise<string>;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/cli/test/plan-admission-port.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPlanAdmissionPort } from "../src/plan-admission-port.js";

const INPUT = {
	planId: "pf-plan-abcd1234",
	planDigest: "sha256:aa",
	inputDigest: "sha256:bb",
	trustedBase: "c".repeat(40),
	decidedBy: "operator-1",
	decidedAt: "2026-07-31T00:00:00Z",
	idempotencyKey: "planforge:v0:buildplane:base:abcd1234",
	authorizedNextStep: "dispatch",
};

describe("createPlanAdmissionPort", () => {
	it("emits plan_admitted and returns the signed event id", async () => {
		const emit = vi.fn(async () => "evt-000000000042");
		const port = createPlanAdmissionPort({ emit });

		const eventId = await port.recordPlanAdmission(INPUT);

		expect(eventId).toBe("evt-000000000042");
		expect(emit).toHaveBeenCalledTimes(1);
		const [kind, payload] = emit.mock.calls[0];
		expect(kind).toBe("plan_admitted");
		expect(payload).toEqual({
			plan_id: "pf-plan-abcd1234",
			plan_digest: "sha256:aa",
			input_digest: "sha256:bb",
			trusted_base: "c".repeat(40),
			decided_by: "operator-1",
			decided_at: "2026-07-31T00:00:00Z",
			idempotency_key: "planforge:v0:buildplane:base:abcd1234",
			authorized_next_step: "dispatch",
		});
	});

	it("propagates an emit failure rather than returning an unusable id", async () => {
		const emit = vi.fn(async () => {
			throw new Error("tape unavailable");
		});
		const port = createPlanAdmissionPort({ emit });

		await expect(port.recordPlanAdmission(INPUT)).rejects.toThrow(
			/tape unavailable/,
		);
	});

	it("rejects an empty event id from the emitter", async () => {
		const emit = vi.fn(async () => "");
		const port = createPlanAdmissionPort({ emit });

		await expect(port.recordPlanAdmission(INPUT)).rejects.toThrow(
			/did not return a signed event id/i,
		);
	});
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -C . exec vitest run apps/cli/test/plan-admission-port.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `apps/cli/src/plan-admission-port.ts`:

```ts
import type {
	PlanAdmissionPort,
	PlanAdmissionRecordInput,
} from "@buildplane/kernel";

/**
 * Minimal seam over the signed tape emitter. `plan_admitted` is deliberately NOT
 * in the emitter's caller-supplied denylist, so it may be emitted from here —
 * unlike the V5 dispatch admission, which is native-only.
 */
export interface PlanAdmissionEmitter {
	emit(kind: string, payload: Record<string, string>): Promise<string>;
}

export function createPlanAdmissionPort(
	emitter: PlanAdmissionEmitter,
): PlanAdmissionPort {
	return {
		async recordPlanAdmission(
			input: PlanAdmissionRecordInput,
		): Promise<string> {
			const eventId = await emitter.emit("plan_admitted", {
				plan_id: input.planId,
				plan_digest: input.planDigest,
				input_digest: input.inputDigest,
				trusted_base: input.trustedBase,
				decided_by: input.decidedBy,
				decided_at: input.decidedAt,
				idempotency_key: input.idempotencyKey,
				authorized_next_step: input.authorizedNextStep,
			});
			if (!eventId) {
				throw new Error(
					"plan_admitted emitter did not return a signed event id.",
				);
			}
			return eventId;
		},
	};
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -C . exec vitest run apps/cli/test/plan-admission-port.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/ports.ts apps/cli/src/plan-admission-port.ts \
        apps/cli/test/plan-admission-port.test.ts
git commit -m "feat(kernel): add the plan-admission port and its cli implementation"
```

---

## Task 5: Wire `planforge admit`

**Files:**
- Modify: `apps/cli/src/run-cli.ts` (the `runPlanForgeAdmitCommand` function)
- Test: `apps/cli/test/planforge-admit-command.test.ts` (create)

**Interfaces:**
- Consumes: `createPlanAdmissionPort` (Task 4), `buildPlanAdmittedPayload` (`@buildplane/planforge`).
- Produces: `planforge admit --input <file> --approve [--json]` emits `plan_admitted` and prints its event id.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/planforge-admit-command.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePlanForgeBrokerAdmitArguments } from "../src/run-cli.js";

describe("planforge admit argument parsing", () => {
	it("accepts --input, --approve and --json", () => {
		const parsed = parsePlanForgeBrokerAdmitArguments([
			"--input",
			"goal.md",
			"--approve",
			"--json",
		]);
		expect(parsed).toEqual({ inputPath: "goal.md", json: true });
	});

	it("still requires explicit --approve", () => {
		expect(() =>
			parsePlanForgeBrokerAdmitArguments(["--input", "goal.md"]),
		).toThrow(/requires explicit --approve/i);
	});

	it("still rejects --operator", () => {
		expect(() =>
			parsePlanForgeBrokerAdmitArguments([
				"--input",
				"goal.md",
				"--approve",
				"--operator",
				"op-1",
			]),
		).toThrow(/Unsupported PlanForge governed admit argument/i);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C . exec vitest run apps/cli/test/planforge-admit-command.test.ts`
Expected: FAIL — `parsePlanForgeBrokerAdmitArguments` is not exported.

- [ ] **Step 3: Export the parser**

In `apps/cli/src/run-cli.ts`, change the declaration of `parsePlanForgeBrokerAdmitArguments` from:

```ts
function parsePlanForgeBrokerAdmitArguments(
```

to:

```ts
export function parsePlanForgeBrokerAdmitArguments(
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C . exec vitest run apps/cli/test/planforge-admit-command.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit the parser test**

```bash
git add apps/cli/src/run-cli.ts apps/cli/test/planforge-admit-command.test.ts
git commit -m "test(cli): pin the planforge admit argument contract"
```

**Note on the admit path itself:** replacing the `broker.admitPlanForge(...)` throw requires a live protected host to mint the sealed V5 admission, which is native-only (spec §11 Q1). That wiring is proven end-to-end by Task 6 against the roundtrip harness, not by a unit test here. Do **not** stub a fake admission to make a unit test pass — a fake admission is exactly the rigging the spec's dogfooding section calls out.

---

## Task 6: End-to-end proof and signed-tape verification

**Files:**
- Create: `test/ledger-integration/planforge-preauthorized-dispatch.test.ts`

**Interfaces:**
- Consumes: everything above, plus `makeBuildplaneRunFixture` from `./fixtures.js`.
- Produces: the slice's acceptance evidence.

- [ ] **Step 1: Build native**

Run: `pnpm native:build`
Expected: `native/target/debug/buildplane-native` exists. Ledger-integration tests require it.

- [ ] **Step 2: Write the end-to-end test**

Create `test/ledger-integration/planforge-preauthorized-dispatch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeBuildplaneRunFixture } from "./fixtures.js";

describe("planforge preauthorized dispatch", () => {
	it("records plan_admitted and names it as the dispatch provenance_ref", async () => {
		const fixture = await makeBuildplaneRunFixture({
			packet: {
				unit: {
					id: "unit-preauth",
					kind: "command",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["a.txt"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				execution: {
					command: "sh",
					args: ["-c", "echo a > a.txt"],
				},
				verification: { requiredOutputs: ["a.txt"] },
			},
		});

		const kinds = fixture.events.map((event) => event.kind);
		expect(kinds).toContain("plan_admitted");

		const admission = fixture.events.find(
			(event) => event.kind === "plan_admitted",
		);
		expect(admission).toBeDefined();

		const dispatch = fixture.events.find((event) =>
			event.kind.startsWith("dispatch_envelope"),
		);
		expect(dispatch).toBeDefined();
		expect(dispatch?.payload.provenance_ref).toBe(admission?.id);
		expect(dispatch?.payload.provenance_ref).not.toBe("");
	});
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -C . exec vitest run test/ledger-integration/planforge-preauthorized-dispatch.test.ts`
Expected: FAIL — no `plan_admitted` on the tape, because nothing emits one yet in this fixture path.

- [ ] **Step 4: Wire the fixture to record a plan admission**

In `test/ledger-integration/fixtures.ts`, have `makeBuildplaneRunFixture` construct a `createPlanAdmissionPort` over the fixture's existing signed emitter, call `recordPlanAdmission` before the dispatch is built, and set the resulting event id as the packet's `provenance_ref`. Follow the pattern the fixture already uses for the acceptance port.

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm -C . exec vitest run test/ledger-integration/planforge-preauthorized-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the signed tape externally**

Run: `node scripts/verify-signed-tape.mjs <path-to-fixture-events.db>`
Expected: exit 0, every event Ed25519-verified. This is acceptance criterion 5 and is not satisfied by vitest alone.

- [ ] **Step 7: Run the full ledger-integration suite**

Run: `pnpm -C . exec vitest run test/ledger-integration`
Expected: PASS. Note `cli-graph` / `graph-e2e` are `.skip`, and a known `process.chdir` parallel flake exists in `fixtures.ts` — re-run once before treating a failure there as real.

- [ ] **Step 8: Commit**

```bash
git add test/ledger-integration/planforge-preauthorized-dispatch.test.ts \
        test/ledger-integration/fixtures.ts
git commit -m "test(ledger): prove preauthorized dispatch binds plan_admitted provenance"
```

---

## Final verification

- [ ] `cargo test --manifest-path native/Cargo.toml` — whole workspace, no `-p`
- [ ] `pnpm -C . exec vitest run packages/kernel/test apps/cli/test test/ledger-integration`
- [ ] `pnpm typecheck`
- [ ] `node_modules/.bin/biome check <changed files>`
- [ ] `node scripts/verify-signed-tape.mjs <fixture events.db>` → exit 0
- [ ] `git diff --exit-code packages/ledger-client/src/generated packages/ledger-client/fixtures` → clean (this slice adds no event kind, so these MUST be untouched)

## Acceptance (spec §9)

| # | Criterion | Proven by |
|---|---|---|
| 1 | `PreauthorizationRef` accepted when provenance matches | Task 1 test 2, Task 6 |
| 2 | Rejected when absent / mismatched / unsupported variant | Task 1 tests 3–5 |
| 3 | Empty `provenance_ref` rejected, not skipped | Task 3 tests 2–3 |
| 4 | Acceptance-contract digest domains reconciled | **Deferred — see below** |
| 5 | `verify-signed-tape.mjs` exits 0 | Task 6 step 6 |

## Deliberate deferrals

**Criterion 4 (digest-domain reconciliation) is not in this slice.** PlanForge derives an acceptance-contract digest with undomained canonical-JSON sha256 while the trust spine uses domain-separated declaration-ordered serde (spec §8.1). Nothing in this slice places a PlanForge-derived digest into an envelope — the fixture path builds envelopes as it does today — so the mismatch is not yet reachable. It becomes load-bearing the moment a real PlanForge task is mapped to a packet, which is slice 2. Pulling it in here would add a cross-package derivation with no consumer.

**`plan_admitted` signature verification inside the broker is not in this slice.** Task 1 binds the preauthorization to the admission's `provenance_ref`, and `resolve_governed_v5_candidate_authority_v1` has already validated that admission's signer and window. Verifying the referenced `plan_admitted` event's own kernel signature is defence-in-depth requiring a new store read path in the broker. It is the first item of slice 2.
