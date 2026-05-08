import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createRunAdmissionReceiptDryRun,
	type RunAdmissionDecision,
	type RunAdmissionLocalEvidenceStore,
	type RunAdmissionReceipt,
	recordRunAdmissionReceiptAttempt,
} from "../src/index";

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

function withoutEvidenceKind(fixture: JsonRecord, kind: string): JsonRecord {
	const evidenceInputs = fixture.evidence_inputs as readonly JsonRecord[];
	return {
		...fixture,
		evidence_inputs: evidenceInputs.filter(
			(evidence) => evidence.kind !== kind,
		),
	};
}

function withoutRepoField(fixture: JsonRecord, field: string): JsonRecord {
	const repo = { ...(fixture.repo as JsonRecord) } as Record<string, unknown>;
	delete repo[field];
	return {
		...fixture,
		repo: repo as JsonRecord,
	};
}

function withRequestedSideEffects(
	fixture: JsonRecord,
	requestedSideEffects: readonly string[],
): JsonRecord {
	const request = fixture.request as JsonRecord;
	return {
		...fixture,
		request: {
			...request,
			requested_capabilities: requestedSideEffects,
			requested_side_effects: requestedSideEffects,
		},
	};
}

function createTempEvidenceStore(): RunAdmissionLocalEvidenceStore & {
	readonly root: string;
	readonly forbiddenWorkerExecutor: ReturnType<typeof vi.fn>;
	readonly forbiddenGithubMutation: ReturnType<typeof vi.fn>;
	readonly forbiddenNetworkMutation: ReturnType<typeof vi.fn>;
	readonly forbiddenKanbanWrite: ReturnType<typeof vi.fn>;
	readonly forbiddenPush: ReturnType<typeof vi.fn>;
	readonly forbiddenDeploy: ReturnType<typeof vi.fn>;
	readonly forbiddenPullRequest: ReturnType<typeof vi.fn>;
	readonly forbiddenMerge: ReturnType<typeof vi.fn>;
} {
	const root = mkdtempSync(join(tmpdir(), "buildplane-admission-"));
	const store = {
		root,
		writeReceiptArtifact: vi.fn(({ receiptDigest, contents }) => {
			const receiptPath = join(
				root,
				"receipts",
				`${receiptDigest.replace("sha256:", "")}.json`,
			);
			mkdirSync(join(root, "receipts"), { recursive: true });
			writeFileSync(receiptPath, `${contents}\n`, "utf8");
			return { ref: `file://${receiptPath}`, path: receiptPath };
		}),
		appendAdmissionEvent: vi.fn(({ event }) => {
			const eventPath = join(
				root,
				"events",
				`${event.payload.receipt_digest.replace("sha256:", "")}.json`,
			);
			mkdirSync(join(root, "events"), { recursive: true });
			writeFileSync(eventPath, `${JSON.stringify(event)}\n`, "utf8");
			return { ref: `file://${eventPath}`, path: eventPath };
		}),
		forbiddenWorkerExecutor: vi.fn(),
		forbiddenGithubMutation: vi.fn(),
		forbiddenNetworkMutation: vi.fn(),
		forbiddenKanbanWrite: vi.fn(),
		forbiddenPush: vi.fn(),
		forbiddenDeploy: vi.fn(),
		forbiddenPullRequest: vi.fn(),
		forbiddenMerge: vi.fn(),
	};
	return store;
}

function expectNoForbiddenSideEffects(
	store: ReturnType<typeof createTempEvidenceStore>,
): void {
	expect(store.forbiddenWorkerExecutor).not.toHaveBeenCalled();
	expect(store.forbiddenGithubMutation).not.toHaveBeenCalled();
	expect(store.forbiddenNetworkMutation).not.toHaveBeenCalled();
	expect(store.forbiddenKanbanWrite).not.toHaveBeenCalled();
	expect(store.forbiddenPush).not.toHaveBeenCalled();
	expect(store.forbiddenDeploy).not.toHaveBeenCalled();
	expect(store.forbiddenPullRequest).not.toHaveBeenCalled();
	expect(store.forbiddenMerge).not.toHaveBeenCalled();
}

