import { describe, expect, it } from "vitest";
import {
	enrichPacketWithMemories,
	prepareStrategyMemoryEnrichment,
} from "../src/packet-enrichment.js";
import { wrapAsStrategy } from "../src/strategy-wrapper.js";

const mockMemoryPort = {
	fetchLearnings: () => [
		{ kind: "fact", title: "Tests passed", body: "All checks passed" },
	],
};

function createPacket(options?: {
	objective?: string;
	taskType?: string;
	files?: string[];
	verification?: string[];
	inputRefs?: string[];
}) {
	return {
		unit: { id: "u1", inputRefs: options?.inputRefs ?? [] },
		intent: {
			objective: options?.objective ?? "do thing",
			taskType: options?.taskType ?? "implement",
			context: { files: options?.files ?? [] },
			constraints: {
				scope: ["apps/cli/src"],
				verification: options?.verification ?? [],
			},
			features: {},
		},
	};
}

function createRepoFactResult(options?: {
	id?: string;
	factKey?: string;
	factValue?: unknown;
	reason?: string;
	confidence?: number;
}) {
	return {
		item: {
			id: options?.id ?? "fact-1",
			memoryType: "repo-fact",
			scopeType: "repo",
			status: "active",
			factKey: options?.factKey ?? "commands.typecheck",
			valueType: "string",
			factValue: options?.factValue ?? "npx pnpm typecheck",
			provenance: {
				createdBy: "system",
				createdAt: "2026-04-13T00:00:00.000Z",
				updatedAt: "2026-04-13T00:00:00.000Z",
				confidence: options?.confidence ?? 0.95,
			},
		},
		reason: options?.reason ?? "fuzzy-fact-key",
		matchClass: (options?.reason ?? "fuzzy-fact-key").startsWith("exact-")
			? "exact"
			: "fuzzy",
		updatedAt: "2026-04-13T00:00:00.000Z",
		confidence: options?.confidence ?? 0.95,
	};
}

function createProcedureResult(options?: {
	id?: string;
	name?: string;
	bodyMarkdown?: string;
	reason?: string;
	confidence?: number;
}) {
	return {
		item: {
			id: options?.id ?? "procedure-1",
			memoryType: "procedure",
			scopeType: "repo",
			status: "active",
			name: options?.name ?? "fix TypeScript build",
			taskType: "debug_failure",
			bodyMarkdown:
				options?.bodyMarkdown ?? "Run typecheck before touching imports.",
			provenance: {
				createdBy: "worker",
				createdAt: "2026-04-13T00:00:00.000Z",
				updatedAt: "2026-04-13T00:00:00.000Z",
				confidence: options?.confidence ?? 0.82,
			},
		},
		reason: options?.reason ?? "exact-task-type",
		matchClass: (options?.reason ?? "exact-task-type").startsWith("exact-")
			? "exact"
			: "fuzzy",
		updatedAt: "2026-04-13T00:00:00.000Z",
		confidence: options?.confidence ?? 0.82,
	};
}

function createDocumentResult(options?: {
	id?: string;
	title?: string;
	bodyText?: string;
	sourceTable?: string;
	sourceId?: string;
	documentKind?: string;
	reason?: string;
	confidence?: number;
}) {
	return {
		item: {
			id: options?.id ?? "document-1",
			repoId: "/tmp/buildplane",
			sourceTable: options?.sourceTable ?? "runs",
			sourceId: options?.sourceId ?? "run-1",
			documentKind: options?.documentKind ?? "run-summary",
			title: options?.title ?? "Build failure summary",
			bodyText:
				options?.bodyText ?? "The branch replay failed during typecheck.",
			createdAt: "2026-04-13T00:00:00.000Z",
			updatedAt: "2026-04-13T00:00:00.000Z",
		},
		reason: options?.reason ?? "full-text-document",
		matchClass: (options?.reason ?? "full-text-document").startsWith("exact-")
			? "exact"
			: "full-text",
		updatedAt: "2026-04-13T00:00:00.000Z",
		confidence: options?.confidence ?? 0.7,
	};
}

function createStructuredMemoryPort(overrides?: {
	retrieveRepoFacts?: (query: { searchText?: string }) => unknown[];
	retrieveProcedures?: (query: {
		searchText?: string;
		taskType?: string;
	}) => unknown[];
	retrieveSearchableDocuments?: (query: {
		title?: string;
		sourceTable?: string;
		sourceId?: string;
		searchText?: string;
	}) => unknown[];
}) {
	return {
		retrieveRepoFacts: overrides?.retrieveRepoFacts ?? (() => []),
		retrieveProcedures: overrides?.retrieveProcedures ?? (() => []),
		retrieveSearchableDocuments:
			overrides?.retrieveSearchableDocuments ?? (() => []),
	};
}

