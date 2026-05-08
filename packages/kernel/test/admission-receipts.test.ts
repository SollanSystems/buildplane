import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunAdmissionReceiptDryRun } from "../src/index";

type JsonRecord = Record<string, unknown>;

function loadFixture(name: string): JsonRecord {
	return JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"fixtures",
				"admission-receipts",
				`${name}.json`,
			),
			"utf8",
		),
	) as JsonRecord;
}

function admissionInputFromFixture(fixture: JsonRecord) {
	const policy = fixture.policy as { profile_id: string };
	return {
		receiptId: `${fixture.receipt_id as string}-dry-run`,
		decidedAt: "2026-05-08T00:00:00Z",
		run: fixture.run,
		repo: fixture.repo,
		request: fixture.request,
		policyProfileId: policy.profile_id,
		evidenceInputs: fixture.evidence_inputs,
		actor: "buildplane.kernel.admission",
		source: "unit-test",
	};
}

describe("createRunAdmissionReceiptDryRun", () => {
	it("emits a deterministic PASS receipt from present evidence and scoped local side effects", () => {
		const fixture = loadFixture("pass");
		const input = admissionInputFromFixture(fixture);

		const receipt = createRunAdmissionReceiptDryRun(input);
		const repeatedReceipt = createRunAdmissionReceiptDryRun(input);
		const sameAdmissionDifferentAttempt = createRunAdmissionReceiptDryRun({
			...input,
			receiptId: "rar_second_attempt",
			decidedAt: "2030-01-01T00:00:00Z",
		});

		expect(JSON.stringify(receipt)).toBe(JSON.stringify(repeatedReceipt));
		expect(receipt.idempotency_key).toBe(
			sameAdmissionDifferentAttempt.idempotency_key,
		);
		expect(receipt).toMatchObject({
			schema_version: "0.1.0",
			receipt_type: "run.admission",
			run: fixture.run,
			repo: fixture.repo,
			admission: {
				decision: "PASS",
				decided_by: "buildplane.kernel.admission",
				decided_at: "2026-05-08T00:00:00Z",
				missing_evidence: [],
				unsafe_requests: [],
				will_execute_worker: false,
				authorized_next_step: "record_admission_only",
			},
			replay: {
				side_effect_safe: true,
			},
			provenance: {
				created_by: "buildplane.kernel.admission",
				created_from: "unit-test",
				pack: null,
				host: null,
				provider: null,
				worker_agent_trusted: false,
			},
		});
		expect(receipt.policy.allowed_side_effects).toEqual([
			"fs.read:repo",
			"fs.write:declared_scope",
			"command.execute:verification",
		]);
		expect(
			receipt.policy.denied_side_effects.map(({ effect }) => effect),
		).toEqual(["git.push:remote", "github.pr.create", "deploy:production"]);
		expect(receipt.idempotency_key).toMatch(/^run\.admission:v0:sha256:/);
	});

	it("fails closed as INSUFFICIENT_EVIDENCE when required evidence is missing", () => {
		const fixture = loadFixture("insufficient-evidence");

		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture(fixture),
		);

		expect(receipt.admission.decision).toBe("INSUFFICIENT_EVIDENCE");
		expect(receipt.admission.missing_evidence).toEqual(["git.status"]);
		expect(receipt.admission.unsafe_requests).toEqual([]);
		expect(receipt.admission.will_execute_worker).toBe(false);
		expect(receipt.admission.authorized_next_step).toBe(
			"capture_missing_evidence_then_recompute_admission",
		);
		expect(receipt.policy.allowed_side_effects).toEqual([]);
		expect(receipt.policy.capability_grants).toEqual([]);
		expect(receipt.policy.quarantine).toBe(false);
	});

	it("fails closed as UNSAFE_TO_RUN and revokes non-read grants for unsafe side effects", () => {
		const fixture = loadFixture("unsafe-to-run");

		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture(fixture),
		);

		expect(receipt.admission.decision).toBe("UNSAFE_TO_RUN");
		expect(receipt.admission.missing_evidence).toEqual([]);
		expect(receipt.admission.unsafe_requests).toEqual([
			"git.push:remote",
			"github.pr.create",
			"deploy:production",
		]);
		expect(receipt.admission.will_execute_worker).toBe(false);
		expect(receipt.admission.authorized_next_step).toBe(
			"freeze_and_require_explicit_release_authority",
		);
		expect(receipt.policy.allowed_side_effects).toEqual(["fs.read:repo"]);
		expect(receipt.policy.capability_grants).toEqual([
			{
				capability: "fs.read:repo",
				scope: ["/repo/buildplane"],
				expires_at: null,
			},
		]);
		expect(receipt.policy.quarantine).toBe(true);
		expect(
			receipt.policy.denied_side_effects.map(({ effect }) => effect),
		).toEqual([
			"fs.write:declared_scope",
			"command.execute:verification",
			"git.push:remote",
			"github.pr.create",
			"deploy:production",
		]);
	});
});
