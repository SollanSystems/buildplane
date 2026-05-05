import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ApprovedPolicyDecision,
	ExecutionReceipt,
	RejectedPolicyDecision,
	UnitPacket,
} from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { createBuildplaneStorage, exportRunBundle } from "../src";

const basePacket: UnitPacket = {
	unit: {
		id: "unit-export",
		kind: "command",
		scope: "task",
		inputRefs: ["README.md"],
		expectedOutputs: ["tmp/out.txt"],
		verificationContract: "exit-0-and-required-outputs",
		policyProfile: "default",
	},
	intent: {
		objective: "Produce a verified output file for Mission Control import.",
		taskType: "implement",
		context: {
			files: ["README.md"],
		},
		constraints: {
			scope: ["tmp/**"],
			forbidden: ["no deploy"],
			verification: ["required output must exist"],
		},
		features: {
			ambiguity: "low",
			reversibility: "easy",
			verifierStrength: "strong",
		},
	},
	execution: {
		command: "node",
		args: ["-e", "console.log('worker claim: wrote file')"],
	},
	verification: {
		requiredOutputs: ["tmp/out.txt"],
	},
};

const receipt: ExecutionReceipt = {
	command: "node",
	args: ["-e", "console.log('worker claim: wrote file')"],
	cwd: ".",
	startedAt: "2026-05-04T10:00:00.000Z",
	completedAt: "2026-05-04T10:00:01.000Z",
	exitCode: 0,
	stdout: "worker claim: wrote file\n",
	stderr: "",
	outputChecks: [{ path: "tmp/out.txt", exists: true }],
};

const approved: ApprovedPolicyDecision = {
	kind: "advance-run",
	outcome: "approved",
	reasons: ["required output exists"],
};

const rejected: RejectedPolicyDecision = {
	kind: "reject-run",
	outcome: "rejected",
	reasons: ["required output missing"],
};

function createInitializedStorage(root: string) {
	const storage = createBuildplaneStorage(root);
	storage.initializeProject();
	return storage;
}

