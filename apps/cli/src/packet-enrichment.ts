import { basename } from "node:path";
import {
	dedupeRankedMemoryResults,
	type InjectedMemoryRecord,
	type RankedProcedureResult,
	type RankedRepoFactResult,
	type RankedSearchableDocumentResult,
} from "@buildplane/kernel";

const LOCAL_LEARNING_LIMIT = 10;
const STRUCTURED_QUERY_LIMIT = 5;
const STRUCTURED_REPO_FACT_LIMIT = 3;
const STRUCTURED_PROCEDURE_LIMIT = 2;
const STRUCTURED_SEARCHABLE_DOCUMENT_LIMIT = 2;
const MIN_KEYWORD_LENGTH = 4;
const SEARCHABLE_DOCUMENT_SOURCE_TABLES = new Set(["runs", "notes"]);

interface MemoryPortLike {
	fetchLearnings(options?: { limit?: number }): ReadonlyArray<{
		kind: string;
		title: string;
		body: string;
	}>;
}

interface StructuredMemoryPortLike {
	retrieveRepoFacts(query: {
		searchText?: string;
		scopeCandidates?: ReadonlyArray<{
			scopeType: string;
			scopeKey?: string;
		}>;
		branch?: string;
		limit?: number;
	}): ReadonlyArray<RankedRepoFactResult>;
	retrieveProcedures(query: {
		taskType?: string;
		searchText?: string;
		limit?: number;
	}): ReadonlyArray<RankedProcedureResult>;
	retrieveSearchableDocuments(query: {
		title?: string;
		sourceTable?: string;
		sourceId?: string;
		searchText?: string;
		limit?: number;
	}): ReadonlyArray<RankedSearchableDocumentResult>;
}

interface HonchoPortLike {
	fetchContext(userId: string): Promise<{ memories: string[] }>;
}

interface TaskIntentLike {
	objective?: string;
	taskType?: string;
	context?: {
		files?: readonly string[];
	};
	constraints?: {
		verification?: readonly string[];
	};
}

interface PacketWithIntent {
	unit?: {
		id?: string;
		inputRefs?: readonly string[];
	};
	intent?: TaskIntentLike & {
		context?: Record<string, unknown> & {
			files?: readonly string[];
		};
	};
}

export interface PacketMemoryEnrichmentResult {
	readonly packet: unknown;
	readonly injectedMemories: readonly InjectedMemoryRecord[];
}

export interface GraphMemoryEnrichmentResult {
	readonly graph: Record<string, unknown>;
	readonly injectedMemoriesByUnitId: Record<
		string,
		readonly InjectedMemoryRecord[]
	>;
}

export interface StrategyMemoryEnrichmentResult {
	readonly strategy: Record<string, unknown>;
	readonly injectedMemoriesByUnitId: Record<
		string,
		readonly InjectedMemoryRecord[]
	>;
}

function addUniqueValue(
	values: string[],
	seen: Set<string>,
	value: string | undefined,
): void {
	if (!value) {
		return;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return;
	}
	const key = trimmed.toLowerCase();
	if (seen.has(key)) {
		return;
	}
	seen.add(key);
	values.push(trimmed);
}

// Cross-layer injection precedence (Phase 2 · S1).
//
// At this assembly each source has already been collapsed to display-text
// strings, so the only identity available across every layer is the
// normalized display text — the structured `memoryId`s live in the parallel
// `injectedMemories` records, and the run-learning / honcho layers carry no id
// at all here. We therefore key cross-layer dedup on normalized display text
// with the leading `[layer-tag]` stripped, so the same underlying memory
// surfacing under different layer tags collapses to one entry.
//
// Precedence is source-order: the caller passes layers ordered
// `structured (repo_facts ≻ procedures ≻ documents) ≻ run_learnings ≻ honcho`,
// and the first occurrence wins. The contract's finer tie-breaks (confidence,
// then recency) are NOT applied here because that data does not survive to the
// assembly — only display strings do — so we fall back to source-order
// precedence as the contract permits.
function normalizeCrossLayerIdentity(value: string): string {
	return value
		.replace(/^\[[^\]]*\]\s*/, "")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();
}

export function dedupeAcrossLayers(
	sources: ReadonlyArray<readonly string[]>,
): string[] {
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const layer of sources) {
		for (const value of layer) {
			const trimmed = value.trim();
			if (!trimmed) {
				continue;
			}
			const key = normalizeCrossLayerIdentity(value);
			if (!key || seen.has(key)) {
				continue;
			}
			seen.add(key);
			deduped.push(value);
		}
	}
	return deduped;
}

