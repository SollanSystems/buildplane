import {
	bundleDigest,
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
} from "@buildplane/capability-broker";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/events.js";
import { createGraphScheduler, type UnitGraph } from "../src/graph.js";
import { createBuildplaneOrchestrator } from "../src/orchestrator.js";
import type {
	BuildplanePolicyPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
} from "../src/ports.js";
import type { UnitPacket } from "../src/run-loop.js";

function makeGraphNode(id: string) {
	return {
		unit: {
			id,
			kind: "command" as const,
			scope: "task" as const,
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0-and-required-outputs" as const,
			policyProfile: "default",
		},
		execution: { command: "echo", args: [id] },
		verification: { requiredOutputs: [] },
		provenance_ref: "",
	};
}

function createGraphOrchestrator() {
	const unavailablePort = new Proxy(
		{},
		{
			get() {
				throw new Error("graph test unexpectedly accessed a runtime port");
			},
		},
	);

	return createBuildplaneOrchestrator({
		projectRoot: ".",
		storage: unavailablePort as BuildplaneStoragePort,
		runtime: unavailablePort as BuildplaneRuntimePort,
		policy: unavailablePort as BuildplanePolicyPort,
		workspace: unavailablePort as BuildplaneWorkspacePort,
		admissionStore: null,
	});
}

describe("graph scheduler containment", () => {
	it("rejects duplicate unit IDs", () => {
		const graph: UnitGraph = {
			nodes: [makeGraphNode("duplicate"), makeGraphNode("duplicate")],
		};

		expect(() => createGraphScheduler(graph)).toThrow(/duplicate unit id/i);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects an invalid graph maxConcurrent value (%p)", (maxConcurrent) => {
		const graph: UnitGraph = {
			nodes: [makeGraphNode("unit-a")],
			maxConcurrent,
		};

		expect(() => createGraphScheduler(graph)).toThrow(
			/maxConcurrent.*positive safe integer/i,
		);
	});

	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects an invalid options maxConcurrent value (%p)", (maxConcurrent) => {
		const graph: UnitGraph = {
			nodes: [makeGraphNode("unit-a")],
			maxConcurrent: 2,
		};

		expect(() => createGraphScheduler(graph, { maxConcurrent })).toThrow(
			/maxConcurrent.*positive safe integer/i,
		);
	});
});

describe("graph packet containment", () => {
	it("refuses governance-bearing graph packets before dispatch", async () => {
		const orchestrator = createGraphOrchestrator();
		const dispatchedPackets: UnitPacket[] = [];
		vi.spyOn(orchestrator, "runPacketAsync").mockImplementation(
			async (packet) => {
				dispatchedPackets.push(packet);
				return {
					run: {
						id: `run-${packet.unit.id}`,
						unitId: packet.unit.id,
						status: "passed",
					},
				};
			},
		);

		const capability_bundle = {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: "graph-governance",
			fsWrite: ["src/**"],
			tools: { run_command: { allowlist: ["node"] } },
		};
		const acceptance_contract = { checks: [{ command: "node --version" }] };
		const trust_scope = { principal: "graph-test", scope: "local" };
		const graph = {
			nodes: [
				{
					...makeGraphNode("governed-unit"),
					dependsOn: [],
					capability_bundle,
					capability_bundle_digest: bundleDigest(capability_bundle),
					acceptance_contract,
					trust_scope,
					untrusted_graph_node_key: "must-not-reach-runtime",
				},
			],
		} as unknown as UnitGraph;

		await expect(
			orchestrator.runGraphAsync(graph, undefined, { lane: "raw-legacy" }),
		).rejects.toThrow(/cannot execute in the raw-legacy lane/i);
		expect(dispatchedPackets).toEqual([]);
	});

	it("requires an explicit raw lane before an ungoverned graph can dispatch", async () => {
		const orchestrator = createGraphOrchestrator();
		const dispatchedPackets: UnitPacket[] = [];
		vi.spyOn(orchestrator, "runPacketAsync").mockImplementation(
			async (packet) => {
				dispatchedPackets.push(packet);
				return {
					run: {
						id: `run-${packet.unit.id}`,
						unitId: packet.unit.id,
						status: "passed",
					},
				};
			},
		);
		const graph = {
			nodes: [
				{
					...makeGraphNode("raw-unit"),
					dependsOn: [],
					untrusted_graph_node_key: "must-not-reach-runtime",
				},
			],
		} as unknown as UnitGraph;

		await expect(orchestrator.runGraphAsync(graph)).rejects.toThrow(
			/explicit raw-legacy lane/i,
		);
		expect(dispatchedPackets).toEqual([]);

		await expect(
			orchestrator.runGraphAsync(graph, undefined, { lane: "raw-legacy" }),
		).resolves.toMatchObject({ outcome: "passed" });
		expect(dispatchedPackets).toHaveLength(1);
		expect(dispatchedPackets[0]).not.toHaveProperty("dependsOn");
		expect(dispatchedPackets[0]).not.toHaveProperty("untrusted_graph_node_key");
	});

	it("rejects every graph node before dispatching a malformed graph", async () => {
		const orchestrator = createGraphOrchestrator();
		const dispatch = vi.spyOn(orchestrator, "runPacketAsync");
		const graph = {
			nodes: [
				makeGraphNode("valid-first"),
				{
					unit: makeGraphNode("malformed-second").unit,
					verification: { requiredOutputs: [] },
					provenance_ref: "graph-test-admission",
				},
			],
		} as unknown as UnitGraph;

		await expect(
			orchestrator.runGraphAsync(graph, undefined, { lane: "raw-legacy" }),
		).rejects.toThrow(
			/packet must have either an 'execution' block or a 'model' block/i,
		);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it.each([
		["a string", "valid-first"],
		["an array containing a non-string", ["valid-first", 42]],
	])("rejects dependsOn supplied as %s before graph start or dispatch", async (_description, dependsOn) => {
		const orchestrator = createGraphOrchestrator();
		const dispatch = vi.spyOn(orchestrator, "runPacketAsync");
		const bus = createEventBus();
		const eventKinds: string[] = [];
		bus.subscribe((event) => eventKinds.push(event.kind));
		const graph = {
			nodes: [
				{
					...makeGraphNode("valid-first"),
					dependsOn,
				},
			],
		} as unknown as UnitGraph;

		await expect(
			orchestrator.runGraphAsync(graph, bus, { lane: "raw-legacy" }),
		).rejects.toThrow(/dependsOn must be an array of strings/i);
		expect(eventKinds).toEqual([]);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