describe("Mission Control run bundle export", () => {
	it("exports a passed run with worker command claims separated from verifier receipts", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-run-bundle-pass-"));
		const storage = createInitializedStorage(root);
		const run = storage.createRun(basePacket, { runId: "run-export-pass" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receipt);
		storage.recordDecision(run.id, approved);
		storage.completeRun(run.id, "passed");

		const outPath = join(root, "bundle.json");
		const bundle = exportRunBundle(root, { runId: run.id, outPath });

		expect(existsSync(outPath)).toBe(true);
		expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(bundle);
		expect(bundle.kind).toBe("run_bundle");
		expect(bundle.schema_version).toBe("1.0");
		expect(bundle.source).toMatchObject({ system: "buildplane" });
		expect(bundle.run).toMatchObject({
			id: run.id,
			schema_version: "1.0",
			goal: "Produce a verified output file for Mission Control import.",
			status: "passed",
			verdict: "passed",
		});
		expect(bundle.run.manifest_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(bundle.run.verified_criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "required-output:tmp/out.txt",
					status: "verified",
				}),
				expect.objectContaining({
					id: "command-exit:0",
					status: "verified",
				}),
			]),
		);
		expect(bundle.run.unverified_criteria).toEqual([]);
		expect(bundle.run.blockers).toEqual([]);

		const workerEvent = bundle.events.find(
			(event) =>
				event.kind === "tool_call" && event.actor.id === "buildplane.runtime",
		);
		const verifierEvent = bundle.events.find(
			(event) =>
				event.kind === "assertion_check" &&
				event.actor.id === "buildplane.verifier",
		);
		expect(workerEvent).toBeDefined();
		expect(verifierEvent).toBeDefined();
		expect(verifierEvent?.verification_state).toBe("passed");
		expect(bundle.run.verified_criteria[0]?.evidence_event_id).toBe(
			verifierEvent?.id,
		);
		expect(bundle.run.verified_criteria[0]?.evidence_event_id).not.toBe(
			workerEvent?.id,
		);
		expect(verifierEvent?.parent_event_id).toBe(workerEvent?.id);

		for (const event of bundle.events) {
			expect(event.run_id).toBe(run.id);
			for (const artifactRef of event.artifact_refs) {
				const artifact = bundle.artifacts.find(
					(item) => item.id === artifactRef,
				);
				expect(artifact).toBeDefined();
				expect(artifact?.produced_by_event_id).toBe(event.id);
			}
		}
	});

	it("exports workspace-backed required output bytes from durable artifact storage", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-run-bundle-workspace-"),
		);
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "buildplane-run-bundle-workspace-output-"),
		);
		mkdirSync(join(workspaceRoot, "tmp"), { recursive: true });
		writeFileSync(
			join(workspaceRoot, "tmp", "out.txt"),
			"durable workspace artifact\n",
		);
		const storage = createInitializedStorage(root);
		const run = storage.createRun(basePacket, {
			runId: "run-export-workspace",
		});
		storage.recordWorkspacePrepared(run.id, {
			path: workspaceRoot,
			headSha: "abc123",
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			...receipt,
			cwd: workspaceRoot,
		});
		storage.commitRunSuccessOutcome(run.id, approved);

		const bundle = exportRunBundle(root, { runId: run.id });
		const verifierEvent = bundle.events.find(
			(event) =>
				event.kind === "assertion_check" && event.target === "tmp/out.txt",
		);
		const artifactLocation = `.buildplane/artifacts/${run.id}/tmp/out.txt`;
		const outputArtifact = bundle.artifacts.find(
			(artifact) =>
				artifact.kind === "file" &&
				artifact.produced_by_event_id === verifierEvent?.id,
		);

		expect(bundle.run.changed_files).toContain(artifactLocation);
		expect(outputArtifact).toBeDefined();
		expect(outputArtifact?.bytes).toBe("durable workspace artifact\n");
		expect(outputArtifact?.uri).toBeUndefined();
		expect(outputArtifact?.preview.title).toBe(artifactLocation);
	});

	it("exports failed verifier output as failed evidence without upgrading worker output to acceptance evidence", () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-run-bundle-fail-"));
		const storage = createInitializedStorage(root);
		const run = storage.createRun(basePacket, { runId: "run-export-fail" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			...receipt,
			exitCode: 1,
			stdout: "worker claim: file created\n",
			stderr: "Error: output missing\n",
			outputChecks: [{ path: "tmp/out.txt", exists: false }],
		});
		storage.recordDecision(run.id, rejected);
		storage.completeRun(run.id, "failed");

		const bundle = exportRunBundle(root, { runId: run.id });

		expect(bundle.run.status).toBe("failed");
		expect(bundle.run.verdict).toBe("failed");
		expect(bundle.run.verified_criteria).toEqual([]);
		expect(bundle.run.unverified_criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "required-output:tmp/out.txt",
					status: "unverified",
				}),
				expect.objectContaining({
					id: "command-exit:0",
					status: "unverified",
				}),
			]),
		);
		expect(bundle.run.blockers).toEqual([
			expect.objectContaining({
				id: "policy-rejection",
				status: "closed",
				severity: "high",
			}),
		]);

		const verifierEvent = bundle.events.find(
			(event) =>
				event.kind === "assertion_check" && event.target === "tmp/out.txt",
		);
		const workerEvent = bundle.events.find(
			(event) =>
				event.kind === "tool_call" && event.actor.id === "buildplane.runtime",
		);
		expect(verifierEvent?.verification_state).toBe("failed");
		expect(bundle.run.unverified_criteria[0]?.evidence_event_id).toBe(
			verifierEvent?.id,
		);
		expect(bundle.run.unverified_criteria[0]?.evidence_event_id).not.toBe(
			workerEvent?.id,
		);
	});
});
