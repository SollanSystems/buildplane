import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createToolRegistry } from "@buildplane/adapters-tools";
import {
	createTapeEmitter,
	type LedgerFailure,
	type TapeEmitter,
} from "@buildplane/ledger-client";
import {
	type BootstrapDoctorReport,
	inspectBootstrapDoctor,
} from "./bootstrap-doctor.js";
import {
	formatBootstrapDoctorReport,
	formatHumanError,
	formatInitializationResult,
	formatInspectDetail,
	formatJson,
	formatJsonError,
	formatLearningDetail,
	formatLearningsList,
	formatRunHistory,
	formatRunResult,
	formatStrategyRunResult,
	formatWorkflowScanPreview,
	formatWorkspaceCleanupResult,
	formatWorkspaceList,
} from "./formatters.js";
import { runGitCheckpoint } from "./ledger-git-checkpoint.js";
import { wrapToolRegistryForLedger } from "./ledger-tool-wrapper.js";
import type {
	PacketMemoryEnrichmentResult,
	preparePacketMemoryEnrichment,
} from "./packet-enrichment.js";
import { scanWorkflowPreview } from "./workflow-scan.js";

// Monotonic UUIDv7 generator for TS-side event ids.
//
// Critical: `id` on the ledger's events table is UUIDv7. SQLite sorts events
// lexicographically by id, which for UUIDv7 matches time order — BUT only if
// two ids generated in the same ms are ordered by a deterministic counter
// rather than random tie-break. Otherwise `tool_result` (emitted right after
// `tool_request`) can sort before it in events.db, breaking replay's
// parent_chain invariant.
//
// This implementation:
//   - bits 0-47: current ms timestamp
//   - bits 48-51: version nibble (0x7)
//   - bits 52-63: 12-bit monotonic counter (resets when ms advances)
//   - bits 64-65: variant (0b10)
//   - bits 66-127: 62 random bits
//
// If the counter saturates within a single ms (>4096 calls), we bump the ms
// timestamp by 1 and reset the counter. This is rare in practice but
// preserves strict monotonicity.
let lastMs = 0n;
let subMsCounter = 0;
function generateUuidV7(): string {
	let nowMs = BigInt(Date.now());
	if (nowMs <= lastMs) {
		subMsCounter += 1;
		if (subMsCounter >= 0x1000) {
			// Counter saturated within one ms; bump the timestamp and reset.
			lastMs = lastMs + 1n;
			nowMs = lastMs;
			subMsCounter = 0;
		} else {
			nowMs = lastMs;
		}
	} else {
		lastMs = nowMs;
		subMsCounter = 0;
	}

	// 16-byte UUID: 48-bit timestamp || 4-bit version || 12-bit counter
	//             || 2-bit variant || 62-bit random
	const bytes = randomBytes(16);

	// Timestamp (big-endian ms in bytes 0-5)
	bytes[0] = Number((nowMs >> 40n) & 0xffn);
	bytes[1] = Number((nowMs >> 32n) & 0xffn);
	bytes[2] = Number((nowMs >> 24n) & 0xffn);
	bytes[3] = Number((nowMs >> 16n) & 0xffn);
	bytes[4] = Number((nowMs >> 8n) & 0xffn);
	bytes[5] = Number(nowMs & 0xffn);

	// Version nibble (0x7) || high 4 bits of counter
	bytes[6] = 0x70 | ((subMsCounter >> 8) & 0x0f);
	// Low 8 bits of counter
	bytes[7] = subMsCounter & 0xff;

	// Variant (0b10xxxxxx in byte 8)
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	// Format as 8-4-4-4-12
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type StructuredMemoryPortLike = NonNullable<
	Parameters<typeof preparePacketMemoryEnrichment>[4]
>;
type InjectedMemoryRecordLike =
	PacketMemoryEnrichmentResult["injectedMemories"][number];

interface PersistedInjectedMemoryRecordLike extends InjectedMemoryRecordLike {
	readonly id: string;
	readonly runId: string;
	readonly createdAt: string;
}

interface StructuredMemoryStoragePortLike extends StructuredMemoryPortLike {
	recordInjectedMemories(
		runId: string,
		records: readonly InjectedMemoryRecordLike[],
	): void;
	listInjectedMemories(
		runId: string,
	): readonly PersistedInjectedMemoryRecordLike[];
	recordRunStrategyId(runId: string, strategyId: string): void;
}

export interface RunCliDependencies {
	createOrchestrator?: () => BuildplaneCliOrchestrator;
	parsePacket?: (packetPath: string) => unknown;
	inspectBootstrapDoctor?: () => BootstrapDoctorReport;
	runNativeCommand?: (
		argv: string[],
		options: {
			cwd: string;
			commandPath: string[];
			stdout: (line: string) => void;
			stderr: (line: string) => void;
		},
	) => Promise<number> | number;
}

export interface RunCliOptions {
	readonly cwd?: string;
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
	readonly dependencies?: RunCliDependencies;
}

const BUILDPLANE_BANNER = "Buildplane by SollanSystems";

async function cliImport(specifier: string): Promise<unknown> {
	switch (specifier) {
		case "@buildplane/kernel":
			return import("@buildplane/kernel");
		case "@buildplane/runtime":
			return import("@buildplane/runtime");
		case "@buildplane/policy":
			return import("@buildplane/policy");
		case "@buildplane/storage":
			return import("@buildplane/storage");
		case "@buildplane/adapters-git":
			return import("@buildplane/adapters-git");
		case "@buildplane/adapters-models":
			return import("@buildplane/adapters-models");
		case "@buildplane/adapters-codex":
			return import("@buildplane/adapters-codex");
		case "@buildplane/adapters-honcho":
			return import("@buildplane/adapters-honcho");
		case "@buildplane/ui-tui":
			return import("@buildplane/ui-tui");
		default:
			throw new Error(`Unsupported workspace import '${specifier}'`);
	}
}

function resolveCurrentBranch(projectRoot: string): string | undefined {
	const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		cwd: projectRoot,
		encoding: "utf8",
		env: process.env,
	});
	if (result.status !== 0) {
		return undefined;
	}
	const branch = result.stdout.trim();
	return branch && branch !== "HEAD" ? branch : undefined;
}

function persistInjectedMemories(
	storagePort: StructuredMemoryStoragePortLike | undefined,
	runId: string,
	records: readonly InjectedMemoryRecordLike[],
): readonly PersistedInjectedMemoryRecordLike[] {
	if (!storagePort || records.length === 0) {
		return [];
	}
	storagePort.recordInjectedMemories(runId, records);
	return [...storagePort.listInjectedMemories(runId)];
}

function withPersistedInjectedMemories<T extends { run: { id: string } }>(
	result: T,
	storagePort: StructuredMemoryStoragePortLike | undefined,
	records: readonly InjectedMemoryRecordLike[],
): T & { injectedMemories?: readonly PersistedInjectedMemoryRecordLike[] } {
	const injectedMemories = persistInjectedMemories(
		storagePort,
		result.run.id,
		records,
	);
	if (injectedMemories.length === 0) {
		return result;
	}
	return {
		...result,
		injectedMemories,
	};
}

function collectStrategyRunTargets(result: {
	childResults: Map<string, { run?: { id?: string } }>;
	rounds?: ReadonlyArray<Map<string, { run?: { id?: string } }>>;
}): ReadonlyArray<{ unitId: string; runId?: string }> {
	const targets: Array<{ unitId: string; runId?: string }> = [];
	const addResults = (
		entries: Iterable<[string, { run?: { id?: string } }]>,
	) => {
		for (const [unitId, childResult] of entries) {
			targets.push({
				unitId,
				runId: childResult.run?.id,
			});
		}
	};

	for (const round of result.rounds ?? []) {
		addResults(Array.from(round.entries()));
	}
	addResults(Array.from(result.childResults.entries()));
	return targets;
}

async function loadPacketEnrichmentModule() {
	return import("./packet-enrichment.js");
}

type InjectedMemoryRecordsByUnitId = Record<
	string,
	readonly InjectedMemoryRecordLike[]
>;

function persistInjectedMemoriesForTargets(
	storagePort: StructuredMemoryStoragePortLike | undefined,
	targets: Iterable<{ unitId: string; runId?: string }>,
	injectedMemoriesByUnitId: InjectedMemoryRecordsByUnitId,
	preferredRunId?: string,
): readonly PersistedInjectedMemoryRecordLike[] {
	let persisted: readonly PersistedInjectedMemoryRecordLike[] = [];
	const seen = new Set<string>();
	for (const target of targets) {
		const runId = target.runId;
		const records = injectedMemoriesByUnitId[target.unitId];
		if (!runId || runId === "unknown" || !records || records.length === 0) {
			continue;
		}
		if (seen.has(runId)) {
			continue;
		}
		seen.add(runId);
		const current = persistInjectedMemories(storagePort, runId, records);
		if (runId === preferredRunId && current.length > 0) {
			persisted = current;
			continue;
		}
		if (persisted.length === 0 && current.length > 0) {
			persisted = current;
		}
		if (!preferredRunId && current.length > 0) {
			persisted = current;
		}
	}
	return persisted;
}

function recordStrategyIdForTargets(
	storagePort: StructuredMemoryStoragePortLike | undefined,
	targets: Iterable<{ unitId: string; runId?: string }>,
	strategyId: string,
): void {
	if (!storagePort) {
		return;
	}
	const seen = new Set<string>();
	for (const target of targets) {
		const runId = target.runId;
		if (!runId || runId === "unknown" || seen.has(runId)) {
			continue;
		}
		seen.add(runId);
		storagePort.recordRunStrategyId(runId, strategyId);
	}
}

function formatTopLevelHelp(): string[] {
	return [
		BUILDPLANE_BANNER,
		"",
		"  Execute:",
		"    run --packet <path>    Run with implement-then-review (default)",
		"    demo [--model]         Prove the flywheel in 30 seconds",
		"",
		"  Observe:",
		"    status [--json]        Project health snapshot",
		"    history [--json]       List all runs",
		"    inspect <id> [--json]  Deep-dive into a run",
		"    replay <id> [--json]   Re-run with different settings",
		"",
		"  Advanced:",
		"    run-graph --graph <p>  Execute a DAG of tasks",
		"    run-strategy --strat   Run a custom multi-role strategy",
		"",
		"  Project:",
		"    init                   Initialize .buildplane in this repo",
		"    bootstrap doctor      Check published CLI prerequisites",
		"    workspace list         Show actionable retained/cleanup-failed workspaces",
		"    workspace cleanup <r>  Delete an actionable workspace by run id",
		"    workflow scan [--json] Preview recognized Claude/Codex workflow files",
		"    memory list            Show stored learnings",
		"    memory inspect <id>    Detail for one learning",
		"    memory <action>        Advanced memory operations (native)",
		"    pack show <id>         Inspect a pack",
		"",
		"  buildplane run --help    Show run options (--raw, --tui)",
	];
}

