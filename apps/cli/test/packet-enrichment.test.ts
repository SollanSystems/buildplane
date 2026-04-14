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
			intent: {
				objective: "do thing",
				taskType: "implement",
				context: { files: [] },
				constraints: { scope: [], verification: [] },
				features: {},
			},
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

	it("injects ranked repo facts and procedures as provider-neutral memory strings", async () => {
		const packet = {
			unit: { id: "u1" },
			intent: {
				objective: "Fix the TypeScript build",
				taskType: "debug_failure",
				context: { files: ["apps/cli/src/run-cli.ts"] },
				constraints: {
					scope: ["apps/cli/src"],
					verification: ["npx pnpm typecheck"],
				},
				features: {},
			},
		};
		const structuredMemoryPort = {
			retrieveRepoFacts: () => [
				{
					item: {
						id: "fact-1",
						memoryType: "repo-fact",
						scopeType: "repo",
						status: "active",
						factKey: "commands.typecheck",
						valueType: "string",
						factValue: "npx pnpm typecheck",
						provenance: {
							createdBy: "system",
							createdAt: "2026-04-13T00:00:00.000Z",
							updatedAt: "2026-04-13T00:00:00.000Z",
							confidence: 0.95,
						},
					},
					reason: "fuzzy-fact-key",
					matchClass: "fuzzy",
					confidence: 0.95,
					updatedAt: "2026-04-13T00:00:00.000Z",
				},
			],
			retrieveProcedures: () => [
				{
					item: {
						id: "procedure-1",
						memoryType: "procedure",
						scopeType: "repo",
						status: "active",
						name: "fix TypeScript build",
						taskType: "debug_failure",
						bodyMarkdown: "Run typecheck before touching imports.\nThen re-run the failing task.",
						provenance: {
							createdBy: "worker",
							createdAt: "2026-04-13T00:00:00.000Z",
							updatedAt: "2026-04-13T00:00:00.000Z",
							confidence: 0.82,
						},
					},
					reason: "exact-task-type",
					matchClass: "exact",
					confidence: 0.82,
					updatedAt: "2026-04-13T00:00:00.000Z",
				},
			],
		};

		const result = (await enrichPacketWithMemories(
			packet,
			undefined,
			undefined,
			undefined,
			structuredMemoryPort,
			"release/2026-04-13",
		)) as {
			intent: { context: { memories?: string[] } };
		};

		expect(result.intent.context.memories).toEqual([
			"[repo-fact] commands.typecheck: npx pnpm typecheck",
			"[procedure] fix TypeScript build: Run typecheck before touching imports.",
		]);
	});

	it("re-ranks structured repo fact matches across search terms before formatting", async () => {
		const packet = {
			unit: { id: "u1" },
			intent: {
				objective: "Fix the TypeScript build",
				taskType: "debug_failure",
				context: { files: ["apps/cli/src/run-cli.ts"] },
				constraints: {
					scope: ["apps/cli/src"],
					verification: ["npx pnpm build"],
				},
				features: {},
			},
		};
		const structuredMemoryPort = {
			retrieveRepoFacts: ({ searchText }: { searchText?: string }) => {
				if (searchText === "Fix the TypeScript build") {
					return [
						{
							item: {
								id: "fact-weaker",
								memoryType: "repo-fact",
								scopeType: "repo",
								status: "active",
								factKey: "troubleshooting.build",
								valueType: "string",
								factValue: "Investigate build logs before retrying.",
								provenance: {
									createdBy: "system",
									createdAt: "2026-04-13T00:00:00.000Z",
									updatedAt: "2026-04-13T00:00:00.000Z",
									confidence: 1,
								},
							},
							reason: "fuzzy-fact-value",
							matchClass: "fuzzy",
							confidence: 1,
							updatedAt: "2026-04-13T00:00:00.000Z",
						},
					];
				}
				if (searchText === "build") {
					return [
						{
							item: {
								id: "fact-stronger",
								memoryType: "repo-fact",
								scopeType: "repo",
								status: "active",
								factKey: "commands.build",
								valueType: "string",
								factValue: "npx pnpm build",
								provenance: {
									createdBy: "operator",
									createdAt: "2026-04-13T00:00:00.000Z",
									updatedAt: "2026-04-13T00:00:00.000Z",
									confidence: 0.7,
								},
							},
							reason: "fuzzy-fact-key",
							matchClass: "fuzzy",
							confidence: 0.7,
							updatedAt: "2026-04-13T00:00:00.000Z",
						},
					];
				}
				return [];
			},
			retrieveProcedures: () => [],
		};

		const result = (await enrichPacketWithMemories(
			packet,
			undefined,
			undefined,
			undefined,
			structuredMemoryPort,
			"release/2026-04-13",
		)) as {
			intent: { context: { memories?: string[] } };
		};

		expect(result.intent.context.memories).toEqual([
			"[repo-fact] commands.build: npx pnpm build",
			"[repo-fact] troubleshooting.build: Investigate build logs before retrying.",
		]);
	});

	it("keeps mixed-source memory ordering deterministic", async () => {
		const packet = {
			unit: { id: "u1" },
			intent: {
				objective: "Fix the TypeScript build",
				taskType: "debug_failure",
				context: { files: ["apps/cli/src/run-cli.ts"] },
				constraints: {
					scope: ["apps/cli/src"],
					verification: ["npx pnpm typecheck"],
				},
				features: {},
			},
		};
		const structuredMemoryPort = {
			retrieveRepoFacts: () => [
				{
					item: {
						id: "fact-1",
						memoryType: "repo-fact",
						scopeType: "repo",
						status: "active",
						factKey: "commands.typecheck",
						valueType: "string",
						factValue: "npx pnpm typecheck",
						provenance: {
							createdBy: "system",
							createdAt: "2026-04-13T00:00:00.000Z",
							updatedAt: "2026-04-13T00:00:00.000Z",
							confidence: 0.95,
						},
					},
					reason: "fuzzy-fact-key",
					matchClass: "fuzzy",
					confidence: 0.95,
					updatedAt: "2026-04-13T00:00:00.000Z",
				},
			],
			retrieveProcedures: () => [
				{
					item: {
						id: "procedure-1",
						memoryType: "procedure",
						scopeType: "repo",
						status: "active",
						name: "fix TypeScript build",
						taskType: "debug_failure",
						bodyMarkdown: "Run typecheck before touching imports.",
						provenance: {
							createdBy: "worker",
							createdAt: "2026-04-13T00:00:00.000Z",
							updatedAt: "2026-04-13T00:00:00.000Z",
							confidence: 0.82,
						},
					},
					reason: "exact-task-type",
					matchClass: "exact",
					confidence: 0.82,
					updatedAt: "2026-04-13T00:00:00.000Z",
				},
			],
		};
		const honchoAdapter = {
			fetchContext: async () => ({ memories: ["user prefers exact verification output"] }),
		};

		const result = (await enrichPacketWithMemories(
			packet,
			mockMemoryPort,
			honchoAdapter,
			"user-1",
			structuredMemoryPort,
			"release/2026-04-13",
		)) as {
			intent: { context: { memories?: string[] } };
		};

		expect(result.intent.context.memories).toEqual([
			"[fact] Tests passed: All checks passed",
			"[repo-fact] commands.typecheck: npx pnpm typecheck",
			"[procedure] fix TypeScript build: Run typecheck before touching imports.",
			"[honcho] user prefers exact verification output",
		]);
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
		const packet = {
			unit: { id: "u1" },
			intent: {
				objective: "do thing",
				taskType: "implement",
				context: { files: [] },
				constraints: { scope: [], verification: [] },
				features: {},
			},
		};
		const result = await enrichPacketWithMemories(
			packet,
			undefined,
			undefined,
			undefined,
		);
		expect(result).toBe(packet);
	});

	it("returns packet unchanged when memoryPort returns empty learnings", async () => {
		const packet = {
			unit: { id: "u1" },
			intent: {
				objective: "do thing",
				taskType: "implement",
				context: { files: [] },
				constraints: { scope: [], verification: [] },
				features: {},
			},
		};
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
