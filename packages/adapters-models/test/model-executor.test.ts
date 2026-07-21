import type { TaskRenderer, UnitPacket } from "@buildplane/kernel";
import { createEventBus } from "@buildplane/kernel";
import { describe, expect, it, vi } from "vitest";
import { createModelExecutor } from "../src/model-executor.js";

function makePacket(execution_role: "reviewer" | "adversary"): UnitPacket {
	return {
		unit: {
			id: "unit-model",
			kind: "model",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "default",
		},
		model: { provider: "anthropic", model: "test-model" },
		execution_role,
		intent: {
			objective: "Assess the proposed change.",
			taskType: "review",
			context: { files: [] },
			constraints: { scope: [], verification: [] },
			features: {
				ambiguity: "low",
				reversibility: "easy",
				verifierStrength: "strong",
			},
		},
		verification: { requiredOutputs: [] },
	};
}

describe("ModelExecutor renderer roles", () => {
	it("rejects a governed packet before invoking the ambient provider stream", async () => {
		const streamFn = vi.fn(() => ({
			fullStream: (async function* () {})(),
		}));
		const executor = createModelExecutor({
			modelResolver: () => ({}),
			streamFn,
		});

		await expect(
			executor.executePacketAsync(
				{
					...makePacket("reviewer"),
					provenance_ref: "admission:governed-run",
				},
				"/tmp/bp-model-test",
				createEventBus(),
			),
		).rejects.toThrow(/AMBIENT_MODEL_EXECUTOR_FORBIDDEN/);

		expect(streamFn).not.toHaveBeenCalled();
	});

	it("rejects a governed command packet before delegating to the raw runtime", () => {
		const executor = createModelExecutor();

		expect(() =>
			executor.executePacket(
				{
					...makePacket("reviewer"),
					execution: { command: "__buildplane_must_not_run__", args: [] },
					provenance_ref: "admission:governed-run",
				},
				"/tmp/bp-model-test",
			),
		).toThrow(/AMBIENT_MODEL_EXECUTOR_FORBIDDEN/);
	});

	it.each([
		"reviewer",
		"adversary",
	] as const)("passes the %s packet role to its renderer", async (execution_role) => {
		const renderer: TaskRenderer = {
			provider: "test",
			render: vi.fn(() => ({ prompt: "rendered task" })),
		};
		const executor = createModelExecutor({
			renderer,
			modelResolver: () => ({}),
			streamFn: () => ({
				fullStream: (async function* () {})(),
			}),
		});
		const packet = makePacket(execution_role);

		await executor.executePacketAsync(
			packet,
			"/tmp/bp-model-test",
			createEventBus(),
		);

		expect(renderer.render).toHaveBeenCalledWith(packet.intent, execution_role);
	});
});