function formatRunHelp(): string[] {
	return [
		"buildplane run --packet <path> [options]",
		"",
		"  By default, runs implement-then-review: an implementer executes the task,",
		"  then a reviewer verifies the output. This is what makes Buildplane runs",
		"  self-correcting.",
		"",
		"  Options:",
		"    --raw            Single-shot execution (no review loop)",
		"    --tui            Interactive terminal UI",
		"    --json           Machine-readable output",
	];
}

interface BuildplaneCliOrchestrator {
	initializeProject(): {
		created: boolean;
		projectRoot: string;
		stateDbPath: string;
	};
	runPacket(
		packet: unknown,
		eventBus?: unknown,
	): {
		run: { id: string; status: string };
		receipt: unknown;
		decision: unknown;
	};
	runPacketAsync(
		packet: unknown,
		eventBus?: unknown,
	): Promise<{
		run: { id: string; status: string };
		receipt: unknown;
		decision: unknown;
	}>;
	runGraphAsync(
		graph: unknown,
		eventBus?: unknown,
	): Promise<{
		outcome: "passed" | "failed";
		nodes: Array<{ unitId: string; status: string; runId?: string }>;
	}>;
	runStrategy(
		strategy: unknown,
		eventBus?: unknown,
	): Promise<{
		strategyId: string;
		mode: string;
		outcome: "passed" | "failed" | "mixed";
		childResults: Map<string, { run: { id: string; status: string } }>;
		rounds?: ReadonlyArray<
			Map<string, { run: { id: string; status: string } }>
		>;
		mergeDecision: { policy: string; outcome: string; reasons: string[] };
		winnerRunId?: string;
	}>;
	getStatus(): { initialized: boolean } & Record<string, unknown>;
	inspect(
		id: string,
	): { kind: string; run: { id: string } } & Record<string, unknown>;
}

interface HonchoPortLike {
	createSubscriber(sessionId: string, userId: string): (event: unknown) => void;
	fetchContext(userId: string): Promise<{ memories: string[] }>;
}

interface MemoryPortLike {
	fetchLearnings(options?: {
		scope?: string;
		kind?: string;
		limit?: number;
	}): ReadonlyArray<{
		id: string;
		runId: string;
		scope: string;
		kind: string;
		title: string;
		body: string;
		status: string;
		createdAt: string;
		seenCount: number;
	}>;
	fetchLearningById(id: string):
		| {
				id: string;
				runId: string;
				scope: string;
				kind: string;
				title: string;
				body: string;
				status: string;
				createdAt: string;
				seenCount: number;
		  }
		| undefined;
	fetchLearningsByRunId(runId: string): ReadonlyArray<{
		id: string;
		runId: string;
		scope: string;
		kind: string;
		title: string;
		body: string;
		status: string;
		createdAt: string;
		seenCount: number;
	}>;
}

interface CliOrchestratorBundle {
	orchestrator: BuildplaneCliOrchestrator;
	eventBus: {
		subscribe: (listener: (event: unknown) => void) => () => void;
		emit: (event: unknown) => void;
	};
	eventStore: {
		persistEvent: (runId: string, event: unknown) => void;
	};
	memoryPort?: MemoryPortLike;
	structuredMemoryPort?: StructuredMemoryStoragePortLike;
	honchoAdapter?: HonchoPortLike;
	userId?: string;
	currentBranch?: string;
	/** Mutable slot — swapped per-run to route through the ledger-wrapped ToolRegistry. */
	commandExecutor: {
		executePacket: (packet: unknown, root: string) => unknown;
	};
}

async function loadCliOrchestrator(
	projectRoot: string,
): Promise<CliOrchestratorBundle> {
	const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
		createBuildplaneOrchestrator: (options: {
			projectRoot: string;
			storage: unknown;
			runtime: {
				executePacket: (packet: unknown, root: string) => unknown;
				executePacketAsync?: (
					packet: unknown,
					root: string,
					eventBus: unknown,
				) => Promise<unknown>;
			};
			policy: { evaluateRun: (packet: unknown, receipt: unknown) => unknown };
			workspace?: unknown;
			eventBus?: unknown;
			memoryPort?: unknown;
		}) => BuildplaneCliOrchestrator;
		createEventBus: () => {
			subscribe: (listener: (event: unknown) => void) => () => void;
			emit: (event: unknown) => void;
		};
		parseUnitPacket: (input: string) => unknown;
	};
	const runtime = (await cliImport("@buildplane/runtime")) as unknown as {
		executePacket: (packet: unknown, root: string) => unknown;
	};
	const policy = (await cliImport("@buildplane/policy")) as unknown as {
		evaluateRun: (packet: unknown, receipt: unknown) => unknown;
	};
	const storage = (await cliImport("@buildplane/storage")) as unknown as {
		createBuildplaneStorage: (root: string) => unknown;
		createEventStore: (root: string) => {
			persistEvent: (runId: string, event: unknown) => void;
		};
	};

	// Create event bus with storage persistence subscriber
	const eventBus = kernel.createEventBus();
	const eventStore = storage.createEventStore(projectRoot);

	// Wire up event persistence — every event emitted by the orchestrator
	// gets persisted to storage for later inspection and replay
	eventBus.subscribe((event: unknown) => {
		const e = event as { runId?: string };
		if (e.runId) {
			try {
				eventStore.persistEvent(e.runId, event as never);
			} catch {
				// Don't let storage failures break the run
			}
		}
	});

	// ── Optional Honcho memory integration ─────────────────────
	// Activated when HONCHO_API_KEY is set in the environment.
	// The adapter owns the SDK import — the CLI never touches @honcho-ai/sdk directly.

	let honchoAdapterRef: HonchoPortLike | undefined;
	let userIdRef: string | undefined;

	if (process.env.HONCHO_API_KEY) {
		try {
			const honchoModule = (await cliImport(
				"@buildplane/adapters-honcho",
			)) as unknown as {
				createHonchoAdapter: (options: {
					client: unknown;
					userId: string;
				}) => HonchoPortLike;
				createHonchoClient: (options: {
					workspaceId?: string;
					apiKey: string;
				}) => Promise<unknown>;
			};
			const { createHonchoAdapter, createHonchoClient } = honchoModule;

			const honchoClient = await createHonchoClient({
				workspaceId: process.env.HONCHO_WORKSPACE_ID,
				apiKey: process.env.HONCHO_API_KEY,
			});

			const userId = process.env.BUILDPLANE_USER_ID ?? "operator";
			const adapter = createHonchoAdapter({
				client: honchoClient as never,
				userId,
			});

			// Subscribe to the event bus for message storage
			const honchoSubscriber = adapter.createSubscriber("default", userId);
			eventBus.subscribe(honchoSubscriber as never);

			honchoAdapterRef = adapter as unknown as HonchoPortLike;
			userIdRef = userId;
		} catch (err) {
			// Warn when explicitly configured but broken — silence when SDK simply absent
			console.warn(
				`[buildplane] Honcho memory disabled: ${err instanceof Error ? err.message : "unknown error"}`,
			);
		}
	}

	// ── Optional local memory port ──────────────────────────────
	// Reads from the project's run_learnings table (state.db) if initialized.
	// Only opened if state.db exists — never creates the file.
	// Two separate connections: read-only for CLI enrichment (pre-run fetch),
	// read-write for orchestrator post-run writes.

	let memoryPortRef: MemoryPortLike | undefined;
	let orchestratorMemoryPortRef: MemoryPortLike | undefined;
	let structuredMemoryPortRef: StructuredMemoryStoragePortLike | undefined;
	let currentBranchRef: string | undefined;
	try {
		const {
			resolveProjectLayout,
			createLearningStore,
			createBuildplaneStorage,
		} = (await import("@buildplane/storage")) as unknown as {
			resolveProjectLayout: (root: string) => { stateDbPath: string };
			createLearningStore: (db: unknown) => MemoryPortLike;
			createBuildplaneStorage: (
				root: string,
			) => StructuredMemoryStoragePortLike;
		};
		const { DatabaseSync } = await import("node:sqlite");
		const layout = resolveProjectLayout(projectRoot);
		if (existsSync(layout.stateDbPath)) {
			// Read-only connection for CLI enrichment (pre-run fetch)
			const readDb = new DatabaseSync(layout.stateDbPath, { readOnly: true });
			memoryPortRef = createLearningStore(readDb);
			structuredMemoryPortRef = createBuildplaneStorage(projectRoot);
			currentBranchRef = resolveCurrentBranch(projectRoot);
			// Read-write connection for orchestrator post-run writes
			const writeDb = new DatabaseSync(layout.stateDbPath);
			orchestratorMemoryPortRef = createLearningStore(writeDb);
		}
	} catch {
		// Memory ports unavailable — run without them
	}

	// Runtime router: selects executor based on packet type and routing hints
	const adaptersGit = (await cliImport(
		"@buildplane/adapters-git",
	)) as unknown as {
		createGitWorktreeAdapter: () => unknown;
	};

	const commandExecutor = { executePacket: runtime.executePacket };
	let adaptersModelsPromise:
		| Promise<{
				createModelExecutor: () => {
					executePacket: (packet: unknown, root: string) => unknown;
					executePacketAsync: (
						packet: unknown,
						root: string,
						eventBus: unknown,
					) => Promise<unknown>;
				};
				createClaudeCodeExecutor: () => {
					executePacket: (packet: unknown, root: string) => unknown;
					executePacketAsync: (
						packet: unknown,
						root: string,
						eventBus: unknown,
					) => Promise<unknown>;
				};
		  }>
		| undefined;
	let adaptersCodexPromise:
		| Promise<{
				createCodexExecutor: () => {
					executePacket: (packet: unknown, root: string) => unknown;
					executePacketAsync: (
						packet: unknown,
						root: string,
						eventBus: unknown,
					) => Promise<unknown>;
				};
		  }>
		| undefined;
	let sdkExecutorPromise:
		| Promise<{
				executePacket: (packet: unknown, root: string) => unknown;
				executePacketAsync: (
					packet: unknown,
					root: string,
					eventBus: unknown,
				) => Promise<unknown>;
		  }>
		| undefined;
	let claudeExecutorPromise:
		| Promise<{
				executePacket: (packet: unknown, root: string) => unknown;
				executePacketAsync: (
					packet: unknown,
					root: string,
					eventBus: unknown,
				) => Promise<unknown>;
		  }>
		| undefined;
	let codexExecutorPromise:
		| Promise<{
				executePacket: (packet: unknown, root: string) => unknown;
				executePacketAsync: (
					packet: unknown,
					root: string,
					eventBus: unknown,
				) => Promise<unknown>;
		  }>
		| undefined;

	const loadAdaptersModels = () => {
		if (!adaptersModelsPromise) {
			adaptersModelsPromise = cliImport(
				"@buildplane/adapters-models",
			) as Promise<{
				createModelExecutor: () => {
					executePacket: (packet: unknown, root: string) => unknown;
					executePacketAsync: (
						packet: unknown,
						root: string,
						eventBus: unknown,
					) => Promise<unknown>;
				};
				createClaudeCodeExecutor: () => {
					executePacket: (packet: unknown, root: string) => unknown;
					executePacketAsync: (
						packet: unknown,
						root: string,
						eventBus: unknown,
					) => Promise<unknown>;
				};
			}>;
		}
		return adaptersModelsPromise;
	};

	const loadAdaptersCodex = () => {
		if (!adaptersCodexPromise) {
			adaptersCodexPromise = cliImport(
				"@buildplane/adapters-codex",
			) as Promise<{
				createCodexExecutor: () => {
					executePacket: (packet: unknown, root: string) => unknown;
					executePacketAsync: (
						packet: unknown,
						root: string,
						eventBus: unknown,
					) => Promise<unknown>;
				};
			}>;
		}
		return adaptersCodexPromise;
	};

	const getSdkExecutor = async () => {
		if (!sdkExecutorPromise) {
			sdkExecutorPromise = loadAdaptersModels().then((mod) =>
				mod.createModelExecutor(),
			);
		}
		return sdkExecutorPromise;
	};

	const getClaudeExecutor = async () => {
		if (!claudeExecutorPromise) {
			claudeExecutorPromise = loadAdaptersModels().then((mod) =>
				mod.createClaudeCodeExecutor(),
			);
		}
		return claudeExecutorPromise;
	};

	const getCodexExecutor = async () => {
		if (!codexExecutorPromise) {
			codexExecutorPromise = loadAdaptersCodex().then((mod) =>
				mod.createCodexExecutor(),
			);
		}
		return codexExecutorPromise;
	};

	const runtimeRouter = {
		executePacket(packet: unknown, root: string) {
			const p = packet as { execution?: unknown };
			if (p.execution) return commandExecutor.executePacket(packet, root);
			throw new Error("Model packets require async execution path");
		},
		async executePacketAsync(packet: unknown, root: string, bus: unknown) {
			const p = packet as {
				execution?: unknown;
				routingHints?: { preferredWorker?: string };
			};
			if (p.execution) return commandExecutor.executePacket(packet, root);
			if (p.routingHints?.preferredWorker === "claude-code") {
				return (await getClaudeExecutor()).executePacketAsync(
					packet,
					root,
					bus,
				);
			}
			if (p.routingHints?.preferredWorker === "codex") {
				return (await getCodexExecutor()).executePacketAsync(packet, root, bus);
			}
			return (await getSdkExecutor()).executePacketAsync(packet, root, bus);
		},
	};

	const orchestrator = kernel.createBuildplaneOrchestrator({
		projectRoot,
		storage: storage.createBuildplaneStorage(projectRoot),
		runtime: runtimeRouter,
		policy: { evaluateRun: policy.evaluateRun },
		workspace: adaptersGit.createGitWorktreeAdapter(),
		eventBus,
		memoryPort: orchestratorMemoryPortRef, // READ-WRITE port for post-run writes
	});

	return {
		orchestrator,
		eventBus,
		eventStore,
		memoryPort: memoryPortRef,
		structuredMemoryPort: structuredMemoryPortRef,
		honchoAdapter: honchoAdapterRef,
		userId: userIdRef,
		currentBranch: currentBranchRef,
		commandExecutor,
	};
}

