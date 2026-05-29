import { describe, expect, it } from "vitest";

import type { RunOutcome, WorkerLabel } from "../src/memory-types.js";
import type { BuildplaneStoragePort } from "../src/ports.js";
import {
	defaultOutcomeRoutingConfig,
	fillRoutingHints,
	type OutcomeRoutingConfig,
} from "../src/routing-producer.js";
import type { UnitPacket } from "../src/run-loop.js";

const NOW = Date.parse("2026-05-28T00:00:00.000Z");
const ENABLED: OutcomeRoutingConfig = {
	...defaultOutcomeRoutingConfig,
	enabled: true,
};

const unit = {
	id: "u1",
	kind: "implement",
	scope: "task" as const,
	inputRefs: [],
	expectedOutputs: ["tmp/out.txt"],
	verificationContract: "exit-0-and-required-outputs",
	policyProfile: "default",
};

function modelPacket(overrides: Partial<UnitPacket> = {}): UnitPacket {
	return {
		unit,
		model: { provider: "anthropic", model: "claude" },
		verification: { requiredOutputs: ["tmp/out.txt"] },
		...overrides,
	};
}

function commandPacket(): UnitPacket {
	return {
		unit: { ...unit, kind: "command" },
		execution: { command: "node" },
		verification: { requiredOutputs: ["tmp/out.txt"] },
	};
}

interface StubResult {
	storage: BuildplaneStoragePort;
	listCalls: Array<{
		repoId?: string;
		taskType?: string;
		worker?: WorkerLabel;
	}>;
}

function stubStorage(rows: readonly RunOutcome[]): StubResult {
	const listCalls: StubResult["listCalls"] = [];
	const storage = {
		listRunOutcomes(options?: {
			repoId?: string;
			taskType?: string;
			worker?: WorkerLabel;
		}) {
			listCalls.push(options ?? {});
			return rows;
		},
	} as unknown as BuildplaneStoragePort;
	return { storage, listCalls };
}

const row = (
	worker: WorkerLabel,
	success: boolean,
	createdAt: string,
	taskType = "implement",
): RunOutcome => ({
	id: createdAt + worker,
	repoId: "/r",
	taskType,
	worker,
	success,
	sourceRunId: createdAt + worker,
	createdAt,
});

// Build a fully-covered, codex-best fixture (every candidate ≥ minSamples=5).
function codexBestRows(): RunOutcome[] {
	const at = new Date(NOW).toISOString();
	const rows: RunOutcome[] = [];
	for (let i = 0; i < 5; i++) {
		rows.push(row("sdk", false, at));
		rows.push(row("claude-code", false, at));
		rows.push(row("codex", true, at));
	}
	return rows;
}

describe("fillRoutingHints", () => {
	it("flag OFF ⇒ packet returned unchanged and listRunOutcomes never queried", () => {
		const packet = modelPacket();
		const { storage, listCalls } = stubStorage(codexBestRows());
		const out = fillRoutingHints(
			packet,
			storage,
			defaultOutcomeRoutingConfig,
			NOW,
		);
		expect(out).toBe(packet);
		expect(listCalls).toHaveLength(0);
	});

	it("non-model packet (command) ⇒ unchanged even with flag ON, never queried", () => {
		const packet = commandPacket();
		const { storage, listCalls } = stubStorage(codexBestRows());
		const out = fillRoutingHints(packet, storage, ENABLED, NOW);
		expect(out).toBe(packet);
		expect(listCalls).toHaveLength(0);
	});

	it("packet with neither model nor execution ⇒ unchanged (model-presence gate)", () => {
		const packet: UnitPacket = {
			unit,
			verification: { requiredOutputs: ["tmp/out.txt"] },
		};
		const { storage, listCalls } = stubStorage(codexBestRows());
		const out = fillRoutingHints(packet, storage, ENABLED, NOW);
		expect(out).toBe(packet);
		expect(listCalls).toHaveLength(0);
	});

	it("explicit preferredWorker ⇒ never overridden (flag ON)", () => {
		const packet = modelPacket({
			routingHints: { preferredWorker: "claude-code" },
		});
		const { storage, listCalls } = stubStorage(codexBestRows());
		const out = fillRoutingHints(packet, storage, ENABLED, NOW);
		expect(out).toBe(packet);
		expect(out.routingHints?.preferredWorker).toBe("claude-code");
		expect(listCalls).toHaveLength(0);
	});

	it("flag ON + model + absent hint + chooseWorker ⇒ codex ⇒ fills preferredWorker", () => {
		const packet = modelPacket();
		const { storage, listCalls } = stubStorage(codexBestRows());
		const out = fillRoutingHints(packet, storage, ENABLED, NOW);
		expect(out).not.toBe(packet);
		expect(out.routingHints?.preferredWorker).toBe("codex");
		expect(listCalls).toHaveLength(1);
		expect(listCalls[0]?.taskType).toBe("implement");
	});

	it("chooseWorker ⇒ sdk ⇒ hint stays absent (default executor)", () => {
		// fully covered, sdk best rate
		const at = new Date(NOW).toISOString();
		const rows: RunOutcome[] = [];
		for (let i = 0; i < 5; i++) {
			rows.push(row("sdk", true, at));
			rows.push(row("claude-code", false, at));
			rows.push(row("codex", false, at));
		}
		const { storage } = stubStorage(rows);
		const out = fillRoutingHints(modelPacket(), storage, ENABLED, NOW);
		expect(out.routingHints?.preferredWorker).toBeUndefined();
	});

	it("cold start (empty table) ⇒ least-sampled = sdk ⇒ hint absent", () => {
		const { storage, listCalls } = stubStorage([]);
		const out = fillRoutingHints(modelPacket(), storage, ENABLED, NOW);
		expect(out.routingHints?.preferredWorker).toBeUndefined();
		expect(listCalls).toHaveLength(1);
	});

	it("uses intent.taskType over unit.kind when present", () => {
		const packet = modelPacket({
			intent: { taskType: "review" } as UnitPacket["intent"],
		});
		const { storage, listCalls } = stubStorage([]);
		fillRoutingHints(packet, storage, ENABLED, NOW);
		expect(listCalls[0]?.taskType).toBe("review");
	});

	it("falls back to unit.kind when intent absent", () => {
		const { storage, listCalls } = stubStorage([]);
		fillRoutingHints(modelPacket(), storage, ENABLED, NOW);
		expect(listCalls[0]?.taskType).toBe("implement");
	});

	it("preserves existing non-preferredWorker routingHints fields when filling", () => {
		const packet = modelPacket({
			routingHints: { preferredModel: "claude-x", effort: "high" },
		});
		const { storage } = stubStorage(codexBestRows());
		const out = fillRoutingHints(packet, storage, ENABLED, NOW);
		expect(out.routingHints?.preferredWorker).toBe("codex");
		expect(out.routingHints?.preferredModel).toBe("claude-x");
		expect(out.routingHints?.effort).toBe("high");
	});

	it("defaultOutcomeRoutingConfig is opt-in OFF with epsilon 0", () => {
		expect(defaultOutcomeRoutingConfig.enabled).toBe(false);
		expect(defaultOutcomeRoutingConfig.epsilon).toBe(0);
		expect(defaultOutcomeRoutingConfig.candidates).toEqual([
			"sdk",
			"claude-code",
			"codex",
		]);
	});
});
