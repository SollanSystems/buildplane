import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	RejectedPolicyDecision,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import {
	createBuildplaneStorage,
	exportRunBundle,
	verifyRunFinalVerdict,
} from "../src";

const packet: UnitPacket = {
	unit: {
		id: "unit-finalize",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: ["tmp/out.txt"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	intent: {
		objective: "Finalize from verifier evidence only.",
		taskType: "implement",
		context: { files: [] },
		constraints: {
			scope: ["tmp/**"],
			forbidden: ["no deploy"],
			verification: ["verifier receipt required"],
		},
		features: {
			ambiguity: "low",
			reversibility: "easy",
			verifierStrength: "strong",
		},
	},
	execution: {
		command: "node",
		args: ["-e", "console.log('worker says pass')"],
	},
	verification: {
		requiredOutputs: ["tmp/out.txt"],
	},
};

const receipt: ExecutionReceipt = {
	command: "node",
	args: ["-e", "console.log('worker says pass')"],
	cwd: ".",
	startedAt: "2026-05-04T10:00:00.000Z",
	completedAt: "2026-05-04T10:00:01.000Z",
	exitCode: 0,
	stdout: "worker says pass\n",
	stderr: "",
	outputChecks: [{ path: "tmp/out.txt", exists: true }],
};

const approved: ApprovedPolicyDecision = {
	kind: "advance-run",
	outcome: "approved",
	reasons: ["verifier receipts satisfy acceptance criteria"],
};

const rejectedUnsafe: RejectedPolicyDecision = {
	kind: "reject-run",
	outcome: "rejected",
	reasons: ["unsafe: command attempted file write outside granted scope"],
};

function createStorage(root: string) {
	const storage = createBuildplaneStorage(root);
	storage.initializeProject();
	return storage;
}

describe("receipt-backed final verdict verification", () => {
	it("blocks a worker-claimed passed run when required verifier receipts are missing", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-final-missing-evidence-"),
		);
		const storage = createStorage(root);
		const run = storage.createRun(packet, {
			runId: "run-final-missing-evidence",
		});
		storage.markRunRunning(run.id);
		storage.recordDecision(run.id, approved);
		storage.completeRun(run.id, "passed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });
		const bundle = exportRunBundle(root, { runId: run.id });

		expect(report.verdict).toBe("BLOCKED");
		expect(report.criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "required-output:tmp/out.txt",
					status: "INSUFFICIENT_EVIDENCE",
				}),
				expect.objectContaining({
					id: "command-exit:0",
					status: "INSUFFICIENT_EVIDENCE",
				}),
			]),
		);
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "MISSING_VERIFIER_RECEIPT" }),
			]),
		);
		expect(bundle.run.status).toBe("blocked");
		expect(bundle.run.verdict).toBe("blocked");
		expect(bundle.run.unverified_criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "required-output:tmp/out.txt" }),
				expect.objectContaining({ id: "command-exit:0" }),
			]),
		);
	});

	it("allows passed only when verifier receipts and approval evidence exist", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-final-pass-"));
		const storage = createStorage(root);
		const run = storage.createRun(packet, { runId: "run-final-pass" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, approved);
		storage.completeRun(run.id, "passed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });

		expect(report.verdict).toBe("PASSED");
		expect(report.criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "required-output:tmp/out.txt",
					status: "PASSED",
				}),
				expect.objectContaining({
					id: "command-exit:0",
					status: "PASSED",
				}),
			]),
		);
		expect(report.issues).toEqual([]);
		expect(report.receipts.verifier).toBe(2);
	});

	it("fails when verifier command receipts record failed evidence", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-final-failed-"));
		const storage = createStorage(root);
		const run = storage.createRun(packet, { runId: "run-final-failed" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			...receipt,
			exitCode: 1,
			outputChecks: [{ path: "tmp/out.txt", exists: false }],
		});
		storage.completeRun(run.id, "failed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });

		expect(report.verdict).toBe("FAILED");
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "FAILED_VERIFIER_RECEIPT" }),
			]),
		);
		expect(report.criteria).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "FAILED" })]),
		);
	});

	it("returns unsafe-to-run for safety policy violations", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-final-unsafe-"));
		const storage = createStorage(root);
		const run = storage.createRun(packet, { runId: "run-final-unsafe" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, rejectedUnsafe);
		storage.completeRun(run.id, "failed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });

		expect(report.verdict).toBe("UNSAFE_TO_RUN");
		expect(report.issues).toEqual([
			expect.objectContaining({ code: "UNSAFE_TO_RUN" }),
		]);
	});
});