function withAdmissionDecision(
	receipt: RunAdmissionReceipt,
	decision: RunAdmissionDecision,
): RunAdmissionReceipt {
	return {
		...receipt,
		admission: {
			...receipt.admission,
			decision,
			will_execute_worker: false,
			authorized_next_step:
				decision === "FAILED"
					? "fix_admission_input_then_recompute"
					: "wait_for_explicit_operator_authority",
		},
		policy: {
			...receipt.policy,
			allowed_side_effects: [],
			capability_grants: [],
		},
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

	it.each([
		"git.status",
		"git.rev-parse",
		"declared_scope",
	])("fails closed when required %s evidence is absent from otherwise present inputs", (kind) => {
		const fixture = withoutEvidenceKind(loadFixture("pass"), kind);

		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture(fixture),
		);

		expect(receipt.admission.decision).toBe("INSUFFICIENT_EVIDENCE");
		expect(receipt.admission.missing_evidence).toEqual([kind]);
		expect(receipt.admission.unsafe_requests).toEqual([]);
		expect(receipt.policy.allowed_side_effects).toEqual([]);
		expect(receipt.policy.capability_grants).toEqual([]);
		expect(receipt.policy.quarantine).toBe(false);
	});

	it("fails closed when evidence inputs are omitted and repo binding is absent", () => {
		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture({
				...loadFixture("pass"),
				repo: {},
				evidence_inputs: [],
			}),
		);

		expect(receipt.admission.decision).toBe("INSUFFICIENT_EVIDENCE");
		expect(receipt.admission.missing_evidence).toEqual(
			expect.arrayContaining([
				"git.status",
				"git.rev-parse",
				"declared_scope",
				"repo.path",
				"repo.worktree_path",
				"repo.expected_remote",
				"repo.base_ref",
				"repo.base_commit",
				"repo.head_commit",
				"repo.worktree_clean",
			]),
		);
		expect(receipt.policy.allowed_side_effects).toEqual([]);
		expect(receipt.policy.capability_grants).toEqual([]);
	});

	it.each([
		"path",
		"worktree_path",
		"expected_remote",
		"base_ref",
		"base_commit",
		"head_commit",
		"worktree_clean",
	])("fails closed when repo binding omits %s", (field) => {
		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture(withoutRepoField(loadFixture("pass"), field)),
		);

		expect(receipt.admission.decision).toBe("INSUFFICIENT_EVIDENCE");
		expect(receipt.admission.missing_evidence).toEqual([`repo.${field}`]);
		expect(receipt.policy.allowed_side_effects).toEqual([]);
		expect(receipt.policy.capability_grants).toEqual([]);
	});

	it("fails closed as UNSAFE_TO_RUN for unknown auto-Kanban side effects", () => {
		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture(
				withRequestedSideEffects(loadFixture("pass"), [
					"fs.read:repo",
					"kanban.write:auto",
				]),
			),
		);

		expect(receipt.admission.decision).toBe("UNSAFE_TO_RUN");
		expect(receipt.admission.missing_evidence).toEqual([]);
		expect(receipt.admission.unsafe_requests).toEqual(["kanban.write:auto"]);
		expect(receipt.admission.will_execute_worker).toBe(false);
		expect(receipt.policy.allowed_side_effects).toEqual(["fs.read:repo"]);
		expect(receipt.policy.capability_grants).toEqual([
			{
				capability: "fs.read:repo",
				scope: ["/repo/buildplane"],
				expires_at: null,
			},
		]);
		expect(receipt.policy.quarantine).toBe(true);
		expect(receipt.policy.denied_side_effects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ effect: "kanban.write:auto" }),
			]),
		);
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

