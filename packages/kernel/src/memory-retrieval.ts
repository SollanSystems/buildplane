import type {
	MemoryScopeType,
	ProcedureMemory,
	RepoFact,
	SearchableDocument,
} from "./memory-types.js";

export type StructuredMemoryMatchReason =
	| "exact-source"
	| "exact-title"
	| "exact-name"
	| "exact-fact-key"
	| "exact-task-type"
	| "fuzzy-fact-key"
	| "fuzzy-name"
	| "fuzzy-fact-value"
	| "fuzzy-body"
	| "full-text-document";

export type StructuredMemoryMatchClass = "exact" | "fuzzy" | "full-text";

export interface RepoFactScopeCandidate {
	readonly scopeType: MemoryScopeType;
	readonly scopeKey?: string;
}

export interface RepoFactRetrievalQuery {
	readonly factKey?: string;
	readonly searchText?: string;
	readonly scopeCandidates?: readonly RepoFactScopeCandidate[];
	readonly limit?: number;
}

export interface ProcedureRetrievalQuery {
	readonly taskType?: string;
	readonly name?: string;
	readonly searchText?: string;
	readonly limit?: number;
}

export interface SearchableDocumentRetrievalQuery {
	readonly title?: string;
	readonly sourceTable?: string;
	readonly sourceId?: string;
	readonly searchText?: string;
	readonly documentKind?: string;
	readonly limit?: number;
}

export interface RankedMemoryResult<TMemory extends { readonly id: string }> {
	readonly item: TMemory;
	readonly reason: StructuredMemoryMatchReason;
	readonly matchClass: StructuredMemoryMatchClass;
	readonly confidence: number;
	readonly updatedAt: string;
	readonly scopePreferenceIndex?: number;
}

export type RankedRepoFactResult = RankedMemoryResult<RepoFact>;
export type RankedProcedureResult = RankedMemoryResult<ProcedureMemory>;
export type RankedSearchableDocumentResult =
	RankedMemoryResult<SearchableDocument>;

const MATCH_REASON_PRIORITY = {
	"exact-source": 0,
	"exact-title": 1,
	"exact-name": 2,
	"exact-fact-key": 3,
	"exact-task-type": 4,
	"fuzzy-fact-key": 5,
	"fuzzy-name": 6,
	"fuzzy-fact-value": 7,
	"fuzzy-body": 8,
	"full-text-document": 9,
} as const satisfies Record<StructuredMemoryMatchReason, number>;

export function getStructuredMemoryMatchClass(
	reason: StructuredMemoryMatchReason,
): StructuredMemoryMatchClass {
	if (reason.startsWith("exact-")) {
		return "exact";
	}
	if (reason.startsWith("fuzzy-")) {
		return "fuzzy";
	}
	return "full-text";
}

export function createRankedMemoryResult<
	TMemory extends { readonly id: string },
>(input: {
	readonly item: TMemory;
	readonly reason: StructuredMemoryMatchReason;
	readonly confidence: number;
	readonly updatedAt: string;
	readonly scopePreferenceIndex?: number;
}): RankedMemoryResult<TMemory> {
	return {
		item: input.item,
		reason: input.reason,
		matchClass: getStructuredMemoryMatchClass(input.reason),
		confidence: input.confidence,
		updatedAt: input.updatedAt,
		scopePreferenceIndex: input.scopePreferenceIndex,
	};
}

function parseUpdatedAtTimestamp(updatedAt: string): number {
	const timestamp = Date.parse(updatedAt);
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

function normalizeScopePreferenceIndex<TMemory extends { readonly id: string }>(
	result: RankedMemoryResult<TMemory>,
): number {
	return result.scopePreferenceIndex ?? Number.MAX_SAFE_INTEGER;
}

export function compareRankedMemoryResults<
	TMemory extends { readonly id: string },
>(
	left: RankedMemoryResult<TMemory>,
	right: RankedMemoryResult<TMemory>,
): number {
	const reasonPriorityDelta =
		MATCH_REASON_PRIORITY[left.reason] - MATCH_REASON_PRIORITY[right.reason];
	if (reasonPriorityDelta !== 0) {
		return reasonPriorityDelta;
	}

	const scopePreferenceDelta =
		normalizeScopePreferenceIndex(left) - normalizeScopePreferenceIndex(right);
	if (scopePreferenceDelta !== 0) {
		return scopePreferenceDelta;
	}

	if (left.confidence !== right.confidence) {
		return right.confidence - left.confidence;
	}

	const recencyDelta =
		parseUpdatedAtTimestamp(right.updatedAt) -
		parseUpdatedAtTimestamp(left.updatedAt);
	if (recencyDelta !== 0) {
		return recencyDelta;
	}

	return left.item.id.localeCompare(right.item.id);
}

export function rankMemoryResults<TMemory extends { readonly id: string }>(
	results: readonly RankedMemoryResult<TMemory>[],
): RankedMemoryResult<TMemory>[] {
	return [...results].sort(compareRankedMemoryResults);
}

export function dedupeRankedMemoryResults<
	TMemory extends { readonly id: string },
>(
	results: readonly RankedMemoryResult<TMemory>[],
): RankedMemoryResult<TMemory>[] {
	const bestResultById = new Map<string, RankedMemoryResult<TMemory>>();

	for (const result of results) {
		const existing = bestResultById.get(result.item.id);
		if (!existing || compareRankedMemoryResults(result, existing) < 0) {
			bestResultById.set(result.item.id, result);
		}
	}

	return rankMemoryResults(Array.from(bestResultById.values()));
}