function extractKeywords(text: string | undefined): string[] {
	if (!text) {
		return [];
	}
	return text
		.split(/[^a-zA-Z0-9._/-]+/)
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part.length >= MIN_KEYWORD_LENGTH);
}

function buildSearchTerms(intent: TaskIntentLike): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	const files = intent.context?.files ?? [];
	const verificationCommands = intent.constraints?.verification ?? [];

	addUniqueValue(terms, seen, intent.objective);
	for (const keyword of extractKeywords(intent.objective)) {
		addUniqueValue(terms, seen, keyword);
	}

	addUniqueValue(terms, seen, intent.taskType);

	for (const file of files) {
		addUniqueValue(terms, seen, file);
		addUniqueValue(terms, seen, basename(file));
	}

	for (const command of verificationCommands) {
		addUniqueValue(terms, seen, command);
		for (const keyword of extractKeywords(command)) {
			addUniqueValue(terms, seen, keyword);
		}
	}

	return terms;
}

function buildRepoFactScopeCandidates(
	intent: TaskIntentLike,
	currentBranch: string | undefined,
): Array<{ scopeType: string; scopeKey?: string }> {
	const candidates: Array<{ scopeType: string; scopeKey?: string }> = [];
	const seen = new Set<string>();
	const files = intent.context?.files ?? [];

	const pushCandidate = (scopeType: string, scopeKey?: string) => {
		const normalizedScopeKey = scopeKey?.trim();
		const dedupeKey = `${scopeType}:${normalizedScopeKey ?? ""}`;
		if (seen.has(dedupeKey)) {
			return;
		}
		seen.add(dedupeKey);
		candidates.push(
			normalizedScopeKey
				? { scopeType, scopeKey: normalizedScopeKey }
				: { scopeType },
		);
	};

	pushCandidate("branch", currentBranch);
	for (const file of files) {
		pushCandidate("file-path", file);
	}
	pushCandidate("task-type", intent.taskType);
	pushCandidate("repo");
	pushCandidate("global");

	return candidates;
}

function parseSearchableDocumentSourceRefs(
	inputRefs: readonly string[] | undefined,
): Array<{ sourceTable: string; sourceId: string }> {
	const parsedRefs: Array<{ sourceTable: string; sourceId: string }> = [];
	const seen = new Set<string>();

	for (const inputRef of inputRefs ?? []) {
		const match = inputRef.match(/^([^:/]+)[:/](.+)$/);
		if (!match) {
			continue;
		}
		const [, sourceTable, rawSourceId] = match;
		const normalizedSourceTable = sourceTable.trim();
		const normalizedSourceId = rawSourceId.trim();
		if (
			!SEARCHABLE_DOCUMENT_SOURCE_TABLES.has(normalizedSourceTable) ||
			normalizedSourceId.length === 0
		) {
			continue;
		}
		const dedupeKey = `${normalizedSourceTable}:${normalizedSourceId}`;
		if (seen.has(dedupeKey)) {
			continue;
		}
		seen.add(dedupeKey);
		parsedRefs.push({
			sourceTable: normalizedSourceTable,
			sourceId: normalizedSourceId,
		});
	}

	return parsedRefs;
}

function formatRepoFactValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (value === null) {
		return "null";
	}
	if (value === undefined) {
		return "undefined";
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function summarizeProcedure(bodyMarkdown: string): string {
	const firstLine =
		bodyMarkdown
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	return firstLine
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.trim();
}

function summarizeSearchableDocument(bodyText: string): string {
	return (
		bodyText
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	).trim();
}

function createInjectedMemoryRecord(
	memoryKind: InjectedMemoryRecord["memoryKind"],
	memoryId: string,
	displayText: string,
	matchReason: string,
	matchClass: InjectedMemoryRecord["matchClass"],
	scopePreferenceIndex?: number,
): InjectedMemoryRecord {
	return {
		memoryKind,
		memoryId,
		displayText,
		matchReason,
		matchClass,
		scopePreferenceIndex,
	};
}

function collectStructuredMemoryEnrichment(
	packet: PacketWithIntent,
	structuredMemoryPort: StructuredMemoryPortLike | undefined,
	currentBranch: string | undefined,
): {
	readonly memories: readonly string[];
	readonly injectedMemories: readonly InjectedMemoryRecord[];
} {
	const intent = packet.intent;
	if (!structuredMemoryPort || !intent) {
		return { memories: [], injectedMemories: [] };
	}

	const searchTerms = buildSearchTerms(intent);
	const scopeCandidates = buildRepoFactScopeCandidates(intent, currentBranch);
	const searchableDocumentSourceRefs = parseSearchableDocumentSourceRefs(
		packet.unit?.inputRefs,
	);

	const repoFactResults = dedupeRankedMemoryResults(
		searchTerms.flatMap((searchText) =>
			structuredMemoryPort.retrieveRepoFacts({
				searchText,
				scopeCandidates,
				branch: currentBranch,
				limit: STRUCTURED_QUERY_LIMIT,
			}),
		),
	).slice(0, STRUCTURED_REPO_FACT_LIMIT);

	const procedureQueries =
		searchTerms.length > 0 ? searchTerms : intent.taskType ? [""] : [];
	const procedureResults = dedupeRankedMemoryResults(
		procedureQueries.flatMap((searchText) =>
			structuredMemoryPort.retrieveProcedures({
				taskType: intent.taskType,
				searchText: searchText || undefined,
				limit: STRUCTURED_QUERY_LIMIT,
			}),
		),
	).slice(0, STRUCTURED_PROCEDURE_LIMIT);

	const searchableDocumentResults = dedupeRankedMemoryResults([
		...searchableDocumentSourceRefs.flatMap(({ sourceTable, sourceId }) =>
			structuredMemoryPort.retrieveSearchableDocuments({
				sourceTable,
				sourceId,
				limit: STRUCTURED_QUERY_LIMIT,
			}),
		),
		...(intent.objective
			? structuredMemoryPort.retrieveSearchableDocuments({
					title: intent.objective,
					limit: STRUCTURED_QUERY_LIMIT,
				})
			: []),
		...searchTerms.flatMap((searchText) =>
			structuredMemoryPort.retrieveSearchableDocuments({
				searchText,
				limit: STRUCTURED_QUERY_LIMIT,
			}),
		),
	]).slice(0, STRUCTURED_SEARCHABLE_DOCUMENT_LIMIT);

	const repoFactInjections = repoFactResults.map((result) => {
		const displayText = `[repo-fact] ${result.item.factKey}: ${formatRepoFactValue(result.item.factValue)}`;
		return {
			displayText,
			record: createInjectedMemoryRecord(
				"repo-fact",
				result.item.id,
				displayText,
				result.reason,
				result.matchClass,
				result.scopePreferenceIndex,
			),
		};
	});

	const procedureInjections = procedureResults.map((result) => {
		const summary = summarizeProcedure(result.item.bodyMarkdown);
		const displayText = summary
			? `[procedure] ${result.item.name}: ${summary}`
			: `[procedure] ${result.item.name}`;
		return {
			displayText,
			record: createInjectedMemoryRecord(
				"procedure",
				result.item.id,
				displayText,
				result.reason,
				result.matchClass,
				result.scopePreferenceIndex,
			),
		};
	});

	const searchableDocumentInjections = searchableDocumentResults.map(
		(result) => {
			const title = result.item.title?.trim();
			const label =
				title || `${result.item.sourceTable}/${result.item.sourceId}`;
			const summary = summarizeSearchableDocument(result.item.bodyText);
			const displayText = summary
				? `[document] ${label}: ${summary}`
				: `[document] ${label}`;
			return {
				displayText,
				record: createInjectedMemoryRecord(
					"searchable-document",
					result.item.id,
					displayText,
					result.reason,
					result.matchClass,
					result.scopePreferenceIndex,
				),
			};
		},
	);

	const allInjections = [
		...repoFactInjections,
		...procedureInjections,
		...searchableDocumentInjections,
	];

	return {
		memories: allInjections.map((injection) => injection.displayText),
		injectedMemories: allInjections.map((injection) => injection.record),
	};
}

export async function preparePacketMemoryEnrichment(
	packet: unknown,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
	structuredMemoryPort?: StructuredMemoryPortLike,
	currentBranch?: string,
): Promise<PacketMemoryEnrichmentResult> {
	const p = packet as PacketWithIntent;
	if (!p.intent) {
		return { packet, injectedMemories: [] };
	}
	if (!memoryPort && !honchoAdapter && !structuredMemoryPort) {
		return { packet, injectedMemories: [] };
	}

	const localLearnings =
		memoryPort?.fetchLearnings({ limit: LOCAL_LEARNING_LIMIT }) ?? [];
	const structuredMemoryEnrichment = collectStructuredMemoryEnrichment(
		p,
		structuredMemoryPort,
		currentBranch,
	);
	const honchoMemories =
		honchoAdapter && userId
			? (await honchoAdapter.fetchContext(userId)).memories.map(
					(m) => `[honcho] ${m}`,
				)
			: [];

	const memories = dedupeAcrossLayers([
		structuredMemoryEnrichment.memories,
		localLearnings.map((l) => `[${l.kind}] ${l.title}: ${l.body}`),
		honchoMemories,
	]);

	if (memories.length === 0) {
		return {
			packet,
			injectedMemories: structuredMemoryEnrichment.injectedMemories,
		};
	}

	return {
		packet: {
			...(packet as object),
			intent: {
				...(p.intent as object),
				context: {
					...(p.intent.context as object),
					memories,
				},
			},
		},
		injectedMemories: structuredMemoryEnrichment.injectedMemories,
	};
}

export async function enrichPacketWithMemories(
	packet: unknown,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
	structuredMemoryPort?: StructuredMemoryPortLike,
	currentBranch?: string,
): Promise<unknown> {
	return (
		await preparePacketMemoryEnrichment(
			packet,
			memoryPort,
			honchoAdapter,
			userId,
			structuredMemoryPort,
			currentBranch,
		)
	).packet;
}

export async function prepareGraphMemoryEnrichment(
	graph: Record<string, unknown>,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
	structuredMemoryPort?: StructuredMemoryPortLike,
	currentBranch?: string,
): Promise<GraphMemoryEnrichmentResult> {
	const nodes = (graph.nodes as unknown[]) ?? [];
	const injectedMemoriesByUnitId: Record<
		string,
		readonly InjectedMemoryRecord[]
	> = {};
	const enrichedNodes = await Promise.all(
		nodes.map(async (node) => {
			const prepared = await preparePacketMemoryEnrichment(
				node,
				memoryPort,
				honchoAdapter,
				userId,
				structuredMemoryPort,
				currentBranch,
			);
			const unitId = (node as PacketWithIntent).unit?.id;
			if (unitId && prepared.injectedMemories.length > 0) {
				injectedMemoriesByUnitId[unitId] = prepared.injectedMemories;
			}
			return prepared.packet;
		}),
	);
	return {
		graph: { ...graph, nodes: enrichedNodes },
		injectedMemoriesByUnitId,
	};
}

export async function enrichGraphWithMemories(
	graph: Record<string, unknown>,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
	structuredMemoryPort?: StructuredMemoryPortLike,
	currentBranch?: string,
): Promise<unknown> {
	return (
		await prepareGraphMemoryEnrichment(
			graph,
			memoryPort,
			honchoAdapter,
			userId,
			structuredMemoryPort,
			currentBranch,
		)
	).graph;
}

export async function prepareStrategyMemoryEnrichment(
	strategy: Record<string, unknown>,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
	structuredMemoryPort?: StructuredMemoryPortLike,
	currentBranch?: string,
): Promise<StrategyMemoryEnrichmentResult> {
	const children = (strategy.children as Array<{ packet: unknown }>) ?? [];
	const injectedMemoriesByUnitId: Record<
		string,
		readonly InjectedMemoryRecord[]
	> = {};
	const enrichedChildren = await Promise.all(
		children.map(async (child) => {
			const prepared = await preparePacketMemoryEnrichment(
				child.packet,
				memoryPort,
				honchoAdapter,
				userId,
				structuredMemoryPort,
				currentBranch,
			);
			const unitId = (child.packet as PacketWithIntent).unit?.id;
			if (unitId && prepared.injectedMemories.length > 0) {
				injectedMemoriesByUnitId[unitId] = prepared.injectedMemories;
			}
			return {
				...child,
				packet: prepared.packet,
			};
		}),
	);
	return {
		strategy: { ...strategy, children: enrichedChildren },
		injectedMemoriesByUnitId,
	};
}

export async function enrichStrategyWithMemories(
	strategy: Record<string, unknown>,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
	structuredMemoryPort?: StructuredMemoryPortLike,
	currentBranch?: string,
): Promise<unknown> {
	return (
		await prepareStrategyMemoryEnrichment(
			strategy,
			memoryPort,
			honchoAdapter,
			userId,
			structuredMemoryPort,
			currentBranch,
		)
	).strategy;
}