describe("recordRunAdmissionReceiptAttempt", () => {
	it("records a PASS admission deterministically as local evidence without implying broader side effects", async () => {
		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture(loadFixture("pass")),
		);
		const store = createTempEvidenceStore();

		const firstRecord = await recordRunAdmissionReceiptAttempt({
			receipt,
			store,
		});
		const secondRecord = await recordRunAdmissionReceiptAttempt({
			receipt,
			store,
		});

		expect(firstRecord.payload).toEqual(secondRecord.payload);
		expect(firstRecord.event.kind).toBe("run_admission_recorded");
		expect(firstRecord.payload).toMatchObject({
			receipt_id: receipt.receipt_id,
			receipt_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			receipt_ref: firstRecord.receipt_ref,
			idempotency_key: receipt.idempotency_key,
			decision: "PASS",
			policy_profile_id: "local-docs-fixture-v0",
			requested_side_effects: receipt.request.requested_side_effects,
			allowed_side_effects: receipt.policy.allowed_side_effects,
			missing_evidence: [],
			unsafe_requests: [],
			quarantine: false,
			will_execute_worker: false,
			authorized_next_step: "record_admission_only",
			decided_by: "buildplane.kernel.admission",
			decided_at: "2026-05-08T00:00:00Z",
		});
		expect(
			firstRecord.payload.denied_side_effects.map(({ effect }) => effect),
		).toEqual(["git.push:remote", "github.pr.create", "deploy:production"]);
		expect(firstRecord.event.replay).toMatchObject({
			side_effect_safe: true,
			allowed_actions: ["inspect_receipt", "verify_receipt_digest"],
			forbidden_side_effects: expect.arrayContaining([
				"worker.execute",
				"github.pr.create",
				"network.mutate",
				"kanban.write:auto",
				"git.push:remote",
				"deploy:production",
				"git.merge",
			]),
		});
		expect(readFileSync(firstRecord.receipt_path, "utf8").trim()).toBe(
			firstRecord.receipt_json,
		);
		expectNoForbiddenSideEffects(store);
	});

	it("records missing evidence as INSUFFICIENT_EVIDENCE and never calls a worker executor", async () => {
		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture(loadFixture("insufficient-evidence")),
		);
		const store = createTempEvidenceStore();

		const record = await recordRunAdmissionReceiptAttempt({ receipt, store });

		expect(record.payload.decision).toBe("INSUFFICIENT_EVIDENCE");
		expect(record.payload.missing_evidence).toEqual(["git.status"]);
		expect(record.payload.allowed_side_effects).toEqual([]);
		expect(record.payload.will_execute_worker).toBe(false);
		expect(record.event.replay.side_effect_safe).toBe(true);
		expectNoForbiddenSideEffects(store);
	});

	it("records unsafe requested side effects as UNSAFE_TO_RUN and only persists local evidence", async () => {
		const receipt = createRunAdmissionReceiptDryRun(
			admissionInputFromFixture(loadFixture("unsafe-to-run")),
		);
		const store = createTempEvidenceStore();

		const record = await recordRunAdmissionReceiptAttempt({ receipt, store });

		expect(record.payload.decision).toBe("UNSAFE_TO_RUN");
		expect(record.payload.unsafe_requests).toEqual([
			"git.push:remote",
			"github.pr.create",
			"deploy:production",
		]);
		expect(record.payload.quarantine).toBe(true);
		expect(record.payload.will_execute_worker).toBe(false);
		expect(record.payload.allowed_side_effects).toEqual(["fs.read:repo"]);
		expect(record.event.replay.forbidden_side_effects).toEqual(
			expect.arrayContaining([
				"github.pr.create",
				"git.push:remote",
				"deploy:production",
			]),
		);
		expect(store.writeReceiptArtifact).toHaveBeenCalledTimes(1);
		expect(store.appendAdmissionEvent).toHaveBeenCalledTimes(1);
		expectNoForbiddenSideEffects(store);
	});

	it.each([
		"BLOCKED",
		"FAILED",
	] as const)("records %s attempts fail-closed without dispatch authority", async (decision) => {
		const receipt = withAdmissionDecision(
			createRunAdmissionReceiptDryRun(
				admissionInputFromFixture(loadFixture("pass")),
			),
			decision,
		);
		const store = createTempEvidenceStore();

		const record = await recordRunAdmissionReceiptAttempt({ receipt, store });

		expect(record.payload.decision).toBe(decision);
		expect(record.payload.allowed_side_effects).toEqual([]);
		expect(record.payload.will_execute_worker).toBe(false);
		expect(record.event.replay.side_effect_safe).toBe(true);
		expectNoForbiddenSideEffects(store);
	});
});
