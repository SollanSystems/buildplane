export type MemoryType =
	| "repo-fact"
	| "procedure"
	| "outcome-score"
	| "episodic-summary";

export type MemoryScopeType =
	| "global"
	| "organization"
	| "repo"
	| "branch"
	| "file-path"
	| "task-type"
	| "engine"
	| "workflow";

export type MemoryStatus = "active" | "stale" | "superseded" | "archived";

export type MemoryValueType = "string" | "number" | "boolean" | "json";

export type MemoryCreatedBy = "system" | "worker" | "operator";

export interface MemoryProvenance {
	readonly sourceRunId?: string;
	readonly sourceTaskId?: string;
	readonly createdBy: MemoryCreatedBy;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly confidence: number;
	readonly repoId?: string;
	readonly branch?: string;
	readonly commitSha?: string;
}

export interface BaseMemoryRecord {
	readonly id: string;
	readonly memoryType: MemoryType;
	readonly scopeType: MemoryScopeType;
	readonly scopeKey?: string;
	readonly status: MemoryStatus;
	readonly provenance: MemoryProvenance;
}

export interface RepoFact extends BaseMemoryRecord {
	readonly memoryType: "repo-fact";
	readonly factKey: string;
	readonly valueType: MemoryValueType;
	readonly factValue: unknown;
}

export interface ProcedureMemory extends BaseMemoryRecord {
	readonly memoryType: "procedure";
	readonly name: string;
	readonly taskType?: string;
	readonly bodyMarkdown: string;
	readonly metadata?: Record<string, unknown>;
}
