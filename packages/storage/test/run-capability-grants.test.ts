import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
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
		id: "unit-capability-bundle",
		kind: "command",
		scope: "task",
		inputRefs: [],
		expectedOutputs: [],
		verificationContract: "exit-0",
		policyProfile: "publisher",
	},
	execution: { command: "node", args: ["publish-check.js"] },
	verification: { requiredOutputs: [] },
};

const receiptWithGrantedSideEffect: ExecutionReceipt = {
	command: "node",
	args: ["publish-check.js"],
	cwd: ".",
	startedAt: "2026-05-05T00:00:00.000Z",
	completedAt: "2026-05-05T00:00:01.000Z",
	exitCode: 0,
	stdout: "prepared pr dry-run\n",
	stderr: "",
	outputChecks: [],
	sideEffects: [
		{
			id: "side-effect-pr-dry-run",
			capability: "github.pr",
			action: "dry-run",
			target: "repo:SollanSystems/Vector",
			grantId: "grant-pr-dry-run",
		},
	],
};

const unauthorizedDecision: RejectedPolicyDecision = {
	kind: "reject-run",
	outcome: "rejected",
	reasons: [
		"UNSAFE_TO_RUN: side effect side-effect-pr-publish github.pr.publish target repo:SollanSystems/Vector without matching capability grant; quarantine required.",
	],
};

function createStorage(root: string) {
	const storage = createBuildplaneStorage(root);
	storage.initializeProject();
	return storage;
}

describe("capability grants in evidence export", () => {
	it("exports side-effect receipts with cited capability grants", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-capability-grant-export-"),
		);
		const storage = createStorage(root);
		const run = storage.createRun(packet, { runId: "run-capability-granted" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, receiptWithGrantedSideEffect);
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: [],
		});
		storage.completeRun(run.id, "passed");

		const bundle = exportRunBundle(root, { runId: run.id });
		const sideEffectEvent = bundle.events.find((event) =>
			event.summary.includes("side-effect-pr-dry-run"),
		);
		const grantReceipt = bundle.artifacts.find(
			(artifact) => artifact.produced_by_event_id === sideEffectEvent?.id,
		);

		expect(sideEffectEvent).toMatchObject({
			kind: "tool_call",
			actor: { type: "tool", id: "buildplane.runtime.side_effect" },
			verification_state: "attempted",
		});
		expect(sideEffectEvent?.summary).toContain("grant-pr-dry-run");
		expect(grantReceipt?.kind).toBe("receipt");
		expect(grantReceipt?.bytes).toContain("grant-pr-dry-run");
	});

	it("exports unauthorized side effects as unsafe quarantined blockers", () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-capability-quarantine-export-"),
		);
		const storage = createStorage(root);
		const run = storage.createRun(packet, { runId: "run-capability-unsafe" });
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			...receiptWithGrantedSideEffect,
			sideEffects: [
				{
					id: "side-effect-pr-publish",
					capability: "github.pr",
					action: "publish",
					target: "repo:SollanSystems/Vector",
					grantId: "grant-pr-dry-run",
				},
			],
		});
		storage.recordDecision(run.id, unauthorizedDecision);
		storage.completeRun(run.id, "failed");

		const report = verifyRunFinalVerdict(root, { runId: run.id });
		const bundle = exportRunBundle(root, { runId: run.id });

		expect(report.verdict).toBe("UNSAFE_TO_RUN");
		expect(bundle.run.status).toBe("blocked");
		expect(bundle.run.verdict).toBe("blocked");
		expect(bundle.run.blockers).toEqual([
			expect.objectContaining({
				id: "policy-unsafe-quarantine",
				status: "open",
				severity: "critical",
			}),
		]);
		expect(bundle.run.blockers[0]?.label).toContain("quarantine");
		expect(bundle.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "blocker_raised",
					verification_state: "failed",
					summary: expect.stringContaining("UNSAFE_TO_RUN"),
				}),
			]),
		);
	});
});
