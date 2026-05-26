import { describe, expect, it, vi } from "vitest";
import {
	REPO_FACT_KEYS,
	seedRepoFactsFromInspection,
} from "../src/repo-fact-seeding.js";

function fakePort() {
	const upsertRepoFact = vi.fn((input) => ({
		id: `fact-${input.factKey}`,
		memoryType: "repo-fact" as const,
		scopeType: input.scopeType ?? "repo",
		status: "active" as const,
		factKey: input.factKey,
		valueType: input.valueType,
		factValue: input.factValue,
		provenance: {
			createdBy: input.createdBy,
			createdAt: "t",
			updatedAt: "t",
			confidence: input.confidence ?? 1,
			branch: input.branch,
			commitSha: input.commitSha,
		},
	}));
	return { upsertRepoFact };
}

describe("seedRepoFactsFromInspection", () => {
	it("seeds one repo.* fact per non-empty signal with system provenance", () => {
		const port = fakePort();
		const seeded = seedRepoFactsFromInspection(
			port,
			{
				primaryLanguage: "typescript",
				testRunner: "vitest --run",
				buildCommand: "tsc --build",
			},
			{ branch: "main", commitSha: "abc123" },
		);

		expect(port.upsertRepoFact).toHaveBeenCalledTimes(3);
		expect(seeded.map((f) => f.factKey)).toEqual([
			REPO_FACT_KEYS.primaryLanguage,
			REPO_FACT_KEYS.testRunner,
			REPO_FACT_KEYS.buildCommand,
		]);
		const first = port.upsertRepoFact.mock.calls[0][0];
		expect(first).toMatchObject({
			factKey: "repo.primary-language",
			factValue: "typescript",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
			branch: "main",
			commitSha: "abc123",
		});
	});

	it("skips undefined and empty-string signals", () => {
		const port = fakePort();
		const seeded = seedRepoFactsFromInspection(
			port,
			{ primaryLanguage: "typescript", testRunner: "", buildCommand: undefined },
			{},
		);
		expect(port.upsertRepoFact).toHaveBeenCalledTimes(1);
		expect(seeded).toHaveLength(1);
	});

	it("is idempotent last-writer-wins: re-seeding the same key issues a fresh upsert", () => {
		const port = fakePort();
		seedRepoFactsFromInspection(port, { testRunner: "vitest" }, {});
		seedRepoFactsFromInspection(port, { testRunner: "vitest --run" }, {});
		expect(port.upsertRepoFact).toHaveBeenCalledTimes(2);
		expect(port.upsertRepoFact.mock.calls[0][0].factValue).toBe("vitest");
		expect(port.upsertRepoFact.mock.calls[1][0].factValue).toBe("vitest --run");
		// Both target the SAME factKey -> store supersedes the first (last-writer-wins).
		expect(port.upsertRepoFact.mock.calls[0][0].factKey).toBe(
			port.upsertRepoFact.mock.calls[1][0].factKey,
		);
	});
});