describe("enrichPacketWithMemories", () => {
	it("injects memories into a packet that has an intent", async () => {
		const packet = createPacket();
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
		const packet = createPacket({
			objective: "Fix the TypeScript build",
			taskType: "debug_failure",
			files: ["apps/cli/src/run-cli.ts"],
			verification: ["npx pnpm typecheck"],
		});
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveRepoFacts: () => [createRepoFactResult()],
			retrieveProcedures: () => [createProcedureResult()],
		});

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
		const packet = createPacket({
			objective: "Fix the TypeScript build",
			taskType: "debug_failure",
			files: ["apps/cli/src/run-cli.ts"],
			verification: ["npx pnpm build"],
		});
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveRepoFacts: ({ searchText }: { searchText?: string }) => {
				if (searchText === "Fix the TypeScript build") {
					return [
						createRepoFactResult({
							id: "fact-weaker",
							factKey: "troubleshooting.build",
							factValue: "Investigate build logs before retrying.",
							reason: "fuzzy-fact-value",
							confidence: 1,
						}),
					];
				}
				if (searchText === "build") {
					return [
						createRepoFactResult({
							id: "fact-stronger",
							factKey: "commands.build",
							factValue: "npx pnpm build",
							reason: "fuzzy-fact-key",
							confidence: 0.7,
						}),
					];
				}
				return [];
			},
		});

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

	it("injects searchable documents with exact source matches before full-text fallbacks", async () => {
		const packet = createPacket({
			objective: "Investigate branch replay",
			taskType: "debug_failure",
			files: ["apps/cli/src/run-cli.ts"],
			verification: ["npx pnpm build"],
			inputRefs: ["runs:run-1"],
		});
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveSearchableDocuments: ({
				sourceTable,
				sourceId,
				searchText,
			}: {
				sourceTable?: string;
				sourceId?: string;
				searchText?: string;
			}) => {
				if (sourceTable === "runs" && sourceId === "run-1") {
					return [
						createDocumentResult({
							id: "doc-source",
							title: "Build failure summary",
							bodyText: "The branch replay failed during typecheck.",
							reason: "exact-source",
							confidence: 0.9,
						}),
					];
				}
				if (searchText === "branch") {
					return [
						createDocumentResult({
							id: "doc-fallback",
							title: "Cleanup checklist",
							bodyText: "Capture the branch replay logs before cleanup.",
							sourceTable: "notes",
							sourceId: "note-2",
							documentKind: "operator-note",
							reason: "full-text-document",
							confidence: 0.5,
						}),
					];
				}
				return [];
			},
		});

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
			"[document] Build failure summary: The branch replay failed during typecheck.",
			"[document] Cleanup checklist: Capture the branch replay logs before cleanup.",
		]);
	});

	it("supports slash-form searchable-document source refs and ignores unknown refs", async () => {
		const packet = createPacket({
			objective: "Inspect operator note",
			taskType: "review",
			files: ["apps/cli/src/run-cli.ts"],
			verification: ["npx pnpm typecheck"],
			inputRefs: ["notes/note-2", "outputs/result.txt", "garbage"],
		});
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveSearchableDocuments: ({
				sourceTable,
				sourceId,
			}: {
				sourceTable?: string;
				sourceId?: string;
			}) => {
				if (sourceTable === "notes" && sourceId === "note-2") {
					return [
						createDocumentResult({
							id: "doc-note",
							title: "Operator note",
							bodyText: "Inspect the retained workspace before cleanup.",
							sourceTable: "notes",
							sourceId: "note-2",
							documentKind: "operator-note",
							reason: "exact-source",
						}),
					];
				}
				return [];
			},
		});

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
			"[document] Operator note: Inspect the retained workspace before cleanup.",
		]);
	});

	it("deduplicates exact-title searchable documents ahead of full-text duplicates", async () => {
		const packet = createPacket({
			objective: "Build failure summary",
			taskType: "debug_failure",
			files: ["apps/cli/src/run-cli.ts"],
			verification: ["npx pnpm build"],
		});
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveSearchableDocuments: ({
				title,
				searchText,
			}: {
				title?: string;
				searchText?: string;
			}) => {
				if (title === "Build failure summary") {
					return [
						createDocumentResult({
							id: "doc-title",
							title: "Build failure summary",
							bodyText: "The branch replay failed during typecheck.",
							reason: "exact-title",
							confidence: 0.8,
						}),
					];
				}
				if (searchText === "build") {
					return [
						createDocumentResult({
							id: "doc-title",
							title: "Build failure summary",
							bodyText: "The branch replay failed during typecheck.",
							reason: "full-text-document",
							confidence: 0.3,
						}),
						createDocumentResult({
							id: "doc-related",
							title: "Replay cleanup note",
							bodyText: "Archive the branch replay logs after triage.",
							sourceTable: "notes",
							sourceId: "note-7",
							documentKind: "operator-note",
							reason: "full-text-document",
							confidence: 0.6,
						}),
					];
				}
				return [];
			},
		});

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
			"[document] Build failure summary: The branch replay failed during typecheck.",
			"[document] Replay cleanup note: Archive the branch replay logs after triage.",
		]);
	});

	it("keeps mixed-source memory ordering deterministic", async () => {
		const packet = createPacket({
			objective: "Fix the TypeScript build",
			taskType: "debug_failure",
			files: ["apps/cli/src/run-cli.ts"],
			verification: ["npx pnpm typecheck"],
		});
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveRepoFacts: () => [createRepoFactResult()],
			retrieveProcedures: () => [createProcedureResult()],
			retrieveSearchableDocuments: () => [
				createDocumentResult({
					id: "doc-1",
					title: "Build failure summary",
					bodyText: "The branch replay failed during typecheck.",
					reason: "full-text-document",
				}),
			],
		});
		const honchoAdapter = {
			fetchContext: async () => ({
				memories: ["user prefers exact verification output"],
			}),
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
			"[document] Build failure summary: The branch replay failed during typecheck.",
			"[honcho] user prefers exact verification output",
		]);
	});

	it("passes the run's current branch to repo-fact retrieval", async () => {
		const packet = createPacket({
			objective: "Fix the TypeScript build",
			taskType: "debug_failure",
			files: ["apps/cli/src/run-cli.ts"],
			verification: ["npx pnpm typecheck"],
		});
		const observedBranches: Array<string | undefined> = [];
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveRepoFacts: (query: { branch?: string }) => {
				observedBranches.push(query.branch);
				return [];
			},
		});

		await enrichPacketWithMemories(
			packet,
			undefined,
			undefined,
			undefined,
			structuredMemoryPort,
			"feat/phase2-s2",
		);

		expect(observedBranches.length).toBeGreaterThan(0);
		for (const branch of observedBranches) {
			expect(branch).toBe("feat/phase2-s2");
		}
	});

	it("leaves repo-fact retrieval unfiltered when no current branch is provided", async () => {
		const packet = createPacket({
			objective: "Fix the TypeScript build",
			taskType: "debug_failure",
			files: ["apps/cli/src/run-cli.ts"],
			verification: ["npx pnpm typecheck"],
		});
		const observedBranches: Array<string | undefined> = [];
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveRepoFacts: (query: { branch?: string }) => {
				observedBranches.push(query.branch);
				return [];
			},
		});

		await enrichPacketWithMemories(
			packet,
			undefined,
			undefined,
			undefined,
			structuredMemoryPort,
		);

		expect(observedBranches.length).toBeGreaterThan(0);
		for (const branch of observedBranches) {
			expect(branch).toBeUndefined();
		}
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
		const packet = createPacket();
		const result = await enrichPacketWithMemories(
			packet,
			undefined,
			undefined,
			undefined,
		);
		expect(result).toBe(packet);
	});

	it("returns packet unchanged when memoryPort returns empty learnings", async () => {
		const packet = createPacket();
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

describe("reviewer-side memory injection (Task C)", () => {
	const implementerPacket = {
		unit: {
			id: "task-x",
			kind: "model",
			scope: "task",
			inputRefs: [],
			expectedOutputs: ["out/result.js"],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
		verification: { requiredOutputs: ["out/result.js"] },
		intent: {
			objective: "Write a parser",
			taskType: "implement",
			context: { files: [] },
		},
	};

	it("enriches the reviewer child and keys injected memories by <id>-reviewer", async () => {
		// Returns a procedure ONLY for the review leg, proving the reviewer
		// packet now reaches enrichment (taskType:"review").
		const structuredMemoryPort = createStructuredMemoryPort({
			retrieveProcedures: (q: { taskType?: string }) =>
				q.taskType === "review"
					? [
							createProcedureResult({
								name: "How to review",
								reason: "exact-task-type",
							}),
						]
					: [],
		});

		const strategy = wrapAsStrategy(implementerPacket);
		const prepared = await prepareStrategyMemoryEnrichment(
			strategy as unknown as Record<string, unknown>,
			undefined,
			undefined,
			undefined,
			structuredMemoryPort,
			undefined,
		);

		expect(Object.keys(prepared.injectedMemoriesByUnitId)).toContain(
			"task-x-reviewer",
		);
		expect(
			prepared.injectedMemoriesByUnitId["task-x-reviewer"].length,
		).toBeGreaterThan(0);
	});
});