async function loadEventStore(projectRoot: string): Promise<{
	getEventsByRunId: (runId: string) => unknown[];
}> {
	const storage = (await cliImport("@buildplane/storage")) as unknown as {
		createEventStore: (root: string) => {
			getEventsByRunId: (runId: string) => unknown[];
		};
	};
	return storage.createEventStore(projectRoot);
}

async function loadRunHistory(projectRoot: string): Promise<unknown[]> {
	const storage = (await cliImport("@buildplane/storage")) as unknown as {
		createBuildplaneStorage: (root: string) => {
			getRunHistory: () => unknown[];
		};
	};
	return storage.createBuildplaneStorage(projectRoot).getRunHistory();
}

async function loadReadOnlyMemoryPort(
	projectRoot: string,
): Promise<MemoryPortLike | undefined> {
	try {
		const { resolveProjectLayout, createLearningStore } = (await import(
			"@buildplane/storage"
		)) as unknown as {
			resolveProjectLayout: (root: string) => { stateDbPath: string };
			createLearningStore: (db: unknown) => MemoryPortLike;
		};
		const { DatabaseSync } = await import("node:sqlite");
		const layout = resolveProjectLayout(projectRoot);
		if (existsSync(layout.stateDbPath)) {
			const readDb = new DatabaseSync(layout.stateDbPath, { readOnly: true });
			return createLearningStore(readDb);
		}
	} catch {
		// Memory port unavailable
	}
	return undefined;
}

async function loadPacket(packetPath: string): Promise<unknown> {
	const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
		parseUnitPacket: (input: string) => unknown;
	};

	return kernel.parseUnitPacket(readFileSync(packetPath, "utf8"));
}

const NATIVE_COMMAND_DISPATCH_ERROR_CODE = "NATIVE_COMMAND_DISPATCH_FAILED";
const NATIVE_COMMAND_DISPATCH_HINT =
	"Hint: build the native binary with `cargo build --manifest-path native/Cargo.toml -p bp-cli`, or set BUILDPLANE_NATIVE_BIN, or ensure `buildplane-native` is on PATH.";

class NativeCommandDispatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NativeCommandDispatchError";
	}
}

function formatNativeCommandPath(commandPath: string[]): string {
	return commandPath.join(" ");
}

function createNativeDispatchError(
	commandPath: string[],
	error: unknown,
): NativeCommandDispatchError {
	const detail =
		error instanceof Error && error.message.length > 0
			? error.message
			: undefined;
	const message = [
		`Failed to dispatch to the native ${formatNativeCommandPath(commandPath)} command runner.`,
		detail,
		NATIVE_COMMAND_DISPATCH_HINT,
	]
		.filter((value): value is string => Boolean(value))
		.join(" ");
	return new NativeCommandDispatchError(message);
}

function classifyLocalLearningInspect(
	args: string[],
): { json: boolean; id?: string } | null {
	const unsupportedFlags = args.filter(
		(value) => value.startsWith("--") && value !== "--json",
	);
	if (unsupportedFlags.length > 0) {
		return null;
	}
	const positionalArgs = args.filter((value) => !value.startsWith("--"));
	if (positionalArgs.length === 0 || positionalArgs.length > 1) {
		return null;
	}
	return {
		json: args.includes("--json"),
		id: positionalArgs[0],
	};
}

