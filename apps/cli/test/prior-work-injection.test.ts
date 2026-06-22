import { describe, expect, it } from "vitest";
import {
	injectPriorWorkIntoPacket,
	loadPriorWorkEntries,
} from "../src/packet-enrichment.js";

function makePacket(priorWork?: string[]) {
	return {
		unit: { id: "u1", inputRefs: [] },
		intent: {
			objective: "implement feature X",
			taskType: "implement",
			context: {
				files: ["apps/web/src/inbox.ts"],
				...(priorWork ? { priorWork } : {}),
			},
			constraints: { scope: ["apps/web"], verification: ["pnpm vitest run"] },
			features: {
				ambiguity: "low",
				reversibility: "easy",
				verifierStrength: "strong",
			},
		},
	};
}

describe("injectPriorWorkIntoPacket", () => {
	it("injects priorWork entries into a packet with no existing priorWork", () => {
		const packet = makePacket();
		const entries = [
			"[completed] M5-S1: approval inbox — 2/2 tasks passed sha:abc12345 — goal: Build the approval inbox UI",
		];
		const result = injectPriorWorkIntoPacket(packet, entries) as typeof packet;
		expect(
			(result.intent.context as { priorWork?: string[] }).priorWork,
		).toEqual(entries);
	});

	it("appends to existing priorWork entries", () => {
		const packet = makePacket(["prior entry 1"]);
		const result = injectPriorWorkIntoPacket(packet, [
			"new entry",
		]) as typeof packet;
		const pw = (result.intent.context as { priorWork?: string[] }).priorWork;
		expect(pw).toEqual(["prior entry 1", "new entry"]);
	});

	it("deduplicates entries (case-insensitive trim)", () => {
		const packet = makePacket(["existing entry"]);
		const result = injectPriorWorkIntoPacket(packet, [
			"Existing Entry ",
			"truly new",
		]) as typeof packet;
		const pw = (result.intent.context as { priorWork?: string[] }).priorWork;
		expect(pw).toHaveLength(2);
		expect(pw).toContain("existing entry");
		expect(pw).toContain("truly new");
	});

	it("returns the original packet when entries is empty", () => {
		const packet = makePacket(["keep me"]);
		const result = injectPriorWorkIntoPacket(packet, []) as typeof packet;
		const pw = (result.intent.context as { priorWork?: string[] }).priorWork;
		expect(pw).toEqual(["keep me"]);
	});

	it("returns original packet unchanged when there is no intent", () => {
		const packet = { unit: { id: "u1" } };
		const result = injectPriorWorkIntoPacket(packet, ["entry"]);
		expect(result).toBe(packet);
	});

	it("does not mutate the original packet", () => {
		const packet = makePacket(["original"]);
		injectPriorWorkIntoPacket(packet, ["injected"]);
		expect(
			(packet.intent.context as { priorWork?: string[] }).priorWork,
		).toEqual(["original"]);
	});
});

describe("loadPriorWorkEntries", () => {
	const mockStorage = {
		listSearchableDocuments: (_options: {
			documentKind?: string;
			sourceTable?: string;
			limit?: number;
		}) => [
			{
				id: "doc-1",
				sourceTable: "planforge_receipts",
				sourceId: "plan-xyz",
				documentKind: "plan-summary",
				title: "M5-S1",
				bodyText:
					"[completed] M5-S1 — 2/2 tasks passed sha:abcd1234 — goal: inbox",
				repoId: "repo",
				createdAt: "2026-06-22T00:00:00.000Z",
				updatedAt: "2026-06-22T00:00:00.000Z",
			},
		],
	};

	it("returns bodyText strings for matching plan summaries", () => {
		const entries = loadPriorWorkEntries(mockStorage as never, { limit: 5 });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toContain("M5-S1");
		expect(entries[0]).toContain("completed");
	});

	it("returns empty array when storage is undefined", () => {
		const entries = loadPriorWorkEntries(undefined, {});
		expect(entries).toEqual([]);
	});

	it("returns empty array when no documents match", () => {
		const emptyStorage = { listSearchableDocuments: () => [] };
		const entries = loadPriorWorkEntries(emptyStorage as never, {});
		expect(entries).toEqual([]);
	});
});
