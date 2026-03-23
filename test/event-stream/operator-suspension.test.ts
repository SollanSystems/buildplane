import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createEventBus,
	type ExecutionEvent,
} from "../../packages/kernel/src/events";
import { createBuildplaneOrchestrator } from "../../packages/kernel/src/orchestrator";
import type { UnitPacket } from "../../packages/kernel/src/run-loop";
import { createProfileRegistry } from "../../packages/policy/src/profiles";
import { createMockStorage } from "../helpers/mock-storage";

function makeCommandPacket(policyProfile = "default"): UnitPacket {
	return {
		unit: {
			id: "unit-suspension-test",
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile,
		},
		command: { command: "echo", args: ["hello"] },
		verification: { requiredOutputs: [] },
	};
}

function makeApprovalRequiredProfile() {
	return createProfileRegistry([
		{
			name: "requires-approval",
			trustGates: { requiresApproval: true },
		},
	]);
}

describe("operator suspension", () => {
	it("suspends a run when profile requires approval", async () => {
		const bus = createEventBus();
		const events: ExecutionEvent[] = [];
		bus.subscribe((e) => events.push(e));

		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-suspend-")));
		const mockStorage = createMockStorage();

		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: mockStorage,
			runtime: {
				executePacket: () => {
					throw new Error("should not execute — run should be suspended");
				},
			},
			policy: {
				evaluateRun: () => ({
					kind: "advance-run",
					outcome: "approved",
					reasons: [],
				}),
			},
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc123" }),
				prepareWorkspace: () => {
					throw new Error(
						"should not prepare workspace — run should be suspended",
					);
				},
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			profileRegistry: makeApprovalRequiredProfile(),
		});

		const result = await orchestrator.runPacketAsync(
			makeCommandPacket("requires-approval"),
			bus,
		);

		// Result signals suspension
		expect(result.suspended).toBe(true);
		expect(result.run.status).toBe("suspended");

		// RunSuspendedEvent emitted
		const suspendedEvent = events.find((e) => e.kind === "run-suspended");
		expect(suspendedEvent).toBeDefined();
		if (suspendedEvent?.kind === "run-suspended") {
			expect(suspendedEvent.profileName).toBe("requires-approval");
			expect(suspendedEvent.reason).toContain("operator approval");
		}

		// No run-started or execution-started events (workspace was never prepared)
		expect(events.find((e) => e.kind === "run-started")).toBeUndefined();
		expect(events.find((e) => e.kind === "execution-started")).toBeUndefined();
	});

	it("does not suspend a run when profile does not require approval", async () => {
		const bus = createEventBus();
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bp-no-suspend-")));
		const mockStorage = createMockStorage();

		let executed = false;
		const orchestrator = createBuildplaneOrchestrator({
			projectRoot: root,
			storage: mockStorage,
			runtime: {
				executePacket: (_pkt, _root) => {
					executed = true;
					return {
						command: "echo",
						args: [],
						exitCode: 0,
						outputChecks: [],
					};
				},
			},
			policy: {
				evaluateRun: () => ({
					kind: "advance-run",
					outcome: "approved",
					reasons: [],
				}),
			},
			workspace: {
				assertRunnableRepository: () => ({ headSha: "abc123" }),
				prepareWorkspace: () => ({ path: root, headSha: "abc123" }),
				deleteWorkspace: () => ({ deleted: true }),
			},
			eventBus: bus,
			profileRegistry: createProfileRegistry([
				{ name: "no-approval", trustGates: { requiresApproval: false } },
			]),
		});

		const result = await orchestrator.runPacketAsync(
			makeCommandPacket("no-approval"),
			bus,
		);

		expect(result.suspended).toBeUndefined();
		expect(result.run.status).toBe("passed");
		expect(executed).toBe(true);
	});

	it("approveRun transitions suspended run to pending", () => {
		const mockStorage = createMockStorage();

		// Manually drive the lifecycle: pending → running → suspended
		const run = mockStorage.createRun(makeCommandPacket("requires-approval"));
		expect(run.status).toBe("pending");

		mockStorage.markRunRunning(run.id);
		const suspended = mockStorage.suspendRun(run.id);
		expect(suspended.status).toBe("suspended");

		const approved = mockStorage.approveRun(run.id);
		expect(approved.status).toBe("pending");
	});

	it("rejectSuspendedRun transitions suspended run to failed", () => {
		const mockStorage = createMockStorage();

		const run = mockStorage.createRun(makeCommandPacket("requires-approval"));
		mockStorage.markRunRunning(run.id);
		mockStorage.suspendRun(run.id);

		const rejected = mockStorage.rejectSuspendedRun(run.id);
		expect(rejected.status).toBe("failed");
	});

	it("suspendRun, approveRun, rejectSuspendedRun reject invalid status transitions", () => {
		const mockStorage = createMockStorage();
		const run = mockStorage.createRun(makeCommandPacket("requires-approval"));

		// Cannot suspend a pending run directly (requires running)
		expect(() => mockStorage.suspendRun(run.id)).toThrow(
			/requires a running run/,
		);

		// Cannot approve a pending run
		expect(() => mockStorage.approveRun(run.id)).toThrow(
			/requires a suspended run/,
		);

		// Cannot reject a pending run
		expect(() => mockStorage.rejectSuspendedRun(run.id)).toThrow(
			/requires a suspended run/,
		);
	});
});