function splitOutputLines(output: string): string[] {
	return output
		.split(/\r?\n/u)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

function resolveNativeBinary(cwd: string): string {
	const explicit = process.env.BUILDPLANE_NATIVE_BIN;
	if (explicit) {
		return explicit;
	}

	const candidates = [
		resolve(cwd, "native", "target", "debug", "buildplane-native"),
		resolve(cwd, "native", "target", "release", "buildplane-native"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return "buildplane-native";
}

function resolveLedgerBinary(cwd: string): string {
	// The ledger binary is the same `buildplane-native` — just invoke with a
	// different subcommand. Reuse the existing resolution chain.
	return resolveNativeBinary(cwd);
}

// ---------------------------------------------------------------------------
// buildplane fork — Phase E Task 5
// ---------------------------------------------------------------------------

interface ForkPlan {
	new_run_id: string;
	workspace_path: string;
	checkout_sha: string;
	packet_json: unknown;
	parent_run_id: string;
	parent_event_id: string;
}

interface ForkArgs {
	runId: string;
	at: string;
	workspace?: string;
	packet: string;
}

function parseForkArgs(
	rest: string[],
): { ok: true; value: ForkArgs } | { ok: false; error: string } {
	let runId: string | undefined;
	let at: string | undefined;
	let workspace: string | undefined;
	let packet: string | undefined;
	let i = 0;
	while (i < rest.length) {
		const arg = rest[i];
		switch (arg) {
			case "--run-id":
				i += 1;
				runId = rest[i];
				break;
			case "--at":
				i += 1;
				at = rest[i];
				break;
			case "--workspace":
				i += 1;
				workspace = rest[i];
				break;
			case "--packet":
				i += 1;
				packet = rest[i];
				break;
			default:
				if (arg && !runId) {
					runId = arg;
				} else {
					return { ok: false, error: `unknown argument: ${arg}` };
				}
		}
		i += 1;
	}
	if (!runId)
		return {
			ok: false,
			error: "missing parent run id (positional or --run-id)",
		};
	if (!at) return { ok: false, error: "missing --at <event-id>" };
	if (!packet) return { ok: false, error: "missing --packet <file>" };
	return { ok: true, value: { runId, at, workspace, packet } };
}

function forkUsageText(): string {
	return `usage: buildplane fork <parent-run-id> --at <event-id> --packet <file> [--workspace <path>]

  --run-id       parent run id (or positional first arg)
  --at           parent unit_started event id to fork at
  --packet       path to the new packet json
  --workspace    workspace root (defaults to cwd)
`;
}

async function runForkExecution(
	plan: ForkPlan,
	workspace: string,
	opts: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
	// Phase E Task 6: real ledger spawn + orchestrator invocation.
	//
	// NOTE: This duplicates the ledger-integration block from the `run` command
	// handler rather than extracting a shared helper, because that block is
	// tightly coupled to the `case "run"` closure locals (enrichedPacket,
	// cliEventBus, commandExecutor, etc.). A full extraction is tracked for
	// Phase F consolidation.
	const binary = resolveLedgerBinary(workspace);
	const ledgerChild = spawnLedgerSubprocess(binary, plan.new_run_id, workspace);

	let emitter: TapeEmitter;
	try {
		emitter = await createTapeEmitter({
			childStdin: ledgerChild.stdin,
			childStderr: ledgerChild.stderr,
			childExit: ledgerChild.exit,
			workspacePath: workspace,
			runId: plan.new_run_id,
		});
	} catch (err) {
		// Handshake failed — kill child and surface the error.
		if (ledgerChild.child.exitCode === null) {
			ledgerChild.child.kill("SIGTERM");
		}
		opts.stderr(`fork ledger handshake failed: ${String(err)}\n`);
		return 1;
	}

	// Load a fresh orchestrator bundle scoped to the fork workspace.
	const bundle = await loadCliOrchestrator(workspace);
	const {
		orchestrator: forkOrchestrator,
		eventBus: forkEventBus,
		commandExecutor: forkCommandExecutor,
	} = bundle;

	// Unit-context tracker for tool-event wiring.
	let forkCurrentUnit: { unitId: string; parentEventId: string } | null = null;
	const getForkUnitCtx = () => forkCurrentUnit;

	// Wire bus subscription for unit-boundary events (mirrors run command handler).
	const workspacePath = resolve(workspace);
	const unsubscribeFork = forkEventBus.subscribe((evt: unknown) => {
		const e = evt as { kind?: string; unitId?: string; exitCode?: number };
		switch (e.kind) {
			case "execution-started": {
				const unitId = e.unitId ?? "unknown";
				const unitStartedId = generateUuidV7();
				emitter.emit(
					"unit_started",
					{
						UnitStartedV1: {
							unit_id: unitId,
							parent_unit_id: null,
							unit_kind: "command",
							policy: {},
						},
					},
					{ id: unitStartedId },
				);
				forkCurrentUnit = { unitId, parentEventId: unitStartedId };
				runGitCheckpoint({
					boundary: "pre-unit",
					runId: plan.new_run_id,
					unitId,
					cwd: workspacePath,
					emitter,
					parentEventId: unitStartedId,
				});
				break;
			}
			case "command-execution-complete": {
				if (forkCurrentUnit) {
					runGitCheckpoint({
						boundary: "post-unit",
						runId: plan.new_run_id,
						unitId: forkCurrentUnit.unitId,
						cwd: workspacePath,
						emitter,
						parentEventId: forkCurrentUnit.parentEventId,
					});
					const outcome = e.exitCode === 0 ? "passed" : "failed";
					emitter.emit(
						"unit_completed",
						{
							UnitCompletedV1: {
								unit_id: forkCurrentUnit.unitId,
								outcome,
								artifacts: [],
							},
						},
						{ parent: forkCurrentUnit.parentEventId },
					);
					forkCurrentUnit = null;
				}
				break;
			}
			default:
				break;
		}
	});

	// Wrap the commandExecutor so tool calls are instrumented through the ledger.
	const { existsSync: fsExistsSync, realpathSync: fsRealpathSync } =
		await import("node:fs");
	const { resolve: pathResolve } = await import("node:path");
	const originalForkExecutePacket = forkCommandExecutor.executePacket;
	forkCommandExecutor.executePacket = (
		packetUnknown: unknown,
		executionRoot: string,
	): unknown => {
		const p = packetUnknown as {
			execution: { command: string; args?: readonly string[]; cwd?: string };
			verification: { requiredOutputs: readonly string[] };
		};
		const worktreeRoot = pathResolve(executionRoot);
		const perCallRawRegistry = createToolRegistry(worktreeRoot);
		const perCallRegistry = wrapToolRegistryForLedger(
			perCallRawRegistry,
			emitter,
			getForkUnitCtx,
		);
		const effectiveCwd = p.execution.cwd
			? pathResolve(worktreeRoot, p.execution.cwd)
			: worktreeRoot;
		const startedAt = new Date().toISOString();
		const result = perCallRegistry.run_command({
			command: p.execution.command,
			args: p.execution.args,
			cwd: p.execution.cwd,
		});
		const completedAt = new Date().toISOString();
		return {
			command: p.execution.command,
			args: [...(p.execution.args ?? [])],
			cwd: effectiveCwd,
			startedAt,
			completedAt,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			outputChecks: p.verification.requiredOutputs.map((outputPath: string) => {
				const realRoot = (() => {
					try {
						return fsRealpathSync(worktreeRoot);
					} catch {
						return worktreeRoot;
					}
				})();
				return {
					path: outputPath,
					exists: fsExistsSync(pathResolve(realRoot, outputPath)),
				};
			}),
		};
	};

	const packetHash = `sha256:${createHash("sha256")
		.update(JSON.stringify(plan.packet_json))
		.digest("hex")}`;
	const runStartMs = Date.now();

	let exitCode = 1;
	try {
		// Emit run_started with parent_run_id for fork lineage.
		emitter.emit("run_started", {
			RunStartedV1: {
				packet_hash: packetHash,
				git_head: plan.checkout_sha,
				workspace_path: workspace,
				config: {},
				parent_run_id: plan.parent_run_id,
			},
		});

		// Invoke the orchestrator with the fork packet.
		const orchResult = forkOrchestrator.runPacket(
			plan.packet_json as never,
			forkEventBus,
		);
		const status = (orchResult as { run?: { status?: string } }).run?.status;
		exitCode = status === "passed" ? 0 : 1;

		// Emit run_completed.
		emitter.emit("run_completed", {
			RunCompletedV1: {
				outcome: exitCode === 0 ? "passed" : "failed",
				duration_ms: Date.now() - runStartMs,
				event_count: 0,
				unit_count: 1,
			},
		});
	} catch (err) {
		opts.stderr(`fork orchestrator error: ${String(err)}\n`);
		exitCode = 1;
	} finally {
		unsubscribeFork();
		forkCommandExecutor.executePacket = originalForkExecutePacket;
		try {
			await emitter.close();
		} catch {
			// Best-effort close; the orchestrator result is authoritative.
		}
	}

	opts.stdout(`fork run completed: ${plan.new_run_id} (exit ${exitCode})\n`);
	return exitCode;
}

async function runFork(
	rest: string[],
	opts: {
		cwd: string;
		stdout: (s: string) => void;
		stderr: (s: string) => void;
	},
): Promise<number> {
	const args = parseForkArgs(rest);
	if (!args.ok) {
		opts.stderr(`buildplane fork: ${args.error}\n`);
		opts.stderr(forkUsageText());
		return 1;
	}

	const workspace = resolve(args.value.workspace ?? opts.cwd);
	const binary = resolveLedgerBinary(opts.cwd);

	// Phase 1: plan.
	// NOTE: spawnSync for `fork plan` must run from the project root (not from the
	// workspace temp dir) so that the native binary can resolve its native workspace
	// (Cargo.toml + packs/) via ancestor-walk. Use the same deriveLedgerSpawnCwd
	// logic that spawnLedgerSubprocess uses.
	const planSpawnCwd = deriveLedgerSpawnCwd(binary, opts.cwd);
	const planArgs = [
		"fork",
		"plan",
		"--run-id",
		args.value.runId,
		"--at",
		args.value.at,
		"--workspace",
		workspace,
		"--packet",
		args.value.packet,
	];
	const planResult = spawnSync(binary, planArgs, {
		encoding: "utf8",
		cwd: planSpawnCwd,
	});
	if (planResult.status !== 0) {
		opts.stderr(planResult.stderr ?? `fork plan failed\n`);
		return planResult.status ?? 1;
	}
	let plan: ForkPlan;
	try {
		plan = JSON.parse(planResult.stdout.trim()) as ForkPlan;
	} catch (e) {
		opts.stderr(`fork plan returned invalid JSON: ${String(e)}\n`);
		return 1;
	}

	// Phase 2: clean-worktree pre-flight.
	// Filter out SQLite WAL companion files (*.db-shm, *.db-wal) — these are
	// created transiently when fork plan opens events.db for replay and do not
	// represent user changes. Everything else must be committed.
	const statusResult = spawnSync(
		"git",
		["-C", workspace, "status", "--porcelain"],
		{ encoding: "utf8" },
	);
	if (statusResult.status !== 0) {
		opts.stderr(`git status in ${workspace} failed: ${statusResult.stderr}\n`);
		return 1;
	}
	const dirtyLines = statusResult.stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.filter((line) => !line.match(/\.db-shm$|\.db-wal$/u));
	if (dirtyLines.length > 0) {
		opts.stderr(
			`workspace has uncommitted changes; commit or stash before forking\n`,
		);
		return 1;
	}

	// Phase 3: checkout the pre-unit SHA.
	const checkoutResult = spawnSync(
		"git",
		["-C", workspace, "checkout", plan.checkout_sha],
		{ encoding: "utf8" },
	);
	if (checkoutResult.status !== 0) {
		opts.stderr(
			`git checkout ${plan.checkout_sha} failed: ${checkoutResult.stderr}\n`,
		);
		return 1;
	}

	// Phase 4: stub execution for Task 5. Task 6 replaces this with a real
	// ledger spawn + orchestrator invocation.
	const exitCode = await runForkExecution(plan, workspace, opts);

	// Phase 5: exit hint.
	const currentBranchResult = spawnSync(
		"git",
		["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"],
		{ encoding: "utf8" },
	);
	const currentBranch = currentBranchResult.stdout.trim();
	opts.stdout(
		`\nHEAD is at fork tree ${plan.checkout_sha.slice(0, 8)}; ` +
			`run \`git checkout <branch>\` to restore.\n`,
	);
	if (currentBranch === "HEAD") {
		opts.stdout(`(detached HEAD)\n`);
	}

	return exitCode;
}

interface LedgerChild {
	child: ChildProcess;
	stdin: Writable;
	stderr: Readable;
	exit: Promise<number>;
}

/**
 * Derive a suitable cwd for the ledger subprocess so the native binary can
 * resolve its default native-root. The binary looks for `native/Cargo.toml`
 * and `native/packs` relative to its cwd.
 *
 * Resolution order:
 *  1. If the binary lives inside a `.../native/target/{debug,release}/` tree,
 *     the project root is 4 directories up — use that.
 *  2. Otherwise fall back to `workspace` (the user's project root).  In a
 *     production install the binary is on PATH and the workspace itself may
 *     not have a native subtree; the binary is expected to degrade gracefully
 *     in that configuration.
 */
function deriveLedgerSpawnCwd(binary: string, workspace: string): string {
	// Walk up: debug/release → target → native → <project-root>
	const parts = binary.replace(/\\/g, "/").split("/");
	const nativeIdx = parts.lastIndexOf("native");
	if (
		nativeIdx >= 0 &&
		parts[nativeIdx + 1] === "target" &&
		(parts[nativeIdx + 2] === "debug" || parts[nativeIdx + 2] === "release")
	) {
		return parts.slice(0, nativeIdx).join("/") || workspace;
	}
	return workspace;
}

function spawnLedgerSubprocess(
	binary: string,
	runId: string,
	workspace: string,
): LedgerChild {
	const spawnCwd = deriveLedgerSpawnCwd(binary, workspace);
	const child = spawn(
		binary,
		[
			"ledger",
			"serve",
			"--run-id",
			runId,
			"--workspace",
			workspace,
			"--schema-version",
			"1",
		],
		{
			stdio: ["pipe", "inherit", "pipe"],
			cwd: spawnCwd,
		},
	);
	if (!child.stdin || !child.stderr) {
		throw new Error("ledger subprocess stdio unexpectedly missing");
	}
	const exit = new Promise<number>((resolve, reject) => {
		child.on("exit", (code) => resolve(code ?? -1));
		// Handle spawn errors (e.g. binary not found) so they surface as a
		// rejected promise rather than an unhandled 'error' event.
		child.on("error", (err) => reject(err));
	});
	// Suppress unhandled-rejection noise for consumers that only attach .then()
	// (e.g. createTapeEmitter adds .then but no .catch on childExit).
	exit.catch(() => {});
	return {
		child,
		stdin: child.stdin as Writable,
		stderr: child.stderr as Readable,
		exit,
	};
}

async function runNativeCommand(
	argv: string[],
	options: {
		cwd: string;
		commandPath: string[];
		stdout: (line: string) => void;
		stderr: (line: string) => void;
	},
): Promise<number> {
	const binary = resolveNativeBinary(options.cwd);
	const result = spawnSync(binary, [...options.commandPath, ...argv], {
		cwd: options.cwd,
		encoding: "utf8",
		env: process.env,
	});

	for (const line of splitOutputLines(result.stdout ?? "")) {
		options.stdout(line);
	}
	for (const line of splitOutputLines(result.stderr ?? "")) {
		options.stderr(line);
	}

	if (result.error) {
		const detail =
			result.error instanceof Error
				? result.error.message
				: String(result.error);
		throw new Error(
			`Resolved native binary '${binary}' for '${formatNativeCommandPath(options.commandPath)}' but could not start it. ${detail}`,
		);
	}
	return result.status ?? 1;
}

export async function runCli(
	argv: string[],
	options: RunCliOptions = {},
): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const stdout = options.stdout ?? ((line: string) => console.log(line));
	const stderr = options.stderr ?? ((line: string) => console.error(line));
	const deps = options.dependencies;
	const [command, ...rest] = argv;

	if (
		!command ||
		command === "help" ||
		command === "--help" ||
		command === "-h"
	) {
		for (const line of formatTopLevelHelp()) {
			stdout(line);
		}
		return 0;
	}

	try {
		if (command === "bootstrap") {
			const subcommand = rest[0];
			const doctorArgs = rest.slice(1);
			const json = doctorArgs.includes("--json");
			if (subcommand === "doctor") {
				const hasOnlySupportedDoctorArgs =
					doctorArgs.length === 0 ||
					(doctorArgs.length === 1 && doctorArgs[0] === "--json");
				if (!hasOnlySupportedDoctorArgs) {
					throw new Error(
						`Unsupported bootstrap doctor arguments: ${doctorArgs.join(" ")}`,
					);
				}
				const report =
					deps?.inspectBootstrapDoctor?.() ?? inspectBootstrapDoctor();
				if (json) {
					stdout(formatJson(report));
				} else {
					for (const line of formatBootstrapDoctorReport(report)) {
						stdout(line);
					}
				}
				return report.ok ? 0 : 1;
			}
			throw new Error(
				`Unknown bootstrap command: ${subcommand ?? "(missing subcommand)"}`,
			);
		}

		if (command === "memory") {
			const subcommand = rest[0];
			if (subcommand === "list") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const scopeIdx = subRest.indexOf("--scope");
				const scope =
					scopeIdx >= 0 && scopeIdx + 1 < subRest.length
						? subRest[scopeIdx + 1]
						: undefined;
				const kindIdx = subRest.indexOf("--kind");
				const kind =
					kindIdx >= 0 && kindIdx + 1 < subRest.length
						? subRest[kindIdx + 1]
						: undefined;
				let learnings: ReturnType<MemoryPortLike["fetchLearnings"]> = [];
				try {
					const memoryPort = await loadReadOnlyMemoryPort(cwd);
					if (memoryPort) {
						learnings = memoryPort.fetchLearnings({
							scope: scope as string | undefined,
							kind: kind as string | undefined,
						});
					}
				} catch {
					// Database may lack run_learnings table (pre-cold-path project)
				}
				if (json) {
					stdout(formatJson(learnings));
				} else {
					for (const line of formatLearningsList(learnings)) {
						stdout(line);
					}
				}
				return 0;
			}
			if (subcommand === "inspect") {
				const subRest = rest.slice(1);
				const localInspect = classifyLocalLearningInspect(subRest);
				if (!localInspect) {
					try {
						return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
							cwd,
							commandPath: ["memory"],
							stdout,
							stderr,
						});
					} catch (error) {
						throw createNativeDispatchError(["memory"], error);
					}
				}
				const { json, id } = localInspect;
				if (!id) {
					const msg = "Missing required learning ID for memory inspect.";
					if (json) {
						stdout(formatJson(formatJsonError("MISSING_ARGUMENT", msg)));
					} else {
						stderr(msg);
					}
					return 1;
				}
				let learning:
					| ReturnType<MemoryPortLike["fetchLearningById"]>
					| undefined;
				try {
					const memoryPort = await loadReadOnlyMemoryPort(cwd);
					if (memoryPort) {
						learning = memoryPort.fetchLearningById(id);
					}
				} catch {
					// Database may lack run_learnings table (pre-cold-path project)
				}
				if (!learning) {
					const msg = `Learning not found: ${id}`;
					if (json) {
						stdout(formatJson(formatJsonError("NOT_FOUND", msg)));
					} else {
						stderr(msg);
					}
					return 1;
				}
				if (json) {
					stdout(formatJson(learning));
				} else {
					for (const line of formatLearningDetail(learning)) {
						stdout(line);
					}
				}
				return 0;
			}
			// Fall through to native for all other memory subcommands
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
					cwd,
					commandPath: ["memory"],
					stdout,
					stderr,
				});
			} catch (error) {
				throw createNativeDispatchError(["memory"], error);
			}
		}

		if (command === "ledger") {
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
					cwd,
					commandPath: ["ledger"],
					stdout,
					stderr,
				});
			} catch (error) {
				throw createNativeDispatchError(["ledger"], error);
			}
		}

		if (command === "fork") {
			return await runFork(rest, { cwd, stdout, stderr });
		}

		if (command === "pack" && rest[0] === "show") {
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(
					rest.slice(1),
					{
						cwd,
						commandPath: ["pack", "show"],
						stdout,
						stderr,
					},
				);
			} catch (error) {
				throw createNativeDispatchError(["pack", "show"], error);
			}
		}

		if (command === "install") {
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
					cwd,
					commandPath: ["install"],
					stdout,
					stderr,
				});
			} catch (error) {
				throw createNativeDispatchError(["install"], error);
			}
		}

		if (command === "uninstall") {
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(rest, {
					cwd,
					commandPath: ["uninstall"],
					stdout,
					stderr,
				});
			} catch (error) {
				throw createNativeDispatchError(["uninstall"], error);
			}
		}

		if (command === "demo") {
			const modelFlag = rest.includes("--model");
			const { runDemo } = await import("./demo.js");
			await runDemo({ model: modelFlag });
			return 0;
		}

		if (command === "workflow") {
			const subcommand = rest[0];
			const json = rest.includes("--json");
			if (subcommand === "scan") {
				const preview = scanWorkflowPreview(cwd);
				if (json) {
					stdout(formatJson(preview));
				} else {
					for (const line of formatWorkflowScanPreview(preview)) {
						stdout(line);
					}
				}
				return 0;
			}

			throw new Error(
				`Unknown workflow command: ${subcommand ?? "(missing subcommand)"}`,
			);
		}

		if (command === "workspace") {
			const subcommand = rest[0];
			const json = rest.includes("--json");
			const storage = (await cliImport("@buildplane/storage")) as unknown as {
				createBuildplaneStorage: (root: string) => {
					getStatusSnapshot: () => {
						actionableWorkspaces?: Array<{
							runId: string;
							status: string;
							path: string;
							headSha?: string;
							cleanupError?: string;
						}>;
					};
					inspectTarget: (id: string) => {
						workspace?: { status?: string; path?: string };
					};
					recordWorkspaceCleanedUp: (runId: string) => void;
				};
			};
			const storageInst = storage.createBuildplaneStorage(cwd);

			if (subcommand === "list") {
				const actionableWorkspaces =
					storageInst.getStatusSnapshot().actionableWorkspaces ?? [];
				if (json) {
					stdout(formatJson(actionableWorkspaces));
				} else {
					for (const line of formatWorkspaceList(actionableWorkspaces)) {
						stdout(line);
					}
				}
				return 0;
			}

			if (subcommand === "cleanup") {
				const runId = rest.find(
					(value) => value !== "cleanup" && value !== "--json",
				);
				if (!runId) {
					const message = "Missing required run id for workspace cleanup.";
					if (json) {
						stdout(formatJson(formatJsonError("MISSING_ARGUMENT", message)));
					} else {
						stderr(message);
					}
					return 1;
				}

				const actionableWorkspaces =
					storageInst.getStatusSnapshot().actionableWorkspaces ?? [];
				const target = actionableWorkspaces.find(
					(workspace) => workspace.runId === runId,
				);
				if (!target) {
					let message = `No workspace found for run '${runId}'.`;
					let code = "NOT_FOUND";
					try {
						const inspect = storageInst.inspectTarget(runId);
						if (inspect.workspace?.status) {
							message = `Workspace for run '${runId}' is not actionable.`;
							code = "WORKSPACE_NOT_ACTIONABLE";
						}
					} catch {
						// Leave as not-found
					}
					if (json) {
						stdout(formatJson(formatJsonError(code, message)));
					} else {
						stderr(message);
					}
					return 1;
				}

				const adaptersGit = (await cliImport(
					"@buildplane/adapters-git",
				)) as unknown as {
					createGitWorktreeAdapter: () => {
						deleteWorkspace: (workspace: {
							path: string;
							projectRoot?: string;
						}) => { deleted: boolean; cleanupError?: string };
					};
				};
				const cleanupResult = adaptersGit
					.createGitWorktreeAdapter()
					.deleteWorkspace({
						path: target.path,
						projectRoot: cwd,
					});
				if (!cleanupResult.deleted) {
					const message =
						cleanupResult.cleanupError ??
						`Workspace cleanup failed for run '${runId}'.`;
					if (json) {
						stdout(formatJson(formatJsonError("CLI_ERROR", message)));
					} else {
						stderr(message);
					}
					return 1;
				}

				storageInst.recordWorkspaceCleanedUp(runId);
				const payload = {
					runId,
					path: target.path,
					status: "deleted",
					previousStatus: target.status,
				};
				if (json) {
					stdout(formatJson(payload));
				} else {
					for (const line of formatWorkspaceCleanupResult(payload)) {
						stdout(line);
					}
				}
				return 0;
			}

			throw new Error(
				`Unknown workspace command: ${subcommand ?? "(missing subcommand)"}`,
			);
		}

		const bundle: CliOrchestratorBundle = deps?.createOrchestrator
			? {
					orchestrator: deps.createOrchestrator(),
					eventBus: { subscribe: () => () => {}, emit: () => {} },
					eventStore: { persistEvent: () => {} },
					commandExecutor: {
						executePacket: (_p: unknown, _r: string) => {
							throw new Error("mock bundle: executePacket not wired");
						},
					},
				}
			: await loadCliOrchestrator(cwd);
		const {
			orchestrator,
			eventBus: cliEventBus,
			eventStore: cliEventStore,
			memoryPort,
			structuredMemoryPort,
			honchoAdapter,
			userId,
			currentBranch,
			commandExecutor,
		} = bundle;

		switch (command) {
			case "init": {
				const result = orchestrator.initializeProject();
				for (const line of formatInitializationResult(result)) {
					stdout(line);
				}
				return 0;
			}
			case "run": {
				// --help BEFORE --packet validation (so `buildplane run --help` works without --packet)
				if (rest.includes("--help")) {
					for (const line of formatRunHelp()) {
						stdout(line);
					}
					return 0;
				}

				// Pre-flight: ensure project is initialized before packet loading
				orchestrator.getStatus();

				const packetIndex = rest.indexOf("--packet");
				if (packetIndex === -1 || !rest[packetIndex + 1]) {
					throw new Error("Missing required --packet <path> argument.");
				}

				const packetPath = resolve(cwd, rest[packetIndex + 1]);
				const packet = deps?.parsePacket
					? deps.parsePacket(packetPath)
					: await loadPacket(packetPath);
				const { preparePacketMemoryEnrichment } =
					await loadPacketEnrichmentModule();
				const preparedPacket = await preparePacketMemoryEnrichment(
					packet,
					memoryPort,
					honchoAdapter,
					userId,
					structuredMemoryPort,
					currentBranch,
				);
				const enrichedPacket = preparedPacket.packet;
				const packetUnitId =
					(enrichedPacket as { unit?: { id?: string } }).unit?.id ??
					(packet as { unit?: { id?: string } }).unit?.id ??
					"";

				const useRaw = rest.includes("--raw");
				const useJson = rest.includes("--json");

				// ── Strategy path (default) ──────────────────────────────
				if (!useRaw) {
					const { wrapAsStrategy } = await import("./strategy-wrapper.js");
					const strategy = wrapAsStrategy(
						enrichedPacket as Parameters<typeof wrapAsStrategy>[0],
					);

					const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
						createEventBus: () => {
							subscribe: (listener: (event: unknown) => void) => () => void;
							emit: (event: unknown) => void;
						};
					};
					const strategyBus = kernel.createEventBus();

					const useTui = rest.includes("--tui");
					if (useTui) {
						const tui = (await cliImport("@buildplane/ui-tui")) as unknown as {
							renderTui: (eventBus: unknown) => {
								waitUntilExit(): Promise<void>;
								unmount(): void;
								clear(): void;
							};
						};
						tui.renderTui(strategyBus);
					}

					const strategyResult = await orchestrator.runStrategy(
						strategy,
						strategyBus,
					);
					const strategyTargets = collectStrategyRunTargets(
						strategyResult as {
							childResults: Map<string, { run?: { id?: string } }>;
							rounds?: ReadonlyArray<Map<string, { run?: { id?: string } }>>;
						},
					);
					recordStrategyIdForTargets(
						structuredMemoryPort,
						strategyTargets,
						strategyResult.strategyId,
					);
					const injectedMemories = persistInjectedMemoriesForTargets(
						structuredMemoryPort,
						strategyTargets,
						preparedPacket.injectedMemories.length > 0
							? { [packetUnitId]: preparedPacket.injectedMemories }
							: {},
						strategyResult.winnerRunId,
					);
					const strategyOutput =
						injectedMemories.length > 0
							? {
									...strategyResult,
									injectedMemories,
								}
							: strategyResult;

					if (useJson) {
						stdout(formatJson(strategyOutput as Record<string, unknown>));
					} else {
						for (const line of formatStrategyRunResult(
							strategyOutput as Parameters<typeof formatStrategyRunResult>[0],
						)) {
							stdout(line);
						}
					}

					return strategyResult.outcome === "passed" ? 0 : 1;
				}

				// ── Raw path (single-shot, backward compat) ─────────────
				// Everything below is the EXISTING code, with ledger integration added
				const useTui = rest.includes("--tui");
				const isModelPacket = !!(enrichedPacket as { model?: unknown }).model;
				const useAsync = useTui || isModelPacket;

				// --- begin ledger integration ---
				// Disable when BUILDPLANE_LEDGER=0 or when running under test mocks
				// (deps.createOrchestrator present means the caller is injecting a mock).
				const useLedger =
					process.env.BUILDPLANE_LEDGER !== "0" && !deps?.createOrchestrator;
				let ledgerChild: LedgerChild | null = null;
				let ledgerEmitter: TapeEmitter | null = null;
				let unsubscribeLedger: (() => void) | null = null;
				const { randomUUID } = await import("node:crypto");
				const ledgerRunId = randomUUID();

				// Unit-context tracker: mutable state that getUnitCtx returns on demand.
				// Updated by the unit-boundary subscription below.
				let currentUnit: { unitId: string; parentEventId: string } | null =
					null;
				const getUnitCtx = () => currentUnit;

				if (useLedger) {
					try {
						const binary = resolveLedgerBinary(cwd);
						ledgerChild = spawnLedgerSubprocess(binary, ledgerRunId, cwd);
						ledgerEmitter = await createTapeEmitter({
							childStdin: ledgerChild.stdin,
							childStderr: ledgerChild.stderr,
							childExit: ledgerChild.exit,
							workspacePath: cwd,
							runId: ledgerRunId,
						});
						ledgerEmitter.onFailure((failure: LedgerFailure) => {
							// Best-effort: record that the ledger itself failed into the existing
							// state.db event store so there's a durable trace.
							try {
								cliEventStore.persistEvent(ledgerRunId, {
									kind: "ledger_failure",
									timestamp: new Date().toISOString(),
									runId: ledgerRunId,
									payload: failure as unknown as Record<string, unknown>,
								} as never);
							} catch {
								// Swallow: best-effort logging only.
							}
						});
						const workspacePath = resolve(cwd);
						unsubscribeLedger = cliEventBus.subscribe((evt: unknown) => {
							if (!ledgerEmitter) return;
							const e = evt as {
								kind?: string;
								unitId?: string;
								exitCode?: number;
							};
							switch (e.kind) {
								case "execution-started": {
									// Unit-level start. Emit unit_started, run pre-unit checkpoint,
									// update currentUnit.
									const unitId = e.unitId ?? "unknown";
									const unitStartedId = generateUuidV7();
									ledgerEmitter.emit(
										"unit_started",
										{
											UnitStartedV1: {
												unit_id: unitId,
												parent_unit_id: null,
												unit_kind: "command",
												policy: {},
											},
										},
										{ id: unitStartedId },
									);
									currentUnit = { unitId, parentEventId: unitStartedId };
									runGitCheckpoint({
										boundary: "pre-unit",
										runId: ledgerRunId,
										unitId,
										cwd: workspacePath,
										emitter: ledgerEmitter,
										parentEventId: unitStartedId,
									});
									break;
								}
								case "command-execution-complete": {
									// Unit-level end. Run post-unit checkpoint, emit unit_completed,
									// clear currentUnit.
									if (currentUnit) {
										runGitCheckpoint({
											boundary: "post-unit",
											runId: ledgerRunId,
											unitId: currentUnit.unitId,
											cwd: workspacePath,
											emitter: ledgerEmitter,
											parentEventId: currentUnit.parentEventId,
										});
										const outcome = e.exitCode === 0 ? "passed" : "failed";
										ledgerEmitter.emit(
											"unit_completed",
											{
												UnitCompletedV1: {
													unit_id: currentUnit.unitId,
													outcome,
													artifacts: [],
												},
											},
											{ parent: currentUnit.parentEventId },
										);
										currentUnit = null;
									}
									break;
								}
								default:
									// Phase C does not map policy-decision or other kernel events to
									// ledger events; Phase D+ concerns.
									break;
							}
						});
					} catch {
						// Ledger setup failed (spawn error, handshake timeout, version mismatch).
						// Kill the subprocess if it's still alive — silent degradation so the
						// run continues unaffected.
						if (ledgerChild?.child && ledgerChild.child.exitCode === null) {
							ledgerChild.child.kill("SIGTERM");
						}
						ledgerChild = null;
						ledgerEmitter = null;
					}
				}
				// --- end ledger integration ---

				// Capture the current ledgerEmitter reference so the closure below
				// captures the per-run emitter (not a shared mutable variable that
				// could change between runs).
				const runLedgerEmitter = ledgerEmitter;
				const runGetUnitCtx = getUnitCtx;

				// Thread the (possibly ledger-wrapped) registry into the execution
				// adapter by swapping the mutable commandExecutor slot.  The
				// runtimeRouter in loadCliOrchestrator reads commandExecutor.executePacket
				// by reference on every call, so swapping the property here is sufficient
				// to route all subsequent command packets through the wrapper.
				//
				// The registry is created per-call from executionRoot (the Git worktree
				// path) so that sandbox path validation inside run_command uses the
				// correct workspace root, not the project-root cwd.
				const { existsSync: fsExistsSync, realpathSync: fsRealpathSync } =
					await import("node:fs");
				const { resolve: pathResolve } = await import("node:path");
				const originalExecutePacket = commandExecutor.executePacket;
				commandExecutor.executePacket = (
					packetUnknown: unknown,
					executionRoot: string,
				): unknown => {
					const p = packetUnknown as {
						execution: {
							command: string;
							args?: readonly string[];
							cwd?: string;
						};
						verification: { requiredOutputs: readonly string[] };
					};
					const workspaceRoot = pathResolve(executionRoot);
					// Create a registry scoped to the worktree (executionRoot) so that
					// sandbox path resolution inside run_command uses the right root.
					const perCallRawRegistry = createToolRegistry(workspaceRoot);
					const perCallRegistry = runLedgerEmitter
						? wrapToolRegistryForLedger(
								perCallRawRegistry,
								runLedgerEmitter,
								runGetUnitCtx,
							)
						: perCallRawRegistry;
					// Resolve the effective cwd for the receipt (absolute path)
					const effectiveCwd = p.execution.cwd
						? pathResolve(workspaceRoot, p.execution.cwd)
						: workspaceRoot;
					const startedAt = new Date().toISOString();
					const result = perCallRegistry.run_command({
						command: p.execution.command,
						args: p.execution.args,
						// Pass cwd relative so the sandbox resolver inside run_command
						// can validate it against the worktreeRoot.
						cwd: p.execution.cwd,
					});
					const completedAt = new Date().toISOString();
					return {
						command: p.execution.command,
						args: [...(p.execution.args ?? [])],
						cwd: effectiveCwd,
						startedAt,
						completedAt,
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
						outputChecks: p.verification.requiredOutputs.map(
							(outputPath: string) => {
								const realWorkspaceRoot = (() => {
									try {
										return fsRealpathSync(workspaceRoot);
									} catch {
										return workspaceRoot;
									}
								})();
								return {
									path: outputPath,
									exists: fsExistsSync(
										pathResolve(realWorkspaceRoot, outputPath),
									),
								};
							},
						),
					};
				};

				if (useAsync && !useTui) {
					// Model packets auto-switch to async (no TUI)
					let asyncResultUnknown: unknown;
					try {
						asyncResultUnknown = withPersistedInjectedMemories(
							await orchestrator.runPacketAsync(enrichedPacket),
							structuredMemoryPort,
							preparedPacket.injectedMemories,
						);
					} finally {
						// --- begin ledger cleanup ---
						unsubscribeLedger?.();
						if (ledgerEmitter) {
							try {
								await ledgerEmitter.close();
							} catch {
								// Cleanup best-effort; the orchestrator result is the authoritative outcome.
							}
						}
						// Restore the original commandExecutor.executePacket so a subsequent
						// invocation of the orchestrator doesn't inherit this run's closed emitter.
						commandExecutor.executePacket = originalExecutePacket;
						// --- end ledger cleanup ---
					}
					// asyncResultUnknown is set here: if try threw, finally re-throws and we never reach this line.
					const asyncResult = asyncResultUnknown as {
						run: { id: string; status: string };
						receipt: unknown;
						decision: unknown;
					};
					const resultRecord = asyncResult as unknown as Record<
						string,
						unknown
					>;

					if (useJson) {
						stdout(formatJson(resultRecord));
					} else {
						for (const line of formatRunResult(asyncResult)) {
							stdout(line);
						}
					}

					return asyncResult.run.status === "passed" ? 0 : 1;
				}

				if (useTui) {
					// Lazy-load TUI — only imported when --tui is requested
					const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
						createEventBus: () => {
							subscribe: (listener: (event: unknown) => void) => () => void;
							emit: (event: unknown) => void;
						};
					};
					const tui = (await cliImport("@buildplane/ui-tui")) as unknown as {
						renderTui: (eventBus: unknown) => {
							waitUntilExit(): Promise<void>;
							unmount(): void;
							clear(): void;
						};
					};
					const storage = (await cliImport(
						"@buildplane/storage",
					)) as unknown as {
						createEventStore: (root: string) => {
							persistEvent: (runId: string, event: unknown) => void;
						};
					};

					const tuiBus = kernel.createEventBus();

					// Wire storage persistence to the TUI bus too
					const tuiEventStore = storage.createEventStore(cwd);
					tuiBus.subscribe((event: unknown) => {
						const e = event as { runId?: string };
						if (e.runId) {
							try {
								tuiEventStore.persistEvent(e.runId, event as never);
							} catch {
								// Don't let storage failures break the run
							}
						}
					});

					const tuiInstance = tui.renderTui(tuiBus);

					let tuiResult: Awaited<
						ReturnType<typeof orchestrator.runPacketAsync>
					>;
					try {
						tuiResult = await orchestrator.runPacketAsync(
							enrichedPacket,
							tuiBus,
						);
					} finally {
						// --- begin ledger cleanup ---
						unsubscribeLedger?.();
						if (ledgerEmitter) {
							try {
								await ledgerEmitter.close();
							} catch {
								// Cleanup best-effort; the orchestrator result is the authoritative outcome.
							}
						}
						// Restore the original commandExecutor.executePacket so a subsequent
						// invocation of the orchestrator doesn't inherit this run's closed emitter.
						commandExecutor.executePacket = originalExecutePacket;
						// --- end ledger cleanup ---
					}
					persistInjectedMemories(
						structuredMemoryPort,
						tuiResult.run.id,
						preparedPacket.injectedMemories,
					);
					await tuiInstance.waitUntilExit();

					return tuiResult.run.status === "passed" ? 0 : 1;
				}

				// Declare as unknown so both the try assignment and post-try casts typecheck.
				let syncResultUnknown: unknown;
				const syncStartMs = Date.now();
				try {
					// Emit run_started directly for the sync path (runPacket does not use the
					// event bus, so we cannot rely on bus subscription here).
					if (ledgerEmitter) {
						ledgerEmitter.emit("run_started", {
							RunStartedV1: {
								packet_hash: "sha256:unknown",
								git_head: "",
								workspace_path: cwd,
								config: {},
								parent_run_id: null,
							},
						});
					}
					syncResultUnknown = withPersistedInjectedMemories(
						useAsync
							? await orchestrator.runPacketAsync(enrichedPacket, undefined)
							: orchestrator.runPacket(enrichedPacket, cliEventBus),
						structuredMemoryPort,
						preparedPacket.injectedMemories,
					);
					// Emit run_completed on success.
					if (ledgerEmitter) {
						const r = syncResultUnknown as { run?: { status?: string } };
						const outcome = r.run?.status === "passed" ? "passed" : "failed";
						ledgerEmitter.emit("run_completed", {
							RunCompletedV1: {
								outcome,
								duration_ms: Date.now() - syncStartMs,
								event_count: 0,
								unit_count: 1,
							},
						});
					}
				} finally {
					// --- begin ledger cleanup ---
					unsubscribeLedger?.();
					if (ledgerEmitter) {
						try {
							await ledgerEmitter.close();
						} catch {
							// Cleanup best-effort; the orchestrator result is the authoritative outcome.
						}
					}
					// Restore the original commandExecutor.executePacket so a subsequent
					// invocation of the orchestrator doesn't inherit this run's closed emitter.
					commandExecutor.executePacket = originalExecutePacket;
					// --- end ledger cleanup ---
				}
				// syncResultUnknown is set here: if try threw, finally re-throws and we never arrive.
				const syncResult = syncResultUnknown as {
					run: { id: string; status: string };
					receipt: unknown;
					decision: unknown;
					failure?: unknown;
				};
				const resultRecord = syncResult as unknown as Record<string, unknown>;
				const hasFailed =
					resultRecord.failure && typeof resultRecord.failure === "object";
				if (useJson) {
					stdout(formatJson(resultRecord));
				} else {
					for (const line of formatRunResult(syncResult)) {
						stdout(line);
					}
				}
				if (hasFailed) {
					const f = resultRecord.failure as { message?: string };
					if (f.message) stderr(f.message);
				}
				return hasFailed || syncResult.run.status !== "passed" ? 1 : 0;
			}
			case "status": {
				const json = rest.includes("--json");
				const result = orchestrator.getStatus() as unknown as Record<
					string,
					unknown
				>;

				if (json) {
					stdout(formatJson(result));
				} else {
					stdout(`initialized: ${result.initialized}`);
					const latestRun = result.latestRun as
						| { id: string; unitId: string; status: string }
						| undefined;
					if (latestRun) {
						stdout(
							`latest-run: ${latestRun.id} ${latestRun.status} (${latestRun.unitId})`,
						);
					}
					const runCounts = result.runCounts as
						| {
								pending: number;
								running: number;
								passed: number;
								failed: number;
								cancelled: number;
						  }
						| undefined;
					if (runCounts) {
						stdout(
							`run-counts: pending=${runCounts.pending} running=${runCounts.running} passed=${runCounts.passed} failed=${runCounts.failed} cancelled=${runCounts.cancelled}`,
						);
					}
					const latestWorkspace = result.latestWorkspace as
						| { path: string; status: string }
						| undefined;
					if (latestWorkspace?.path) {
						stdout(
							`workspace: ${latestWorkspace.path} (${latestWorkspace.status})`,
						);
					}
					const actionableWorkspaces = result.actionableWorkspaces as
						| unknown[]
						| undefined;
					if (actionableWorkspaces && actionableWorkspaces.length > 0) {
						stdout(`actionable-workspaces: ${actionableWorkspaces.length}`);
					}
				}
				return 0;
			}
			case "inspect": {
				const json = rest.includes("--json");
				const id = rest.find((value) => value !== "--json");
				if (!id) {
					throw new Error("Missing required run or unit id for inspect.");
				}

				const result = orchestrator.inspect(id);

				if (json) {
					stdout(formatJson(result));
				} else {
					let events: Array<{
						kind: string;
						runId: string;
						timestamp: string;
						[key: string]: unknown;
					}> = [];
					try {
						const eventStore = await loadEventStore(cwd);
						events = eventStore.getEventsByRunId(
							result.run.id,
						) as typeof events;
					} catch {
						// Event store unavailable (e.g., uninitialized in tests)
					}
					// Query learnings produced by this run
					let runLearnings: Array<{
						id: string;
						runId: string;
						scope: string;
						kind: string;
						title: string;
						body: string;
						status: string;
						createdAt: string;
						seenCount: number;
					}> = [];
					try {
						const memoryPort = await loadReadOnlyMemoryPort(cwd);
						if (memoryPort) {
							runLearnings = [
								...memoryPort.fetchLearningsByRunId(result.run.id),
							];
						}
					} catch {
						// Memory port unavailable
					}
					for (const line of formatInspectDetail(
						result as unknown as Parameters<typeof formatInspectDetail>[0],
						events,
						runLearnings,
					)) {
						stdout(line);
					}
				}
				return 0;
			}
			case "history": {
				const json = rest.includes("--json");
				const entries = await loadRunHistory(cwd);

				if (json) {
					stdout(formatJson(entries));
				} else {
					for (const line of formatRunHistory(
						entries as Array<{
							id: string;
							unitId: string;
							status: string;
							strategyId?: string;
							injectedMemoryCount?: number;
							promotedStructuredMemoryCount?: number;
							createdAt: string;
							completedAt?: string;
						}>,
					)) {
						stdout(line);
					}
				}
				return 0;
			}
			case "replay": {
				const runId = rest.find((v) => !v.startsWith("--"));
				if (!runId) {
					throw new Error("Missing required run id for replay.");
				}

				const json = rest.includes("--json");

				// Load packet snapshot from storage
				const storage = (await cliImport("@buildplane/storage")) as unknown as {
					createBuildplaneStorage: (root: string) => {
						getPacketSnapshot: (id: string) => unknown | null;
					};
				};
				const storageInst = storage.createBuildplaneStorage(cwd);
				const packet = storageInst.getPacketSnapshot(runId);

				if (!packet) {
					throw new Error(
						`Cannot replay run '${runId}': no packet snapshot found. Only runs created with the current version can be replayed.`,
					);
				}

				// Apply overrides
				const replayPacket = applyReplayOverrides(
					packet as Record<string, unknown>,
					rest,
				);

				// Create event bus with storage persistence
				const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
					createEventBus: () => {
						subscribe: (listener: (event: unknown) => void) => () => void;
						emit: (event: unknown) => void;
					};
				};
				const storageForEvents = (await import(
					"@buildplane/storage"
				)) as unknown as {
					createEventStore: (root: string) => {
						persistEvent: (runId: string, event: unknown) => void;
					};
				};

				const replayBus = kernel.createEventBus();
				const eventStore = storageForEvents.createEventStore(cwd);
				replayBus.subscribe((event: unknown) => {
					const e = event as { runId?: string };
					if (e.runId) {
						try {
							eventStore.persistEvent(e.runId, event as never);
						} catch {
							// Silent
						}
					}
				});

				const result = await orchestrator.runPacketAsync(
					replayPacket,
					replayBus,
				);

				if (json) {
					stdout(
						formatJson({
							originalRunId: runId,
							replay: {
								runId: result.run.id,
								status: result.run.status,
							},
						}),
					);
				} else {
					stdout(`replay of: ${runId}`);
					for (const line of formatRunResult(
						result as { run: { id: string; status: string } },
					)) {
						stdout(line);
					}
				}

				return result.run.status === "passed" ? 0 : 1;
			}
			case "run-graph": {
				const graphIndex = rest.indexOf("--graph");
				if (graphIndex === -1 || !rest[graphIndex + 1]) {
					throw new Error("Missing required --graph <path> argument.");
				}
				const graphPath = resolve(cwd, rest[graphIndex + 1]);
				const rawGraph = JSON.parse(readFileSync(graphPath, "utf8")) as Record<
					string,
					unknown
				>;
				const graph = normalizeGraph(rawGraph);
				const { prepareGraphMemoryEnrichment } =
					await loadPacketEnrichmentModule();
				const preparedGraph = await prepareGraphMemoryEnrichment(
					graph as Record<string, unknown>,
					memoryPort,
					honchoAdapter,
					userId,
					structuredMemoryPort,
					currentBranch,
				);

				const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
					createEventBus: () => {
						subscribe: (listener: (event: unknown) => void) => () => void;
						emit: (event: unknown) => void;
					};
				};
				const graphBus = kernel.createEventBus();

				const graphResult = await orchestrator.runGraphAsync(
					preparedGraph.graph,
					graphBus,
				);
				persistInjectedMemoriesForTargets(
					structuredMemoryPort,
					graphResult.nodes.map((node) => ({
						unitId: node.unitId,
						runId: node.runId,
					})),
					preparedGraph.injectedMemoriesByUnitId,
				);

				stdout(`Graph Outcome: ${graphResult.outcome}`);
				for (const node of graphResult.nodes) {
					stdout(` - ${node.unitId}: ${node.status}`);
				}
				return graphResult.outcome === "passed" ? 0 : 1;
			}
			case "run-strategy": {
				const strategyIndex = rest.indexOf("--strategy");
				if (strategyIndex === -1 || !rest[strategyIndex + 1]) {
					throw new Error("Missing required --strategy <path> argument.");
				}
				const strategyPath = resolve(cwd, rest[strategyIndex + 1]);

				const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
					parseStrategyPacket: (raw: unknown) => unknown;
					createEventBus: () => {
						subscribe: (listener: (event: unknown) => void) => () => void;
						emit: (event: unknown) => void;
					};
				};

				const rawStrategy = JSON.parse(readFileSync(strategyPath, "utf8"));
				const strategy = kernel.parseStrategyPacket(rawStrategy);
				const { prepareStrategyMemoryEnrichment } =
					await loadPacketEnrichmentModule();
				const preparedStrategy = await prepareStrategyMemoryEnrichment(
					strategy as Record<string, unknown>,
					memoryPort,
					honchoAdapter,
					userId,
					structuredMemoryPort,
					currentBranch,
				);
				const strategyBus = kernel.createEventBus();

				const strategyResult = await orchestrator.runStrategy(
					preparedStrategy.strategy,
					strategyBus,
				);
				const strategyTargets = [
					...Array.from(
						(strategyResult.rounds ?? []).flatMap((round) =>
							Array.from(round.entries()).map(([unitId, childResult]) => ({
								unitId,
								runId: childResult.run.id,
							})),
						),
					),
					...Array.from(strategyResult.childResults.entries()).map(
						([unitId, childResult]) => ({
							unitId,
							runId: childResult.run.id,
						}),
					),
				];
				recordStrategyIdForTargets(
					structuredMemoryPort,
					strategyTargets,
					strategyResult.strategyId,
				);
				const injectedMemories = persistInjectedMemoriesForTargets(
					structuredMemoryPort,
					strategyTargets,
					preparedStrategy.injectedMemoriesByUnitId,
					strategyResult.winnerRunId,
				);
				const strategyOutput =
					injectedMemories.length > 0
						? {
								...strategyResult,
								injectedMemories,
							}
						: strategyResult;

				const json = rest.includes("--json");
				if (json) {
					stdout(formatJson(strategyOutput as Record<string, unknown>));
				} else {
					for (const line of formatStrategyRunResult(
						strategyOutput as Parameters<typeof formatStrategyRunResult>[0],
					)) {
						stdout(line);
					}
				}

				return strategyResult.outcome === "passed" ? 0 : 1;
			}
			default:
				throw new Error(`Unknown command: ${command}`);
		}
	} catch (error) {
		const { code, message } = classifyCliError(error);
		const jsonMode = rest.includes("--json");
		const formatted = jsonMode
			? formatJson(formatJsonError(code, message))
			: formatHumanError(message).join("\n");

		if (jsonMode) {
			stdout(formatted);
		} else {
			stderr(formatted);
		}

		return 1;
	}
}

