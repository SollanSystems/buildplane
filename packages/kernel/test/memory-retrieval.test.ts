import { describe, expect, it } from "vitest";
import {
	compareRankedMemoryResults,
	dedupeRankedMemoryResults,
	rankMemoryResults,
	type RankedRepoFactResult,
} from "../src/memory-retrieval";
import type { RepoFact } from "../src/memory-types";

function createRepoFact(
	id: string,
	updatedAt: string,
	confidence = 1,
): RepoFact {
	return {
		id,
		memoryType: "repo-fact",
		scopeType: "repo",
		status: "active",
		factKey: `fact.${id}`,
		valueType: "string",
		factValue: id,
		provenance: {
			createdBy: "system",
			createdAt: updatedAt,
			updatedAt,
			confidence,
			repoId: "repo-1",
		},
	};
}

describe("memory retrieval ranking", () => {
	it("ranks exact matches ahead of fuzzy matches regardless of confidence or recency", () => {
		const exactMatch: RankedRepoFactResult = {
			item: createRepoFact("exact-fact", "2026-04-13T10:00:00.000Z", 0.2),
			reason: "exact-fact-key",
			matchClass: "exact",
			confidence: 0.2,
			updatedAt: "2026-04-13T10:00:00.000Z",
		};
		const fuzzyMatch: RankedRepoFactResult = {
			item: createRepoFact("fuzzy-fact", "2026-04-13T12:00:00.000Z", 0.99),
			reason: "fuzzy-fact-value",
			matchClass: "fuzzy",
			confidence: 0.99,
			updatedAt: "2026-04-13T12:00:00.000Z",
		};

		const ranked = rankMemoryResults([fuzzyMatch, exactMatch]);

		expect(ranked.map((result) => result.item.id)).toEqual([
			"exact-fact",
			"fuzzy-fact",
		]);
		expect(compareRankedMemoryResults(exactMatch, fuzzyMatch)).toBeLessThan(0);
	});

	it("prefers earlier scope candidates and falls back to stable ids for deterministic ordering", () => {
		const branchMatch: RankedRepoFactResult = {
			item: createRepoFact("branch-fact", "2026-04-13T09:00:00.000Z", 0.1),
			reason: "exact-fact-key",
			matchClass: "exact",
			confidence: 0.1,
			updatedAt: "2026-04-13T09:00:00.000Z",
			scopePreferenceIndex: 0,
		};
		const repoMatch: RankedRepoFactResult = {
			item: createRepoFact("repo-fact", "2026-04-13T11:00:00.000Z", 0.99),
			reason: "exact-fact-key",
			matchClass: "exact",
			confidence: 0.99,
			updatedAt: "2026-04-13T11:00:00.000Z",
			scopePreferenceIndex: 1,
		};
		const tiedA: RankedRepoFactResult = {
			item: createRepoFact("a-fact", "2026-04-13T08:00:00.000Z", 0.5),
			reason: "exact-fact-key",
			matchClass: "exact",
			confidence: 0.5,
			updatedAt: "2026-04-13T08:00:00.000Z",
			scopePreferenceIndex: 2,
		};
		const tiedB: RankedRepoFactResult = {
			item: createRepoFact("b-fact", "2026-04-13T08:00:00.000Z", 0.5),
			reason: "exact-fact-key",
			matchClass: "exact",
			confidence: 0.5,
			updatedAt: "2026-04-13T08:00:00.000Z",
			scopePreferenceIndex: 2,
		};

		const ranked = rankMemoryResults([tiedB, repoMatch, tiedA, branchMatch]);

		expect(ranked.map((result) => result.item.id)).toEqual([
			"branch-fact",
			"repo-fact",
			"a-fact",
			"b-fact",
		]);
	});

	it("deduplicates repeated hits by keeping the best-ranked explanation", () => {
		const repeatedItem = createRepoFact(
			"commands-test",
			"2026-04-13T10:00:00.000Z",
			0.9,
		);
		const deduped = dedupeRankedMemoryResults([
			{
				item: repeatedItem,
				reason: "fuzzy-fact-key",
				matchClass: "fuzzy",
				confidence: 0.9,
				updatedAt: "2026-04-13T10:00:00.000Z",
			},
			{
				item: repeatedItem,
				reason: "exact-fact-key",
				matchClass: "exact",
				confidence: 0.9,
				updatedAt: "2026-04-13T10:00:00.000Z",
			},
		]);

		expect(deduped).toHaveLength(1);
		expect(deduped[0]?.reason).toBe("exact-fact-key");
		expect(deduped[0]?.item.id).toBe("commands-test");
	});
});
