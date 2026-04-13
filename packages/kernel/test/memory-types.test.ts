import { describe, expect, it } from "vitest";
import type {
	MemoryProvenance,
	MemoryScopeType,
	MemoryStatus,
	MemoryType,
	ProcedureMemory,
	RepoFact,
} from "../src/memory-types";

describe("memory types", () => {
	it("defines repo facts with scope and provenance", () => {
		const memoryType: MemoryType = "repo-fact";
		const scopeType: MemoryScopeType = "repo";
		const status: MemoryStatus = "active";

		const provenance: MemoryProvenance = {
			sourceRunId: "run-1",
			sourceTaskId: "task-1",
			createdBy: "system",
			createdAt: "2026-04-12T00:00:00.000Z",
			updatedAt: "2026-04-12T00:00:00.000Z",
			confidence: 0.9,
			repoId: "repo-1",
			branch: "main",
			commitSha: "abc123",
		};

		const fact: RepoFact = {
			id: "fact-1",
			memoryType,
			scopeType,
			scopeKey: "repo-1",
			status,
			factKey: "commands.test",
			valueType: "string",
			factValue: "pnpm test",
			provenance,
		};

		expect(fact.factKey).toBe("commands.test");
		expect(fact.provenance.createdBy).toBe("system");
	});

	it("defines reusable procedural memory", () => {
		const procedure: ProcedureMemory = {
			id: "procedure-1",
			memoryType: "procedure",
			scopeType: "task-type",
			scopeKey: "bugfix",
			status: "active",
			name: "fix failing TypeScript build",
			taskType: "debug_failure",
			bodyMarkdown: "1. Run typecheck\n2. Fix import\n3. Rerun tests",
			provenance: {
				sourceRunId: "run-2",
				sourceTaskId: "task-2",
				createdBy: "worker",
				createdAt: "2026-04-12T00:00:00.000Z",
				updatedAt: "2026-04-12T00:00:00.000Z",
				confidence: 0.85,
			},
		};

		expect(procedure.memoryType).toBe("procedure");
		expect(procedure.taskType).toBe("debug_failure");
	});
});