function normalizeGraph(raw: Record<string, unknown>): unknown {
	const nodes = (raw.nodes as Record<string, unknown>[]) ?? [];
	return {
		...raw,
		nodes: nodes.map(normalizeGraphNode),
	};
}

function normalizeGraphNode(node: Record<string, unknown>): unknown {
	const unit = (node.unit as Record<string, unknown>) ?? {};

	// Normalize execution block: handle "entrypoint" alias for "command"
	const rawExecution = node.execution as Record<string, unknown> | undefined;
	let normalizedExecution: Record<string, unknown> | undefined;
	if (rawExecution) {
		const {
			kind: _kind,
			entrypoint,
			command,
			...restExec
		} = rawExecution as {
			kind?: unknown;
			entrypoint?: string;
			command?: string;
			[key: string]: unknown;
		};
		normalizedExecution = { command: command ?? entrypoint, ...restExec };
	}

	// Handle "dependencies" as alias for "dependsOn"
	const dependsOn = node.dependsOn ?? node.dependencies ?? [];

	return {
		...node,
		unit: {
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: [],
			verificationContract: "exit-0",
			policyProfile: "default",
			...unit,
		},
		dependsOn,
		execution: normalizedExecution,
		verification: node.verification ?? { requiredOutputs: [] },
	};
}

