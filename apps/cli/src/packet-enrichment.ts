import { basename } from "node:path";
import {
	dedupeRankedMemoryResults,
	type RankedProcedureResult,
	type RankedRepoFactResult,
} from "@buildplane/kernel";

const LOCAL_LEARNING_LIMIT = 10;
const STRUCTURED_QUERY_LIMIT = 5;
const STRUCTURED_REPO_FACT_LIMIT = 3;
const STRUCTURED_PROCEDURE_LIMIT = 2;
const MIN_KEYWORD_LENGTH = 4;

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
		limit?: number;
	}): ReadonlyArray<RankedRepoFactResult>;
	retrieveProcedures(query: {
		taskType?: string;
		searchText?: string;
		limit?: number;
	}): ReadonlyArray<RankedProcedureResult>;
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
	intent?: TaskIntentLike & {
		context?: Record<string, unknown> & {
			files?: readonly string[];
		};
	};
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
			normalizedScopeKey ? { scopeType, scopeKey: normalizedScopeKey } : { scopeType },
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

function collectStructuredMemoryStrings(
	intent: TaskIntentLike,
	structuredMemoryPort: StructuredMemoryPortLike | undefined,
	currentBranch: string | undefined,
): string[] {
	if (!structuredMemoryPort) {
		return [];
	}

	const searchTerms = buildSearchTerms(intent);
	const scopeCandidates = buildRepoFactScopeCandidates(intent, currentBranch);

	const repoFactResults = dedupeRankedMemoryResults(
		searchTerms.flatMap((searchText) =>
			structuredMemoryPort.retrieveRepoFacts({
				searchText,
				scopeCandidates,
				limit: STRUCTURED_QUERY_LIMIT,
			}),
		),
	).slice(0, STRUCTURED_REPO_FACT_LIMIT);

	const procedureQueries =
		searchTerms.length > 0
			? searchTerms
			: intent.taskType
				? [""]
				: [];
	const procedureResults = dedupeRankedMemoryResults(
		procedureQueries.flatMap((searchText) =>
			structuredMemoryPort.retrieveProcedures({
				taskType: intent.taskType,
				searchText: searchText || undefined,
				limit: STRUCTURED_QUERY_LIMIT,
			}),
		),
	).slice(0, STRUCTURED_PROCEDURE_LIMIT);

	return [
		...repoFactResults.map(
			(result) =>
				`[repo-fact] ${result.item.factKey}: ${formatRepoFactValue(result.item.factValue)}`,
		),
		...procedureResults.map((result) => {
			const summary = summarizeProcedure(result.item.bodyMarkdown);
			return summary
				? `[procedure] ${result.item.name}: ${summary}`
				: `[procedure] ${result.item.name}`;
		}),
	];
}

export async function enrichPacketWithMemories(
	packet: unknown,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
	structuredMemoryPort?: StructuredMemoryPortLike,
	currentBranch?: string,
): Promise<unknown> {
	const p = packet as PacketWithIntent;
	if (!p.intent) return packet;
	if (!memoryPort && !honchoAdapter && !structuredMemoryPort) return packet;

	const localLearnings = memoryPort?.fetchLearnings({ limit: LOCAL_LEARNING_LIMIT }) ?? [];
	const structuredMemories = collectStructuredMemoryStrings(
		p.intent,
		structuredMemoryPort,
		currentBranch,
	);
	const honchoMemories =
		honchoAdapter && userId
			? (await honchoAdapter.fetchContext(userId)).memories.map(
					(m) => `[honcho] ${m}`,
				)
			: [];

	const memories = [
		...localLearnings.map((l) => `[${l.kind}] ${l.title}: ${l.body}`),
		...structuredMemories,
		...honchoMemories,
	];

	if (memories.length === 0) return packet;

	return {
		...(packet as object),
		intent: {
			...(p.intent as object),
			context: {
				...(p.intent.context as object),
				memories,
			},
		},
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
	const nodes = (graph.nodes as unknown[]) ?? [];
	const enriched = await Promise.all(
		nodes.map((node) =>
			enrichPacketWithMemories(
				node,
				memoryPort,
				honchoAdapter,
				userId,
				structuredMemoryPort,
				currentBranch,
			),
		),
	);
	return { ...graph, nodes: enriched };
}

export async function enrichStrategyWithMemories(
	strategy: Record<string, unknown>,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: HonchoPortLike | undefined,
	userId: string | undefined,
	structuredMemoryPort?: StructuredMemoryPortLike,
	currentBranch?: string,
): Promise<unknown> {
	const children = (strategy.children as Array<{ packet: unknown }>) ?? [];
	const enrichedChildren = await Promise.all(
		children.map(async (child) => ({
			...child,
			packet: await enrichPacketWithMemories(
				child.packet,
				memoryPort,
				honchoAdapter,
				userId,
				structuredMemoryPort,
				currentBranch,
			),
		})),
	);
	return { ...strategy, children: enrichedChildren };
}
