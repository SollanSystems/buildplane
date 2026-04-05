import { describe, expect, it } from "vitest";
import { enrichPacketWithMemories } from "../src/packet-enrichment.js";

const mockMemoryPort = {
	fetchLearnings: () => [
		{ kind: "fact", title: "Tests passed", body: "All checks passed" },
	],
};

describe("enrichPacketWithMemories", () => {
	it("injects memories into a packet that has an intent", async () => {
		const packet = {
			unit: { id: "u1" },
			intent: { objective: "do thing", context: { files: [] } },
		};
		const result = (await enrichPacketWithMemories(
			packet,
			mockMemoryPort,
			undefined,
			undefined,
		)) as typeof packet;
		expect(
			(result.intent.context as { memories?: string[] }).memories,
		).toHaveLength(1);
		expect(
			(result.intent.context as { memories?: string[] }).memories![0],
		).toContain("Tests passed");
	});

	it("returns packet unchanged when intent is absent", async () => {
		const packet = { unit: { id: "u1" } };
		const result = await enrichPacketWithMemories(
			packet,
			mockMemoryPort,
			undefined,
			undefined,
		);
		expect(result).toBe(packet);
	});

	it("returns packet unchanged when neither memoryPort nor honchoAdapter are provided", async () => {
		const packet = { unit: { id: "u1" }, intent: { context: {} } };
		const result = await enrichPacketWithMemories(
			packet,
			undefined,
			undefined,
			undefined,
		);
		expect(result).toBe(packet);
	});

	it("returns packet unchanged when memoryPort returns empty learnings", async () => {
		const packet = { unit: { id: "u1" }, intent: { context: {} } };
		const emptyPort = { fetchLearnings: () => [] };
		const result = await enrichPacketWithMemories(
			packet,
			emptyPort,
			undefined,
			undefined,
		);
		expect(result).toBe(packet);
	});
});