function applyReplayOverrides(
	packet: Record<string, unknown>,
	args: string[],
): unknown {
	const result = { ...packet };

	for (const arg of args) {
		if (arg.startsWith("--model=")) {
			const modelValue = arg.slice("--model=".length);
			const slashIndex = modelValue.indexOf("/");

			if (slashIndex > 0) {
				// --model=provider/model-name
				const provider = modelValue.slice(0, slashIndex);
				const model = modelValue.slice(slashIndex + 1);
				const existing = (result.model as Record<string, unknown>) ?? {};
				result.model = { ...existing, provider, model };
				// If switching to model execution, remove command execution
				delete result.execution;
			} else {
				// --model=model-name (keep existing provider)
				const existing = (result.model as Record<string, unknown>) ?? {};
				result.model = { ...existing, model: modelValue };
				delete result.execution;
			}
		} else if (arg.startsWith("--policy=")) {
			const policyProfile = arg.slice("--policy=".length);
			const unit = (result.unit as Record<string, unknown>) ?? {};
			result.unit = { ...unit, policyProfile };
		}
	}

	return result;
}

function classifyCliError(error: unknown): { code: string; message: string } {
	const message = error instanceof Error ? error.message : String(error);

	if (error instanceof NativeCommandDispatchError) {
		return { code: NATIVE_COMMAND_DISPATCH_ERROR_CODE, message };
	}

	if (/not initialized/i.test(message)) {
		return { code: "NOT_INITIALIZED", message };
	}

	if (/No run or unit found/i.test(message)) {
		return { code: "NOT_FOUND", message };
	}

	if (
		error instanceof SyntaxError ||
		/packet\./i.test(message) ||
		/Missing required --packet/i.test(message) ||
		/ENOENT/i.test(message)
	) {
		return { code: "INVALID_PACKET", message };
	}

	return { code: "CLI_ERROR", message };
}
