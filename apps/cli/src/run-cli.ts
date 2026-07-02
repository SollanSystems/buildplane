import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeToolEvent } from "@buildplane/adapters-models";
import {
	createToolRegistry,
	type ToolRegistryOptions,
} from "@buildplane/adapters-tools";
import type {
	AuthorizationEnvelopeV0,
	BudgetConstraints,
	BuildplaneAcceptancePort,
	BuildplaneProfileRegistryPort,
	BuildplaneStoragePort,
	EnvelopeProposal,
	LedgerActivityPort,
	OperatorDecisionPort,
	PolicyProfile,
	RecordOperatorDecisionInput,
} from "@buildplane/kernel";
import {
	createTapeEmitter,
	type LedgerFailure,
	newEventId,
	type PlanAdmittedV1,
	type TapeEmitter,
} from "@buildplane/ledger-client";
import type {
	MissionControlOrchestrator,
	MissionControlStore,
} from "@buildplane/mission-control-server";
import { evaluateEnvelopeAdmission } from "@buildplane/policy";
import {
	type BootstrapDoctorReport,
	inspectBootstrapDoctor,
} from "./bootstrap-doctor.js";
import { type CapabilityReport, inspectCapabilities } from "./capabilities.js";
import { createClaudeToolLedgerEmitter } from "./claude-tool-ledger-emitter.js";
import {
	createInspectorProjection,
	formatBootstrapDoctorReport,
	formatCapabilityReport,
	formatEventsList,
	formatHumanError,
	formatInitializationResult,
	formatInspectDetail,
	formatInspectorProjection,
	formatJson,
	formatJsonError,
	formatLearningDetail,
	formatLearningsList,
	formatProceduresList,
	formatRepoFactsList,
	formatRunHistory,
	formatRunResult,
	formatStrategyRunResult,
	formatWorkflowScanPreview,
	formatWorkspaceCleanupResult,
	formatWorkspaceList,
} from "./formatters.js";
import { buildGoalPlan } from "./goal-command.js";
import {
	createAcceptancePort,
	evaluateAcceptanceDiffScope,
} from "./ledger-acceptance.js";
import {
	createDeferredLedgerActivityPort,
	createLedgerActivityPort,
} from "./ledger-activity-port.js";
import { emitCapabilityDenied } from "./ledger-capability-denied.js";
import {
	assertKernelSigningKey,
	deriveLedgerSpawnCwd,
	type LedgerChild,
	PLANFORGE_KERNEL_SIGNING_KEY_ID,
	resolveLedgerBinary,
	spawnLedgerSubprocess,
} from "./ledger-emit.js";
import { runGitCheckpoint } from "./ledger-git-checkpoint.js";
import { createOperatorDecisionPort } from "./ledger-operator-decision.js";
import { createLedgerReceiptPort } from "./ledger-receipt-port.js";
import { wrapToolRegistryForLedger } from "./ledger-tool-wrapper.js";
import {
	buildEnvelopeProposal,
	clearLoopState,
	initialLoopState,
	type LoopState,
	loopStatePath,
	nextLoopState,
	readLoopState,
	runawayGuardProfile,
	stopFileRequested,
	withCrashAfterActivityGuard,
	writeLoopStateAtomic,
} from "./loop-supervisor.js";
import type {
	PacketMemoryEnrichmentResult,
	preparePacketMemoryEnrichment,
} from "./packet-enrichment.js";
import {
	loadActiveAuthorizationEnvelope,
	runPlanForgeAuthorizeEnvelopeCommand,
} from "./planforge-authorize-envelope.js";
import { runPlannerProposal } from "./planforge-planner.js";
import {
	acceptanceContractDigest,
	buildPlanAdmittedPayload,
	buildPlanReceiptPayload,
	createPlanForgeDryRunPlan,
	deriveAcceptanceContract,
	dispatchAdmittedPlan,
	formatPriorWorkEntry,
	loadRoadmapFromString,
	PLANFORGE_AUTHORIZED_NEXT_STEP,
	PLANFORGE_VALIDATION_STATUS_PASS,
	type PlanForgePlan,
	type PlanSummary,
	type RoadmapDoc,
	summarizePlanReceipt,
} from "./planforge-schema.js";
import {
	defaultPrCheckRequest,
	defaultPrCommentRequest,
	defaultPrHeadVerifier,
	formatPrCheckHuman,
	formatPrCommentHuman,
	loadCapabilityGrantsFromJson,
	type PrCheckRequest,
	type PrCommentRequest,
	type PrHeadVerifier,
	planPrCheckOperation,
	planPrCommentOperation,
	publishPrCheckOperation,
	publishPrCommentOperation,
} from "./pr-check.js";
import {
	detectRepoSignals,
	seedRepoFactsFromInspection,
} from "./repo-fact-seeding.js";
import { createOtelTraceExport } from "./trace-export.js";
import {
	DEFAULT_WEB_PORT,
	executeWebCommand,
	type WebCommandOptions,
} from "./web-command.js";
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

/** Planner port output: the next slice's plan path + slice id + milestone. */
export interface LoopSliceProposal {
	readonly planPath: string;
	readonly sliceId: string;
	readonly milestone: string;
}

/** Rich dispatch outcome the supervisor loop reads for re-anchoring (D3). */
export interface LoopDispatchResult {
	readonly allPassed: boolean;
	readonly mergedHeadSha: string | null;
	/**
	 * Real total token usage (input + output) summed across this dispatch's model
	 * activities, extracted from each executor's terminal result `usage`. Fed to
	 * the supervisor's cumulative `token_budget` cap (GAP-7 CRITICAL-2). 0 when no
	 * model activity reported usage (e.g. command-only dispatch).
	 */
	readonly tokenUsage: number;
	/**
	 * Whether the FAILING task produced durable side effects — a non-empty worktree
	 * diff (`receipt.changedFiles`) or a merged HEAD. R1: this is the failing task's
	 * OWN evidence, NOT an OR across the dispatch, so a passing predecessor's merge
	 * cannot mask a later infra death. `false` fingerprints an infra/dispatch death
	 * where the worker never ran (e.g. a 429 rejection: 0 tokens, 0 turns, empty
	 * diff). The supervisor uses this to label a failed dispatch `dispatch-error`
	 * (worker never produced work) vs `acceptance-fail` (worker built a diff the
	 * acceptance contract rejected).
	 */
	readonly producedSideEffects: boolean;
	/**
	 * The failing task's policy-decision reasons (acceptance/dispatch), threaded
	 * verbatim into the supervisor's terminal detail so a halt carries the real
	 * cause instead of a hardcoded placeholder. Empty when the dispatch passed or
	 * reported no reasons.
	 */
	readonly reasons: readonly string[];
	readonly runs: readonly unknown[];
}

/**
 * Injectable supervisor-loop ports (all optional — the real planforge
 * helpers GAP-9/10/8 produce the defaults). The test seam injects fakes so a
 * loop iteration runs end-to-end with no claude/ledger spawns.
 */
export interface LoopRunCliDeps {
	loopPlanner?: (ctx: {
		workspace: string;
		lastMergedHeadSha: string | null;
		trustedBase: string | null;
	}) => Promise<LoopSliceProposal | { done: true }>;
	loopEnvelope?: {
		load: (
			workspace: string,
		) => Promise<{ envelope: AuthorizationEnvelopeV0 } | null>;
		check: (
			proposal: EnvelopeProposal,
			envelope: AuthorizationEnvelopeV0 | null,
		) => { ok: true } | { ok: false; reason: string };
	};
	loopDryRun?: (
		planPath: string,
		cwd: string,
	) => Promise<
		{ ok: true; plan: PlanForgePlan } | { ok: false; reason: string }
	>;
	loopAdmit?: (
		planPath: string,
		cwd: string,
	) => Promise<{ admittedEventId: string }>;
	loopDispatch?: (
		planPath: string,
		cwd: string,
		guard: PolicyProfile,
	) => Promise<LoopDispatchResult>;
}

export interface RunCliDependencies extends LoopRunCliDeps {
	createOrchestrator?: () => BuildplaneCliOrchestrator;
	parsePacket?: (packetPath: string) => unknown;
	inspectBootstrapDoctor?: () => BootstrapDoctorReport;
	inspectCapabilities?: () => CapabilityReport;
	publishPrCheckRequest?: PrCheckRequest;
	publishPrCommentRequest?: PrCommentRequest;
	verifyPrHeadRequest?: PrHeadVerifier;
	runNativeCommand?: (
		argv: string[],
		options: {
			cwd: string;
			commandPath: string[];
			stdout: (line: string) => void;
			stderr: (line: string) => void;
		},
	) => Promise<number> | number;
	runWebCommand?: (options: WebCommandOptions) => Promise<number>;
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

type AdmissionReceiptInputLike = Record<string, unknown>;

interface AdmissionReceiptKernelModule {
	createRunAdmissionReceiptDryRun(
		input: AdmissionReceiptInputLike,
	): Record<string, unknown>;
}

type RunAdmissionStoreLike = {
	writeReceiptArtifact(input: {
		receipt: Record<string, unknown>;
		receiptDigest: string;
		contents: string;
	}): { ref: string; path: string };
	appendAdmissionEvent(input: {
		event: Record<string, unknown>;
		receipt: Record<string, unknown>;
	}): {
		ref: string;
		path: string;
	};
};

function safeAdmissionArtifactStem(value: unknown): string {
	const raw = typeof value === "string" ? value : "run_admission";
	const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
	return safe.length > 0 ? safe : "run_admission";
}

function createRunAdmissionEventRef(input: {
	event: Record<string, unknown>;
	receipt: Record<string, unknown>;
}): string {
	const eventKind =
		typeof input.event.kind === "string" && input.event.kind.length > 0
			? input.event.kind
			: "run_admission_recorded";
	const recordedAt =
		typeof input.event.recorded_at === "string" &&
		input.event.recorded_at.length > 0
			? input.event.recorded_at
			: "";
	const payload = nestedRecord(input.event, "payload");
	const payloadReceiptId =
		payload && typeof payload.receipt_id === "string"
			? payload.receipt_id
			: undefined;
	const storeReceiptId =
		typeof input.receipt.receipt_id === "string"
			? input.receipt.receipt_id
			: undefined;
	const receiptId = safeAdmissionArtifactStem(
		payloadReceiptId ?? storeReceiptId,
	);
	const eventDigest = createHash("sha256")
		.update(
			JSON.stringify({
				eventKind,
				recordedAt,
				receiptId,
				payload,
				receipt: input.receipt,
			}),
		)
		.digest("hex");
	return `event://run-admission/${receiptId}/${eventDigest}`;
}

function resolveGitMetadataDir(projectRoot: string): string {
	const gitPath = resolve(projectRoot, ".git");
	try {
		const gitFile = readFileSync(gitPath, "utf8").trim();
		const match = /^gitdir:\s*(.+)$/.exec(gitFile);
		const gitdir = match?.[1]?.trim();
		if (gitdir) {
			return resolve(projectRoot, gitdir);
		}
	} catch {
		// A normal repository has .git as a directory; fall through.
	}
	return gitPath;
}

function createCliRunAdmissionStore(
	projectRoot: string,
): RunAdmissionStoreLike {
	const admissionDir = resolve(
		resolveGitMetadataDir(projectRoot),
		"buildplane",
		"admission",
	);
	const receiptsDir = resolve(admissionDir, "receipts");
	const eventsPath = resolve(admissionDir, "events.jsonl");
	return {
		writeReceiptArtifact(input) {
			mkdirSync(receiptsDir, { recursive: true });
			const stem = safeAdmissionArtifactStem(input.receipt.receipt_id);
			const path = resolve(receiptsDir, `${stem}.json`);
			writeFileSync(path, input.contents, "utf8");
			return {
				ref: `artifact://run-admission/${input.receiptDigest}`,
				path,
			};
		},
		appendAdmissionEvent(input) {
			mkdirSync(admissionDir, { recursive: true });
			appendFileSync(eventsPath, `${JSON.stringify(input.event)}\n`, "utf8");
			return {
				ref: createRunAdmissionEventRef(input),
				path: eventsPath,
			};
		},
	};
}

class AdmissionReceiptCliError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "AdmissionReceiptCliError";
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(
	record: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = record[key];
	return isPlainRecord(value) ? value : undefined;
}

function parseAdmissionReceiptArgs(args: string[]): {
	readonly inputPath: string;
	readonly dryRun: boolean;
	readonly json: boolean;
} {
	let inputPath: string | undefined;
	let dryRun = false;
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--input") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) {
				throw new AdmissionReceiptCliError(
					"MISSING_ARGUMENT",
					"Missing required --input <path> for admission receipt dry-run.",
				);
			}
			inputPath = value;
			index += 1;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new AdmissionReceiptCliError(
			"UNSUPPORTED_ARGUMENTS",
			`Unsupported admission receipt argument: ${arg}.`,
		);
	}
	if (!inputPath) {
		throw new AdmissionReceiptCliError(
			"MISSING_ARGUMENT",
			"Missing required --input <path> for admission receipt dry-run.",
		);
	}
	if (!dryRun) {
		throw new AdmissionReceiptCliError(
			"UNSUPPORTED_ARGUMENTS",
			"admission receipt currently supports --dry-run only.",
		);
	}
	return { inputPath, dryRun, json };
}

function normalizeAdmissionReceiptDryRunInput(
	raw: unknown,
): AdmissionReceiptInputLike {
	if (!isPlainRecord(raw)) {
		throw new AdmissionReceiptCliError(
			"INVALID_PACKET",
			"Invalid run admission receipt input.",
		);
	}
	if (
		"receiptId" in raw ||
		"decidedAt" in raw ||
		"policyProfileId" in raw ||
		"evidenceInputs" in raw
	) {
		return raw;
	}
	const policy = nestedRecord(raw, "policy");
	const admission = nestedRecord(raw, "admission");
	const provenance = nestedRecord(raw, "provenance");
	return {
		receiptId: raw.receipt_id,
		decidedAt: admission?.decided_at,
		run: raw.run,
		repo: raw.repo,
		request: raw.request,
		policyProfileId: policy?.profile_id,
		evidenceInputs: raw.evidence_inputs,
		actor: admission?.decided_by,
		source: provenance?.created_from ?? "dry-run",
		pack: provenance?.pack,
		host: provenance?.host,
		provider: provenance?.provider,
	};
}

function admissionReceiptErrorCode(error: unknown): string {
	if (error instanceof AdmissionReceiptCliError) {
		return error.code;
	}
	if (isPlainRecord(error) && typeof error.code === "string") {
		return error.code;
	}
	if (error instanceof SyntaxError) {
		return "INVALID_PACKET";
	}
	return "INVALID_PACKET";
}

function sanitizeAdmissionReceiptErrorMessage(error: unknown): string {
	if (error instanceof AdmissionReceiptCliError) {
		return error.message;
	}
	if (error instanceof SyntaxError) {
		return "Invalid JSON input for admission receipt dry-run.";
	}
	if (isPlainRecord(error) && error.code === "INVALID_PACKET") {
		return "Invalid run admission receipt input.";
	}
	return "Invalid run admission receipt input.";
}

async function runAdmissionReceiptDryRunCommand(
	args: string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	let json = args.includes("--json");
	try {
		const parsedArgs = parseAdmissionReceiptArgs(args);
		json = parsedArgs.json;
		const rawInput = JSON.parse(
			readFileSync(resolve(cwd, parsedArgs.inputPath), "utf8"),
		) as unknown;
		const kernel = (await cliImport(
			"@buildplane/kernel",
		)) as AdmissionReceiptKernelModule;
		const receipt = kernel.createRunAdmissionReceiptDryRun(
			normalizeAdmissionReceiptDryRunInput(rawInput),
		);
		if (json) {
			stdout(formatJson(receipt));
		} else {
			stdout(
				`admission: ${nestedRecord(receipt, "admission")?.decision ?? "unknown"}`,
			);
			stdout("will-execute-worker: false");
		}
		return 0;
	} catch (error) {
		const code = admissionReceiptErrorCode(error);
		const message = sanitizeAdmissionReceiptErrorMessage(error);
		const formattedJsonError = formatJson(formatJsonError(code, message));
		if (json) {
			stdout(formattedJsonError);
		} else {
			stdout(formatHumanError(message).join("\n"));
		}
		return 1;
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

function resolveCurrentCommit(projectRoot: string): string | undefined {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: projectRoot,
		encoding: "utf8",
		env: process.env,
	});
	if (result.status !== 0) {
		return undefined;
	}
	const commit = result.stdout.trim();
	return commit.length > 0 ? commit : undefined;
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
		'    goal "<text>" [--trusted-base <sha>]  Compile + preview a raw goal into plan JSON',
		"    demo [--model]         Prove the flywheel in 30 seconds",
		"",
		"  Observe:",
		"    status [--json]        Project health snapshot",
		"    history [--json]       List all runs",
		"    inspect <id> [--json] [--view inspector]  Deep-dive into a run and event tape",
		"    verify --run <id> [--json]  Final receipt-backed verdict",
		"    evidence export --run <id> --out <file>  Export Mission Control bundle",
		"    web [--port N] [--check] [--allow-external]  Serve the Mission Control web UI",
		"    trace export --run <id> --format otel-json --out <file>  Export local trace artifact",
		"    pr-check dry-run --run <id> --repo <owner/repo> --sha <head> [--json]  Preview GitHub check-run publish",
		"    pr-comment dry-run --run <id> --repo <owner/repo> --pr <n> --sha <head> [--json]  Preview PR evidence comment",
		"    replay <id> [--json]   Re-execute the stored packet snapshot",
		"    ledger replay --run-id <id> --workspace <path>  Read-only tape replay",
		"    ledger export-signed-tape --run-id <id> --workspace <path> --out <dir>  Export buildplane.signed-tape.v1",
		"    fork <id> --at <event> --packet <file>          Recover from a unit boundary",
		"    planforge dry-run --input <file> --json          Emit dry-run plan artifact",
		"",
		"  Advanced:",
		"    run-graph --graph <p>  Execute a DAG of tasks",
		"    run-strategy --strat   Run a custom multi-role strategy",
		"",
		"  Project:",
		"    init                   Initialize .buildplane in this repo",
		"    bootstrap doctor      Check published CLI prerequisites and capabilities",
		"    workspace list         Show actionable retained/cleanup-failed workspaces",
		"    workspace cleanup <r>  Delete an actionable workspace by run id",
		"    workflow scan [--json] Preview recognized Claude/Codex workflow files",
		"    memory list            Show stored learnings",
		"    memory facts           Show structured repo facts",
		"    memory procedures      Show stored procedures",
		"    memory inspect <id>    Detail for one learning",
		"    memory <action>        Advanced memory operations (native)",
		"    pack show <id>         Inspect a pack",
		"    pack export <id> --target github-agent|github-skill --out <path>  Export pack guidance",
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

function formatReplayHelp(): string[] {
	return [
		"buildplane replay <run-id> [options]",
		"",
		"  Re-executes the stored packet snapshot from a prior run and records a new run.",
		"  Use this when you want to try the same unit again with a changed policy or",
		"  runtime setting. For read-only event-tape reconstruction, use:",
		"",
		"    buildplane ledger replay --run-id <run-id> --workspace <path>",
		"",
		"  Options:",
		"    --json              Machine-readable replay result",
		"    --policy <profile>  Override the policy profile for the replay run",
	];
}

function formatPlanForgeHelp(): string[] {
	return [
		"buildplane planforge dry-run --input <file> --json",
		"",
		"  Validates a local PlanForge goal fixture and emits a stable reviewable",
		"  PlanForgePlan JSON artifact without execution, board writes, network",
		"  writes, worker spawns, push, deploy, merge, or project state mutation.",
		"",
		"  Options:",
		"    --input <file>  Markdown PlanForge goal fixture to validate",
		"    --json          Required; prints the dry-run plan as JSON",
		"",
		"buildplane planforge admit --input <file> --approve --operator <id> [--json]",
		"",
		"  Records an operator-approved admission for a PASS plan as a signed",
		"  plan_admitted event on the L0 tape (kernel key; --operator is the",
		"  decided_by payload field). Fails closed with no tape write on a non-PASS",
		"  plan, a missing --approve, or a missing --operator. Idempotent: a plan",
		"  already admitted is a no-op.",
		"",
		"  Options:",
		"    --input <file>   Markdown PlanForge goal fixture to admit",
		"    --approve        Required; explicit operator approval to sign the admission",
		"    --operator <id>  Required; deciding operator identity (decided_by)",
		"    --json           Prints the admission result as JSON",
		"",
		"buildplane planforge dispatch --input <file> [--json] [--no-enforce-acceptance]",
		"",
		"  Dispatches an operator-admitted plan as one run per PlanForgeTask through",
		"  the kernel run loop. Fails closed (plan-not-admitted) with no run when no",
		"  signed plan_admitted exists on the tape. Tasks run sequentially so a",
		"  dependent task does not start if its predecessor fails.",
		"",
		"  Options:",
		"    --input <file>           Markdown PlanForge goal fixture to dispatch",
		"    --json                   Prints the dispatch result (per-task run ids) as JSON",
		"    --no-enforce-acceptance  Skip the finalization acceptance gate (diff-scope +",
		"                             verificationCommands). The gate is ON by default and",
		"                             worktree deps are provisioned (pnpm install) before",
		"                             checks run; use this flag only when worktree",
		"                             dependencies cannot be provisioned.",
		"",
		"buildplane planforge resume --input <file> [--json]",
		"",
		"  Reconstructs the admitted plan cycle from the signed tape, verifies the",
		"  plan_admitted digest/idempotency against --input, skips already completed",
		"  activities, executes only the remaining suffix, and emits a missing",
		"  plan_receipt when the plan reaches a terminal state.",
		"",
		"  Options:",
		"    --input <file>  Markdown PlanForge goal fixture to resume",
		"    --json          Prints the resume result (recorded/executed runs) as JSON",
		"",
		"buildplane planforge recover [--json]",
		"",
		"  Scans storage for orphaned `running` PlanForge dispatches (via the dispatch",
		"  manifest sidecar) and replays the signed tape to resume each, re-establishing",
		"  worker trust FROM THE TAPE and emitting any missing plan_receipt. The tape is",
		"  authoritative over the storage status field. No --input required.",
		"",
		"  Options:",
		"    --json          Prints the recovery result (per-plan status) as JSON",
		"",
		"buildplane planforge plan --roadmap <file> --out <plan.md> --trusted-base <sha> [--remote <url>] [--json]",
		"",
		"  Reads the L0 tape's completed roadmap slices, selects the next eligible",
		"  slice whose dependencies are satisfied, deterministically emits its plan.md",
		"  in the PlanForge ## Tasks grammar, and validates it. Writes the plan.md and",
		"  exits 0 iff the emitted plan validates PASS. The --once loop path uses this",
		"  deterministic emitter; the LLM planning-worker path is gated behind a later flag.",
		"",
		"  Options:",
		"    --roadmap <file>     Machine-readable roadmap (default docs/roadmap.json)",
		"    --out <plan.md>      Required; where to write the emitted plan.md",
		"    --trusted-base <sha> Required; the trusted base commit recorded in the plan",
		"    --remote <url>       Repository remote (default the buildplane origin)",
		"    --json               Prints the proposal (slice id + status) as JSON",
		"",
		"buildplane planforge authorize-envelope --milestone <m> --side-effects code-edit --path-globs '<csv>' --max-iterations N --token-budget N --verification-cmds '<csv>' --expires-at <rfc3339> --approve --operator <id> [--json]",
		"",
		"  Records a one-time operator-authorized bounded envelope as a signed",
		"  operator_decision_recorded event (subject=authorize-envelope, kernel key).",
		"  The supervisor auto-admits a planner proposal iff it is a SUBSET of this",
		"  envelope. Fails closed without --approve/--operator. Idempotent on the",
		"  envelope digest: re-authorizing the identical envelope is a no-op.",
		"",
		"  Options:",
		"    --milestone <m>         Required; roadmap milestone the envelope authorizes",
		"    --side-effects <csv>    Required; allowed side-effect kinds (e.g. code-edit)",
		"    --path-globs <csv>      Required; allowed worktree path globs",
		"    --max-iterations N      Required; positive cap on loop iterations",
		"    --token-budget N        Required; positive cumulative token budget",
		"    --verification-cmds <csv>  Required; allowed verification command argv0s",
		"    --expires-at <rfc3339>  Required; envelope expiry instant",
		"    --approve               Required; explicit operator approval to sign",
		"    --operator <id>         Required; deciding operator identity (decided_by)",
		"    --json                  Prints the authorization result as JSON",
		"",
		"buildplane planforge loop [--once | --max-iterations=N] [--max-turns=N] [--max-tokens=N] [--wall-clock-ms=N] [--model <id>] [--reset] [--json]",
		"",
		"  Supervisor: drive plan -> dry-run -> envelope-check -> admit -> dispatch ->",
		"  accept -> merge -> re-anchor across iterations, persisting loop-state.json",
		"  atomically after every transition and resuming from a persisted state.",
		"  Stops on terminal condition / .buildplane/loop.stop / acceptance-FAIL /",
		"  dispatch-error (infra death: no side effects + non-zero exit) / envelope",
		"  breach / cumulative token budget / max-iterations / planner error.",
		"",
		"  Options:",
		"    --once                  Run exactly one slice (equivalent to --max-iterations=1)",
		"    --max-iterations=N      Cap the number of slices the loop builds",
		"    --max-turns=N           Lowered worker --max-turns (runaway guard; default 12)",
		"    --max-tokens=N          Per-iteration token budget for the abort guard",
		"    --wall-clock-ms=N       Per-iteration wall-clock cap for the abort guard",
		"    --model <id>            Worker model override for dispatched packets (default claude-sonnet-4)",
		"    --reset                 Clear .buildplane/loop-state.json and exit (re-fire a terminated loop)",
		"    --json                  Prints the loop summary as JSON",
	];
}

function formatVerifyHelp(): string[] {
	return [
		"buildplane verify --run <run-id> [--json]",
		"",
		"  Computes the final receipt-backed verdict from verifier evidence,",
		"  policy approvals, blockers, and missing acceptance criteria.",
		"",
		"  Options:",
		"    --run <id>   Run id to verify",
		"    --json       Print the verdict report as JSON",
	];
}

function formatEvidenceHelp(): string[] {
	return [
		"buildplane evidence export --run <run-id> --out <file> [--json]",
		"",
		"  Exports a Mission Control run_bundle fixture with worker claims,",
		"  verifier receipts, artifacts, and final halt evidence kept distinct.",
		"",
		"  Options:",
		"    --run <id>   Run id to export",
		"    --out <file> Write bundle JSON to this path",
		"    --json       Also print the exported bundle JSON",
	];
}

function formatTraceHelp(): string[] {
	return [
		"buildplane trace export --run <run-id> --format otel-json --out <file> [--json]",
		"",
		"  Exports a local OpenTelemetry-shaped trace artifact from stored",
		"  run evidence. This command never sends telemetry to a vendor.",
		"",
		"  Options:",
		"    --run <id>           Run id to export",
		"    --format otel-json  Trace format; only otel-json is supported",
		"    --out <file>         Write trace JSON to this path",
		"    --json               Also print the export summary JSON",
	];
}

function formatMemoryPromoteHelp(): string[] {
	return [
		"buildplane memory promote --receipt <run-id> [--json]",
		"",
		"  Promotes eligible run learnings into durable structured memory only",
		"  after the cited run has a PASSED receipt-backed final verdict.",
		"  Raw logs and worker claims without accepted verifier receipts fail closed.",
		"",
		"  Options:",
		"    --receipt <id>  Accepted run receipt to cite as provenance",
		"    --json          Print machine-readable promotion report",
	];
}

function formatPrCheckHelp(): string[] {
	return [
		"buildplane pr-check dry-run --run <run-id> --repo <owner/repo> --sha <head-sha> [--json]",
		"buildplane pr-check publish --run <run-id> --repo <owner/repo> --sha <head-sha> --grant-file <file> --grant-id <id> [--json]",
		"",
		"  Builds the GitHub check-run payload from the receipt-backed final verdict.",
		"  dry-run never calls GitHub; publish requires an explicit matching capability grant.",
		"",
		"  Options:",
		"    --run <id>              Run id to verify and report",
		"    --repo <owner/repo>     GitHub repository target",
		"    --sha <head-sha>        Commit SHA for the check run",
		"    --name <name>           Check-run name (default: Buildplane)",
		"    --details-url <url>     Optional evidence URL for GitHub",
		"    --grant-file <file>     JSON file with capabilityGrants/grants",
		"    --grant-id <id>         Capability grant id required for publish",
		"    --credential-env <name> Environment variable for GitHub credential (default: GITHUB_TOKEN)",
		"    --json                  Print machine-readable result",
	];
}

function formatPrCommentHelp(): string[] {
	return [
		"buildplane pr-comment dry-run --run <run-id> --repo <owner/repo> --pr <number> --sha <head-sha> [--json]",
		"buildplane pr-comment publish --run <run-id> --repo <owner/repo> --pr <number> --sha <head-sha> --grant-file <file> --grant-id <id> [--json]",
		"",
		"  Builds a compact PR evidence comment from the receipt-backed final verdict.",
		"  dry-run never calls GitHub; publish requires an explicit matching capability grant.",
		"",
		"  Options:",
		"    --run <id>              Run id to verify and report",
		"    --repo <owner/repo>     GitHub repository target",
		"    --pr <number>           Pull request number for the comment target",
		"    --sha <head-sha>        Commit SHA represented by the evidence",
		"    --details-url <url>     Optional Run Inspector URL",
		"    --bundle-url <url>      Optional exported evidence bundle URL",
		"    --grant-file <file>     JSON file with capabilityGrants/grants",
		"    --grant-id <id>         Capability grant id required for publish",
		"    --credential-env <name> Environment variable for GitHub credential (default: GITHUB_TOKEN)",
		"    --json                  Print machine-readable result",
	];
}

function readFlag(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	const value = index === -1 ? undefined : args[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

function requireFlag(
	args: readonly string[],
	flag: string,
	label: string,
): string {
	const value = readFlag(args, flag);
	if (!value) {
		throw new Error(`Missing required ${label} argument.`);
	}
	return value;
}

function requireHeadSha(args: readonly string[]): string {
	const value = readFlag(args, "--sha") ?? readFlag(args, "--head-sha");
	if (!value) {
		throw new Error("Missing required --sha <head-sha> argument.");
	}
	return value;
}

function requirePrNumber(args: readonly string[]): number {
	const value = readFlag(args, "--pr") ?? readFlag(args, "--pr-number");
	if (!value) {
		throw new Error("Missing required --pr <number> argument.");
	}
	if (!/^[1-9][0-9]*$/.test(value)) {
		throw new Error(
			"PR number must be a positive decimal integer without leading zeroes.",
		);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(
			"PR number must be a positive decimal integer within JavaScript's safe integer range.",
		);
	}
	return parsed;
}

function isHelpRequested(args: readonly string[]): boolean {
	return args.includes("--help") || args.includes("-h") || args[0] === "help";
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
		runOptions?: {
			runId?: string;
			parentRunId?: string;
			strategyId?: string;
		},
	): {
		run: { id: string; status: string };
		receipt: unknown;
		decision: unknown;
	};
	runPacketAsync(
		packet: unknown,
		eventBus?: unknown,
		runOptions?: {
			runId?: string;
			parentRunId?: string;
			strategyId?: string;
		},
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
	recordOperatorDecision(input: RecordOperatorDecisionInput): Promise<void>;
	recoverPendingDecisions(): Promise<unknown>;
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

interface ToolRegistryTapeContext {
	readonly emitter: TapeEmitter;
	readonly runId: string;
}

function toolRegistryOptionsForPacket(
	packetUnknown: unknown,
	tape?: ToolRegistryTapeContext,
): ToolRegistryOptions | undefined {
	const packet = packetUnknown as {
		capability_bundle?: ToolRegistryOptions["capabilityBundle"];
		capability_bundle_digest?: string;
	};
	const bundle = packet.capability_bundle;
	const digest = packet.capability_bundle_digest;
	if (bundle === undefined && tape === undefined) {
		return undefined;
	}
	const onCapabilityDenied =
		tape && digest
			? (detail: { tool: string; reason: string; target: string }) => {
					emitCapabilityDenied(tape.emitter, {
						runId: tape.runId,
						bundleDigest: digest,
						...detail,
					});
				}
			: undefined;
	return {
		...(bundle !== undefined ? { capabilityBundle: bundle } : {}),
		...(onCapabilityDenied ? { onCapabilityDenied } : {}),
	};
}

/** Minimal async executor shape the runtime router dispatches to. */
interface RouterAsyncExecutor {
	executePacketAsync: (
		packet: unknown,
		root: string,
		eventBus: unknown,
		signal?: AbortSignal,
	) => Promise<unknown>;
}

/** Command (sync) executor the router uses for `execution` packets. */
interface RouterCommandExecutor {
	executePacket: (packet: unknown, root: string) => unknown;
}

export interface RuntimeRouterPorts {
	readonly commandExecutor: RouterCommandExecutor;
	readonly getClaudeExecutor: () => Promise<RouterAsyncExecutor>;
	readonly getCodexExecutor: () => Promise<RouterAsyncExecutor>;
	readonly getSdkExecutor: () => Promise<RouterAsyncExecutor>;
}

/**
 * Pure runtime router: routes a packet to the command executor (`execution`),
 * the claude-code worker, the codex worker, or the sdk executor by
 * `routingHints.preferredWorker`. The 4th `signal` arg threads the
 * orchestrator's budget AbortController through to the worker so the runaway
 * guard can abort a streaming model worker (GAP-7). Extracted so the routing +
 * signal-forwarding contract is unit-testable without a full orchestrator.
 */
export function buildRuntimeRouter(ports: RuntimeRouterPorts) {
	const {
		commandExecutor,
		getClaudeExecutor,
		getCodexExecutor,
		getSdkExecutor,
	} = ports;
	return {
		executePacket(packet: unknown, root: string) {
			const p = packet as { execution?: unknown };
			if (p.execution) return commandExecutor.executePacket(packet, root);
			throw new Error("Model packets require async execution path");
		},
		async executePacketAsync(
			packet: unknown,
			root: string,
			bus: unknown,
			signal?: AbortSignal,
		) {
			const p = packet as {
				execution?: unknown;
				routingHints?: { preferredWorker?: string };
			};
			if (p.execution) {
				const receipt = commandExecutor.executePacket(packet, root) as {
					exitCode: number;
					outputChecks: Array<{ path: string; exists: boolean }>;
				};
				if (
					typeof bus === "object" &&
					bus !== null &&
					typeof (bus as { emit?: unknown }).emit === "function"
				) {
					(
						bus as {
							emit: (event: {
								kind: "command-execution-complete";
								timestamp: string;
								exitCode: number;
								outputChecks: Array<{ path: string; exists: boolean }>;
							}) => void;
						}
					).emit({
						kind: "command-execution-complete",
						timestamp: new Date().toISOString(),
						exitCode: receipt.exitCode,
						outputChecks: receipt.outputChecks.map((check) => ({
							path: check.path,
							exists: check.exists,
						})),
					});
				}
				return receipt;
			}
			if (p.routingHints?.preferredWorker === "claude-code") {
				return (await getClaudeExecutor()).executePacketAsync(
					packet,
					root,
					bus,
					signal,
				);
			}
			if (p.routingHints?.preferredWorker === "codex") {
				return (await getCodexExecutor()).executePacketAsync(
					packet,
					root,
					bus,
					signal,
				);
			}
			return (await getSdkExecutor()).executePacketAsync(
				packet,
				root,
				bus,
				signal,
			);
		},
	};
}

async function loadCliOrchestrator(
	projectRoot: string,
	opts?: {
		readonly ledgerActivityPort?: LedgerActivityPort;
		readonly profileRegistry?: BuildplaneProfileRegistryPort;
		readonly acceptancePort?: BuildplaneAcceptancePort;
		readonly operatorDecisionPort?: OperatorDecisionPort;
		readonly provisionDeps?: (workspacePath: string) => void;
		/** Lowered worker turn cap for the supervisor loop's runaway guard. */
		readonly claudeMaxTurns?: number;
		/**
		 * Per-tool-call sink threaded into the Claude Code executor so the worker's
		 * `tool_use`/`tool_result` stream blocks land on the signed tape (M6-S8).
		 * The run block binds the concrete ledger-backed sink after its emitter is
		 * spawned; this stable wrapper reads it lazily.
		 */
		readonly onClaudeToolEvent?: (event: ClaudeToolEvent) => void;
		/**
		 * Per-packet budget caps for the supervisor loop's runaway guard. When set,
		 * the orchestrator installs the budget subscription whose AbortController
		 * aborts a streaming model worker once it crosses maxTokens / maxComputeTimeMs.
		 * Resolved as the orchestrator's top-level budgets; a dispatched packet's
		 * acceptance profile carries no budgets, so it falls through to these.
		 */
		readonly budgets?: BudgetConstraints;
	},
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
			policy: {
				evaluateRun: (packet: unknown, receipt: unknown) => unknown;
				evaluateAcceptanceContract?: (
					contract: unknown,
					evidence: unknown,
				) => unknown;
				evaluateAcceptanceDiffScope?: (
					changedFiles: readonly string[],
					contract: unknown,
				) => unknown;
				evaluateBudgets?: (
					packet: unknown,
					usage: unknown,
					budgets?: unknown,
				) => unknown;
			};
			workspace?: unknown;
			admissionStore?: RunAdmissionStoreLike;
			eventBus?: unknown;
			memoryPort?: unknown;
			ledgerActivityPort?: unknown;
			profileRegistry?: BuildplaneProfileRegistryPort;
			acceptancePort?: BuildplaneAcceptancePort;
			operatorDecisionPort?: OperatorDecisionPort;
			provisionDeps?: (workspacePath: string) => void;
			budgets?: BudgetConstraints;
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
		evaluateAcceptanceContract: (
			contract: unknown,
			evidence: unknown,
		) => unknown;
		evaluateBudgets: (
			packet: unknown,
			usage: unknown,
			budgets?: unknown,
		) => unknown;
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
						signal?: AbortSignal,
					) => Promise<unknown>;
				};
				createClaudeCodeExecutor: (options?: {
					maxTurns?: number;
					onToolEvent?: (event: ClaudeToolEvent) => void;
				}) => {
					executePacket: (packet: unknown, root: string) => unknown;
					executePacketAsync: (
						packet: unknown,
						root: string,
						eventBus: unknown,
						signal?: AbortSignal,
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
					signal?: AbortSignal,
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
					signal?: AbortSignal,
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
					signal?: AbortSignal,
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
						signal?: AbortSignal,
					) => Promise<unknown>;
				};
				createClaudeCodeExecutor: (options?: {
					maxTurns?: number;
					onToolEvent?: (event: ClaudeToolEvent) => void;
				}) => {
					executePacket: (packet: unknown, root: string) => unknown;
					executePacketAsync: (
						packet: unknown,
						root: string,
						eventBus: unknown,
						signal?: AbortSignal,
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
			const claudeMaxTurns = opts?.claudeMaxTurns;
			const onClaudeToolEvent = opts?.onClaudeToolEvent;
			const executorOptions =
				claudeMaxTurns !== undefined || onClaudeToolEvent !== undefined
					? {
							...(claudeMaxTurns !== undefined
								? { maxTurns: claudeMaxTurns }
								: {}),
							...(onClaudeToolEvent !== undefined
								? { onToolEvent: onClaudeToolEvent }
								: {}),
						}
					: undefined;
			claudeExecutorPromise = loadAdaptersModels().then((mod) =>
				mod.createClaudeCodeExecutor(executorOptions),
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

	const runtimeRouter = buildRuntimeRouter({
		commandExecutor,
		getClaudeExecutor,
		getCodexExecutor,
		getSdkExecutor,
	});

	const orchestrator = kernel.createBuildplaneOrchestrator({
		projectRoot,
		storage: storage.createBuildplaneStorage(projectRoot),
		runtime: runtimeRouter,
		policy: {
			evaluateRun: policy.evaluateRun,
			evaluateAcceptanceContract: policy.evaluateAcceptanceContract,
			evaluateAcceptanceDiffScope: evaluateAcceptanceDiffScope as (
				changedFiles: readonly string[],
				contract: unknown,
			) => unknown,
			// Wired so the orchestrator's runaway-guard budget subscription can
			// evaluate mid-stream token/time usage against the loop guard's budgets.
			evaluateBudgets: policy.evaluateBudgets,
		},
		workspace: adaptersGit.createGitWorktreeAdapter(),
		admissionStore: createCliRunAdmissionStore(projectRoot),
		eventBus,
		memoryPort: orchestratorMemoryPortRef, // READ-WRITE port for post-run writes
		ledgerActivityPort: opts?.ledgerActivityPort,
		profileRegistry: opts?.profileRegistry,
		acceptancePort: opts?.acceptancePort,
		// Signed `operator_decision_recorded` emit path (M5-S4). Defaults to the
		// real ledger-backed port; tests inject a fake via opts.
		operatorDecisionPort:
			opts?.operatorDecisionPort ?? createOperatorDecisionPort(projectRoot),
		provisionDeps: opts?.provisionDeps,
		// Runaway-guard budgets (loop dispatch); undefined for non-loop callers.
		budgets: opts?.budgets,
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

type MemoryListPortLike = Pick<
	import("@buildplane/kernel").BuildplaneStoragePort,
	"listRepoFacts" | "listProcedures" | "listEvents"
>;

function validateMemoryListOptions(
	args: readonly string[],
	options: { valued: readonly string[] },
): { code: string; message: string } | undefined {
	const valuedConsumesNext = new Set<number>();
	for (const flag of options.valued) {
		const flagIdx = args.indexOf(flag);
		if (flagIdx < 0) {
			continue;
		}
		const value = args[flagIdx + 1];
		if (value === undefined || value.startsWith("--")) {
			return {
				code: "MISSING_ARGUMENT",
				message: `Missing value for ${flag}.`,
			};
		}
		valuedConsumesNext.add(flagIdx + 1);
	}
	const unsupported = args.filter((arg, index) => {
		if (arg === "--json" || options.valued.includes(arg)) {
			return false;
		}
		return !valuedConsumesNext.has(index);
	});
	if (unsupported.length > 0) {
		return {
			code: "UNSUPPORTED_ARGUMENTS",
			message: `Unsupported arguments: ${unsupported.join(" ")}.`,
		};
	}
	return undefined;
}

async function loadStoragePort(
	projectRoot: string,
): Promise<MemoryListPortLike | undefined> {
	try {
		const { resolveProjectLayout, createBuildplaneStorage } = (await import(
			"@buildplane/storage"
		)) as unknown as {
			resolveProjectLayout: (root: string) => { stateDbPath: string };
			createBuildplaneStorage: (root: string) => MemoryListPortLike;
		};
		const layout = resolveProjectLayout(projectRoot);
		if (existsSync(layout.stateDbPath)) {
			return createBuildplaneStorage(projectRoot);
		}
	} catch {
		// Storage port unavailable (pre-cold-path project)
	}
	return undefined;
}

interface VerifiedMemoryPromotionRecord {
	readonly memoryType: "repo-fact";
	readonly factKey: string;
	readonly sourceRunId: string;
	readonly createdBy: "system";
	readonly id?: string;
	readonly status: "promoted" | "skipped";
	readonly reason?: string;
}

interface VerifiedMemoryPromotionReport {
	readonly receiptId: string;
	readonly verdict: string;
	readonly promoted: number;
	readonly skipped: number;
	readonly records: readonly VerifiedMemoryPromotionRecord[];
}

interface ReceiptNotAcceptedReport {
	readonly error: { readonly code: string; readonly message: string };
	readonly receipt: Record<string, unknown>;
}

interface ReceiptLearningRow {
	readonly id: string;
	readonly run_id: string;
	readonly scope: string;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly status: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly seen_count: number;
	readonly promoted_from_id: string | null;
	readonly source_run_id: string | null;
}

interface ReceiptLearningCandidate {
	readonly id: string;
	readonly runId: string;
	readonly scope: string;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly status: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly seenCount: number;
	readonly promotedFromId?: string;
	readonly sourceRunId?: string;
}

function escapeUnescapedCharacter(
	value: string,
	character: string,
	escapedCharacter: string,
): string {
	let escaped = "";
	for (let index = 0; index < value.length; index += 1) {
		const current = value[index];
		if (current === character && value[index - 1] !== "\\") {
			escaped += escapedCharacter;
		} else {
			escaped += current;
		}
	}
	return escaped;
}

function sanitizeVerifiedMemoryText(value: string): string {
	const ansiEscapePattern = new RegExp(
		`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
		"g",
	);
	const withoutAnsi = value.replace(ansiEscapePattern, " ");
	let result = "";
	for (const character of withoutAnsi) {
		const code = character.charCodeAt(0);
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			result += " ";
		} else {
			result += character;
		}
	}
	const sanitized = result
		.replace(/@(?!\u200b)/g, "@\u200b")
		.split("`")
		.join("'")
		.split("-->")
		.join("-\\->")
		.split("<!--")
		.join("<\\!--")
		.replace(/\s+/g, " ")
		.trim();
	return escapeUnescapedCharacter(sanitized, "|", "\\|");
}

function normalizeReceiptLearningFactKey(title: string): string {
	return sanitizeVerifiedMemoryText(title);
}

function normalizeReceiptLearningFactValue(body: string): string {
	return sanitizeVerifiedMemoryText(body);
}

function formatMemoryPromotionHuman(
	report: VerifiedMemoryPromotionReport,
): string[] {
	return [
		"memory-promote: completed",
		`receipt-id: ${sanitizeVerifiedMemoryText(report.receiptId)}`,
		`verdict: ${sanitizeVerifiedMemoryText(report.verdict)}`,
		`promoted: ${report.promoted}`,
		`skipped: ${report.skipped}`,
		...report.records.map(
			(record) =>
				`- ${sanitizeVerifiedMemoryText(record.status)}: ${sanitizeVerifiedMemoryText(record.memoryType)} ${sanitizeVerifiedMemoryText(record.factKey)}` +
				(record.reason
					? ` (${sanitizeVerifiedMemoryText(record.reason)})`
					: ""),
		),
	];
}

async function fetchReceiptLearningCandidates(
	projectRoot: string,
	runId: string,
	storageModule: {
		resolveProjectLayout: (root: string) => { stateDbPath: string };
	},
): Promise<readonly ReceiptLearningCandidate[]> {
	const { DatabaseSync } = await import("node:sqlite");
	const layout = storageModule.resolveProjectLayout(projectRoot);
	if (!existsSync(layout.stateDbPath)) {
		return [];
	}
	const db = new DatabaseSync(layout.stateDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT id, run_id, scope, kind, title, body, status, created_at, updated_at, seen_count, promoted_from_id, source_run_id
           FROM run_learnings
           WHERE run_id = ? AND status = 'active'
           ORDER BY created_at ASC`,
			)
			.all(runId) as unknown as ReceiptLearningRow[];
		return rows.map((row) => ({
			id: row.id,
			runId: row.run_id,
			scope: row.scope,
			kind: row.kind,
			title: row.title,
			body: row.body,
			status: row.status,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			seenCount: row.seen_count,
			promotedFromId: row.promoted_from_id ?? undefined,
			sourceRunId: row.source_run_id ?? undefined,
		}));
	} catch {
		return [];
	} finally {
		db.close();
	}
}

function createSkippedMemoryPromotionRecord(
	learning: Pick<ReceiptLearningCandidate, "title">,
	receiptRunId: string,
	reason: string,
): VerifiedMemoryPromotionRecord {
	return {
		memoryType: "repo-fact",
		factKey:
			normalizeReceiptLearningFactKey(learning.title) || "(empty fact key)",
		sourceRunId: receiptRunId,
		createdBy: "system",
		status: "skipped",
		reason,
	};
}

async function promoteMemoryFromReceipt(
	projectRoot: string,
	receiptId: string,
): Promise<
	| { readonly ok: true; readonly report: VerifiedMemoryPromotionReport }
	| { readonly ok: false; readonly report: ReceiptNotAcceptedReport }
> {
	const storageModule = (await cliImport("@buildplane/storage")) as unknown as {
		createBuildplaneStorage: (root: string) => {
			getRepoFact: (
				factKey: string,
				options?: { scopeType?: string; scopeKey?: string },
			) => {
				id: string;
				factKey: string;
				factValue: unknown;
				provenance: { sourceRunId?: string; createdBy: string };
			} | null;
			upsertRepoFact: (input: {
				factKey: string;
				factValue: unknown;
				valueType: string;
				scopeType?: string;
				confidence?: number;
				createdBy: "system";
				sourceRunId?: string;
				branch?: string;
				commitSha?: string;
			}) => {
				id: string;
				factKey: string;
				memoryType: "repo-fact";
				provenance: { sourceRunId?: string; createdBy: string };
			};
		};
		resolveProjectLayout: (root: string) => { stateDbPath: string };
		verifyRunFinalVerdict: (
			root: string,
			options: { runId: string },
		) => { verdict: string; runId: string } & Record<string, unknown>;
	};
	const receipt = storageModule.verifyRunFinalVerdict(projectRoot, {
		runId: receiptId,
	});
	if (receipt.verdict !== "PASSED") {
		return {
			ok: false,
			report: {
				...formatJsonError(
					"RECEIPT_NOT_ACCEPTED",
					`Receipt ${receiptId} has verdict ${receipt.verdict}; only PASSED receipts can promote memory.`,
				),
				receipt,
			},
		};
	}

	const learnings = await fetchReceiptLearningCandidates(
		projectRoot,
		receipt.runId,
		storageModule,
	);
	const storage = storageModule.createBuildplaneStorage(projectRoot);
	const branch = resolveCurrentBranch(projectRoot);
	const commitSha = resolveCurrentCommit(projectRoot);
	const records: VerifiedMemoryPromotionRecord[] = [];

	for (const learning of learnings) {
		if (learning.kind !== "fact") {
			records.push(
				createSkippedMemoryPromotionRecord(
					learning,
					receipt.runId,
					`unsupported learning kind: ${learning.kind}`,
				),
			);
			continue;
		}
		if (learning.promotedFromId || learning.sourceRunId) {
			records.push(
				createSkippedMemoryPromotionRecord(
					learning,
					receipt.runId,
					"derived learning lacks direct receipt binding",
				),
			);
			continue;
		}
		if (learning.seenCount !== 1 || learning.createdAt !== learning.updatedAt) {
			records.push(
				createSkippedMemoryPromotionRecord(
					learning,
					receipt.runId,
					"learning changed after receipt capture",
				),
			);
			continue;
		}
		const factKey = normalizeReceiptLearningFactKey(learning.title);
		if (!factKey) {
			records.push(
				createSkippedMemoryPromotionRecord(
					learning,
					receipt.runId,
					"empty fact key",
				),
			);
			continue;
		}
		const factValue = normalizeReceiptLearningFactValue(learning.body);
		if (!factValue) {
			records.push(
				createSkippedMemoryPromotionRecord(
					learning,
					receipt.runId,
					"empty fact value",
				),
			);
			continue;
		}
		const existing = storage.getRepoFact(factKey, { scopeType: "repo" });
		if (existing?.provenance.sourceRunId === receipt.runId) {
			records.push({
				id: existing.id,
				memoryType: "repo-fact",
				factKey,
				sourceRunId: receipt.runId,
				createdBy: "system",
				status: "skipped",
				reason: "already promoted from receipt",
			});
			continue;
		}
		if (existing) {
			records.push({
				id: existing.id,
				memoryType: "repo-fact",
				factKey,
				sourceRunId: receipt.runId,
				createdBy: "system",
				status: "skipped",
				reason: "active fact exists from different provenance",
			});
			continue;
		}
		const promoted = storage.upsertRepoFact({
			factKey,
			factValue,
			valueType: "string",
			scopeType: "repo",
			confidence: 1,
			createdBy: "system",
			sourceRunId: receipt.runId,
			branch,
			commitSha,
		});
		records.push({
			id: promoted.id,
			memoryType: "repo-fact",
			factKey: promoted.factKey,
			sourceRunId: receipt.runId,
			createdBy: "system",
			status: "promoted",
		});
	}

	return {
		ok: true,
		report: {
			receiptId: receipt.runId,
			verdict: receipt.verdict,
			promoted: records.filter((record) => record.status === "promoted").length,
			skipped: records.filter((record) => record.status === "skipped").length,
			records,
		},
	};
}

async function loadPacket(packetPath: string): Promise<unknown> {
	const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
		parseUnitPacket: (input: string) => unknown;
	};

	return kernel.parseUnitPacket(readFileSync(packetPath, "utf8"));
}

const NATIVE_COMMAND_DISPATCH_ERROR_CODE = "NATIVE_COMMAND_DISPATCH_FAILED";
const NATIVE_COMMAND_DISPATCH_HINT =
	"Hint: build the native binary with `cargo build --manifest-path native/Cargo.toml -p bp-cli`, set BUILDPLANE_NATIVE_BIN, install a package with a bundled native binary, or ensure `buildplane-native` is on PATH.";

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

function currentPackagedNativeTarget():
	| { readonly binaryName: string; readonly platform: "linux-x64" }
	| undefined {
	if (process.platform !== "linux" || process.arch !== "x64") {
		return undefined;
	}

	return {
		binaryName: "buildplane-native",
		platform: "linux-x64",
	};
}

function isExecutableFile(path: string): boolean {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) {
			return false;
		}
		if (process.platform === "win32") {
			return true;
		}
		return (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function resolvePackagedNativeBinary(): string | undefined {
	const target = currentPackagedNativeTarget();
	if (!target) {
		return undefined;
	}

	const candidate = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"vendor",
		"native",
		target.platform,
		target.binaryName,
	);
	return isExecutableFile(candidate) ? candidate : undefined;
}

function resolveNativeBinary(cwd: string): string {
	const explicit = process.env.BUILDPLANE_NATIVE_BIN;
	if (explicit) {
		return explicit;
	}

	const packaged = resolvePackagedNativeBinary();
	if (packaged) {
		return packaged;
	}

	const targets =
		process.platform === "win32"
			? ["buildplane-native.exe", "buildplane-native"]
			: ["buildplane-native"];
	for (const target of targets) {
		for (const candidate of [
			resolve(cwd, "native", "target", "debug", target),
			resolve(cwd, "native", "target", "release", target),
		]) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return "buildplane-native";
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
	vcr: boolean;
	vcrMiss: "fail" | "reexecute";
}

function parseForkArgs(
	rest: string[],
): { ok: true; value: ForkArgs } | { ok: false; error: string } {
	let runId: string | undefined;
	let at: string | undefined;
	let workspace: string | undefined;
	let packet: string | undefined;
	let vcr = false;
	let vcrMiss: "fail" | "reexecute" = "fail";
	let vcrMissProvided = false;
	const setVcrMiss = (value: string | undefined): string | undefined => {
		if (!value || value.startsWith("--")) {
			return "missing --vcr-miss <fail|reexecute> value";
		}
		if (value === "reexecute") {
			vcrMiss = "reexecute";
			vcrMissProvided = true;
			return undefined;
		}
		if (value === "fail") {
			vcrMiss = "fail";
			vcrMissProvided = true;
			return undefined;
		}
		return "unsupported --vcr-miss value (expected fail or reexecute)";
	};
	let i = 0;
	while (i < rest.length) {
		const arg = rest[i];
		switch (arg) {
			case "--vcr":
				vcr = true;
				break;
			case "--vcr-miss":
				i += 1;
				{
					const error = setVcrMiss(rest[i]);
					if (error) {
						return { ok: false, error };
					}
				}
				break;
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
				if (arg?.startsWith("--vcr-miss=")) {
					const error = setVcrMiss(arg.slice("--vcr-miss=".length));
					if (error) {
						return { ok: false, error };
					}
				} else if (arg && !runId) {
					if (arg.startsWith("--")) {
						return { ok: false, error: `unknown argument: ${arg}` };
					}
					runId = arg;
				} else {
					return { ok: false, error: `unknown argument: ${arg}` };
				}
		}
		i += 1;
	}
	if (vcrMissProvided && !vcr) {
		return { ok: false, error: "--vcr-miss requires --vcr" };
	}
	if (!runId)
		return {
			ok: false,
			error: "missing parent run id (positional or --run-id)",
		};
	if (!at) return { ok: false, error: "missing --at <event-id>" };
	if (!packet) return { ok: false, error: "missing --packet <file>" };
	return { ok: true, value: { runId, at, workspace, packet, vcr, vcrMiss } };
}

function forkUsageText(): string {
	return `usage: buildplane fork <parent-run-id> --at <event-id> --packet <file> [--workspace <path>] [--vcr] [--vcr-miss <fail|reexecute>]

  Fork resumes from a unit boundary in a prior run with a replacement packet.
  The workspace git state must be clean before fork execution.
  Target event must be a unit_started event.

  --run-id       parent run id (or positional first arg)
  --at           parent unit_started event id to fork at
  --packet       path to the new packet json
  --workspace    workspace root (defaults to cwd)
  --vcr          reuse deterministic parent tool outputs when the tape matches
  --vcr-miss     fail (default) or reexecute with a visible miss receipt
`;
}

async function parsePlannedForkPacket(packetJson: unknown): Promise<unknown> {
	const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
		parseUnitPacket: (input: string) => unknown;
	};
	return kernel.parseUnitPacket(JSON.stringify(packetJson));
}

interface LedgerUnitContext {
	readonly unitId: string;
	readonly parentEventId: string;
}

function beginLedgerUnit(
	emitter: TapeEmitter,
	runId: string,
	ledgerWorkspacePath: string,
	unitId: string,
	unitKind: "command" | "model",
	parentEventId?: string | null,
): LedgerUnitContext {
	const unitStartedId = generateUuidV7();
	emitter.emit(
		"unit_started",
		{
			UnitStartedV1: {
				unit_id: unitId,
				parent_unit_id: null,
				unit_kind: unitKind,
				policy: {},
			},
		},
		{ id: unitStartedId, ...(parentEventId ? { parent: parentEventId } : {}) },
	);
	runGitCheckpoint({
		boundary: "pre-unit",
		runId,
		unitId,
		cwd: ledgerWorkspacePath,
		emitter,
		parentEventId: unitStartedId,
	});
	return { unitId, parentEventId: unitStartedId };
}

function completeLedgerUnit(
	emitter: TapeEmitter,
	runId: string,
	ledgerWorkspacePath: string,
	currentUnit: LedgerUnitContext | null,
	outcome: "passed" | "failed",
): null {
	if (!currentUnit) {
		return null;
	}
	runGitCheckpoint({
		boundary: "post-unit",
		runId,
		unitId: currentUnit.unitId,
		cwd: ledgerWorkspacePath,
		emitter,
		parentEventId: currentUnit.parentEventId,
	});
	emitter.emit(
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
	return null;
}

function emitLedgerRunStarted(
	emitter: TapeEmitter | null,
	packetHash: string,
	workspacePath: string,
	parentRunId: string | null,
	parentEventId?: string | null,
	gitHead = "",
): string | undefined {
	if (!emitter) {
		return undefined;
	}
	const runStartedId = generateUuidV7();
	emitter.emit(
		"run_started",
		{
			RunStartedV1: {
				packet_hash: packetHash,
				git_head: gitHead,
				workspace_path: workspacePath,
				config: {},
				parent_run_id: parentRunId,
				...(parentEventId ? { parent_event_id: parentEventId } : {}),
			},
		},
		{ id: runStartedId },
	);
	return runStartedId;
}

function emitLedgerRunCompleted(
	emitter: TapeEmitter | null,
	outcome: "passed" | "failed",
	durationMs: number,
): void {
	if (!emitter) {
		return;
	}
	emitter.emit("run_completed", {
		RunCompletedV1: {
			outcome,
			duration_ms: durationMs,
			event_count: 0,
			unit_count: 1,
		},
	});
}

interface ForkVcrOptions {
	readonly enabled: boolean;
	readonly miss: "fail" | "reexecute";
	readonly parentRunId: string;
	readonly cassette?: ReadonlyMap<string, readonly VcrToolResult[]>;
	readonly outputStore?: ReadonlyMap<string, Buffer>;
}

interface VcrToolResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly output: unknown;
	readonly parentToolRequestId: string;
}

interface VcrEventRow {
	readonly id: string;
	readonly parent_event_id: string | null;
	readonly kind: string;
	readonly payload: string;
}

interface PendingVcrToolResult {
	readonly parentToolRequestId: string;
	readonly result: VcrToolResult;
}

function vcrOutputStoreRoot(workspace: string, runId: string): string {
	return resolve(workspace, ".buildplane", "vcr", runId, "outputs");
}

function vcrOutputKey(path: string): string {
	return path.replace(/\\/g, "/");
}

type ContainedPathResult =
	| { ok: true; path: string }
	| { ok: false; reason: string };

function hasWindowsAbsolutePrefix(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function isPathBelowRoot(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return relativePath !== "" && isPathAtOrBelowRoot(root, candidate);
}

function isPathAtOrBelowRoot(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`) &&
		!relativePath.startsWith("../") &&
		!relativePath.startsWith("..\\") &&
		!isAbsolute(relativePath) &&
		!hasWindowsAbsolutePrefix(relativePath)
	);
}

function ensureContainedDirectory(
	root: string,
	directory: string,
	realpath: (path: string) => string,
): ContainedPathResult {
	let existing = directory;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) {
			return { ok: false, reason: "output parent has no containing root" };
		}
		existing = parent;
	}
	if (!isPathAtOrBelowRoot(root, realpath(existing))) {
		return { ok: false, reason: "output parent escapes root" };
	}
	mkdirSync(directory, { recursive: true });
	if (!isPathAtOrBelowRoot(root, realpath(directory))) {
		return { ok: false, reason: "output parent escapes root" };
	}
	return { ok: true, path: directory };
}

function resolveContainedPath(root: string, path: string): ContainedPathResult {
	if (path.trim().length === 0) {
		return { ok: false, reason: "empty output path" };
	}
	if (path.includes("\0")) {
		return { ok: false, reason: "output path contains null byte" };
	}
	if (isAbsolute(path) || hasWindowsAbsolutePrefix(path)) {
		return { ok: false, reason: "absolute output path is not allowed" };
	}
	const rootPath = resolve(root);
	const candidate = resolve(rootPath, path);
	if (!isPathBelowRoot(rootPath, candidate)) {
		return { ok: false, reason: "output path escapes root" };
	}
	return { ok: true, path: candidate };
}

function loadForkVcrOutputStore(
	workspace: string,
	parentRunId: string,
): Map<string, Buffer> {
	const root = vcrOutputStoreRoot(workspace, parentRunId);
	const outputs = new Map<string, Buffer>();
	if (!existsSync(root)) {
		return outputs;
	}
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			outputs.set(
				vcrOutputKey(relative(root, entryPath)),
				readFileSync(entryPath),
			);
		}
	};
	visit(root);
	return outputs;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function toolRequestKey(request: {
	readonly tool_name?: string;
	readonly arguments?: unknown;
	readonly working_directory?: string;
}): string {
	return stableJson({
		arguments: request.arguments ?? {},
		tool_name: request.tool_name ?? "",
		working_directory: request.working_directory ?? "",
	});
}

function isVcrMissOutput(output: unknown): boolean {
	return (
		typeof output === "object" &&
		output !== null &&
		(output as { vcr?: unknown }).vcr === "miss"
	);
}

async function loadForkVcrCassette(
	workspace: string,
	parentRunId: string,
	forkPointEventId: string,
): Promise<Map<string, VcrToolResult[]>> {
	const eventsDbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	if (!existsSync(eventsDbPath)) {
		throw new Error(
			`VCR requested but parent ledger was not found at ${eventsDbPath}`,
		);
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				"SELECT id, parent_event_id, kind, payload FROM events WHERE run_id = ? AND kind IN ('tool_request', 'tool_result') ORDER BY occurred_at ASC, id ASC",
			)
			.all(parentRunId) as unknown as VcrEventRow[];
		const requestById = new Map<string, string>();
		const pendingResults: PendingVcrToolResult[] = [];
		const resultByKey = new Map<string, VcrToolResult[]>();
		for (const row of rows) {
			const payload = JSON.parse(row.payload) as {
				ToolRequestStoredV1?: {
					tool_name?: string;
					arguments?: unknown;
					working_directory?: string;
				};
				ToolResultV1?: {
					tool_request_id?: string;
					stdout?: string;
					stderr?: string;
					exit_code?: number | null;
					output?: unknown;
				};
			};
			if (row.kind === "tool_request" && payload.ToolRequestStoredV1) {
				if (row.parent_event_id !== forkPointEventId) {
					continue;
				}
				requestById.set(row.id, toolRequestKey(payload.ToolRequestStoredV1));
			}
			if (row.kind === "tool_result" && payload.ToolResultV1) {
				const parentToolRequestId = payload.ToolResultV1.tool_request_id;
				if (!parentToolRequestId) {
					continue;
				}
				if (isVcrMissOutput(payload.ToolResultV1.output)) {
					continue;
				}
				pendingResults.push({
					parentToolRequestId,
					result: {
						parentToolRequestId,
						stdout: payload.ToolResultV1.stdout ?? "",
						stderr: payload.ToolResultV1.stderr ?? "",
						exitCode: payload.ToolResultV1.exit_code ?? 0,
						output: payload.ToolResultV1.output ?? null,
					},
				});
			}
		}
		for (const pending of pendingResults) {
			const key = requestById.get(pending.parentToolRequestId);
			if (!key) {
				continue;
			}
			const results = resultByKey.get(key) ?? [];
			results.push(pending.result);
			resultByKey.set(key, results);
		}
		return resultByKey;
	} finally {
		db.close();
	}
}

async function runForkExecution(
	plan: ForkPlan,
	workspace: string,
	vcr: ForkVcrOptions,
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

	let exitCode = 1;
	let runStartEventId: string | undefined;
	let forkCurrentUnit: LedgerUnitContext | null = null;
	const getForkUnitCtx = () => forkCurrentUnit;
	const ledgerWorkspacePath = resolve(workspace);
	let vcrCassette = new Map<string, VcrToolResult[]>();
	let unsubscribeFork: (() => void) | null = null;
	let forkCommandExecutor:
		| {
				executePacket: (
					packetUnknown: unknown,
					executionRoot: string,
				) => unknown;
		  }
		| undefined;
	let originalForkExecutePacket:
		| ((packetUnknown: unknown, executionRoot: string) => unknown)
		| undefined;

	try {
		vcrCassette = new Map(
			vcr.enabled && vcr.cassette
				? [...vcr.cassette].map(([key, results]) => [key, [...results]])
				: undefined,
		);
		// Load a fresh orchestrator bundle scoped to the fork workspace.
		const bundle = await loadCliOrchestrator(workspace);
		const {
			orchestrator: forkOrchestrator,
			eventBus: forkEventBus,
			commandExecutor: loadedForkCommandExecutor,
		} = bundle;
		forkCommandExecutor = loadedForkCommandExecutor;

		// Wire bus subscription for unit-boundary events (mirrors run command handler).
		unsubscribeFork = forkEventBus.subscribe((evt: unknown) => {
			const e = evt as {
				kind?: string;
				unitId?: string;
				exitCode?: number;
				executionType?: "command" | "model";
			};
			switch (e.kind) {
				case "execution-started": {
					const unitId = e.unitId ?? "unknown";
					forkCurrentUnit = completeLedgerUnit(
						emitter,
						plan.new_run_id,
						ledgerWorkspacePath,
						forkCurrentUnit,
						"failed",
					);
					forkCurrentUnit = beginLedgerUnit(
						emitter,
						plan.new_run_id,
						ledgerWorkspacePath,
						unitId,
						e.executionType ?? "command",
						runStartEventId,
					);
					break;
				}
				case "command-execution-complete": {
					forkCurrentUnit = completeLedgerUnit(
						emitter,
						plan.new_run_id,
						ledgerWorkspacePath,
						forkCurrentUnit,
						e.exitCode === 0 ? "passed" : "failed",
					);
					break;
				}
				case "model-response-complete": {
					// Do not finalize the ledger unit here. Some async model executors can
					// emit a response event and still finish the overall run as failed
					// (for example budget-aborted streams). Leave the unit open so the
					// authoritative final run outcome can close it during cleanup.
					break;
				}
				case "execution-error": {
					forkCurrentUnit = completeLedgerUnit(
						emitter,
						plan.new_run_id,
						ledgerWorkspacePath,
						forkCurrentUnit,
						"failed",
					);
					break;
				}
				default:
					break;
			}
		});

		// Wrap the commandExecutor so tool calls are instrumented through the ledger.
		const {
			copyFileSync,
			existsSync: fsExistsSync,
			realpathSync: fsRealpathSync,
			statSync,
		} = await import("node:fs");
		const { resolve: pathResolve } = await import("node:path");
		const safeRealpath = (path: string): string => {
			try {
				return fsRealpathSync(path);
			} catch {
				return path;
			}
		};
		const fileDigest = (path: string): string =>
			`sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
		const vcrOutputStore = new Map(vcr.outputStore ?? []);
		const materializeVcrOutputChecks = (
			requiredOutputs: readonly string[],
			worktreeRoot: string,
			toolReqId: string,
		): {
			outputChecks: { path: string; exists: boolean }[];
			materializationReceipts: {
				path: string;
				status: string;
				source?: string;
				reason?: string;
			}[];
		} => {
			const realWorktreeRoot = safeRealpath(worktreeRoot);
			const parentWorkspaceRoot = safeRealpath(
				pathResolve(workspace, ".buildplane", "workspaces", vcr.parentRunId),
			);
			const parentOutputStoreRoot = safeRealpath(
				vcrOutputStoreRoot(workspace, vcr.parentRunId),
			);
			const sourceRoots = [
				{ label: "parent_vcr_output_store", root: parentOutputStoreRoot },
				{ label: "parent_run_workspace", root: parentWorkspaceRoot },
			];
			const materializationReceipts: {
				path: string;
				status: string;
				source?: string;
				reason?: string;
			}[] = [];
			const outputChecks = requiredOutputs.map((outputPath: string) => {
				const destinationResult = resolveContainedPath(
					realWorktreeRoot,
					outputPath,
				);
				if (!destinationResult.ok) {
					materializationReceipts.push({
						path: outputPath,
						status: "invalid-output-path",
						reason: destinationResult.reason,
					});
					return {
						path: outputPath,
						exists: false,
					};
				}
				const destination = destinationResult.path;
				try {
					const emitWorkspaceWrite = (hashBefore: string | null): void => {
						const copied = statSync(destination);
						emitter.emit(
							"workspace_write",
							{
								WorkspaceWriteV1: {
									tool_request_id: toolReqId,
									path: outputPath,
									hash_before: hashBefore,
									after: {
										status: "captured",
										data: {
											hash: fileDigest(destination),
											size_bytes: copied.size,
										},
									},
								},
							},
							{ parent: toolReqId },
						);
					};
					const prepareDestination = ():
						| { ok: true; hashBefore: string | null }
						| { ok: false; reason: string } => {
						const destinationParent = ensureContainedDirectory(
							realWorktreeRoot,
							dirname(destination),
							safeRealpath,
						);
						if (!destinationParent.ok) {
							return { ok: false, reason: destinationParent.reason };
						}
						const hashBefore =
							fsExistsSync(destination) && statSync(destination).isFile()
								? fileDigest(destination)
								: null;
						return { ok: true, hashBefore };
					};
					const recordedOutput = vcrOutputStore.get(vcrOutputKey(outputPath));
					if (recordedOutput !== undefined) {
						const prepared = prepareDestination();
						if (!prepared.ok) {
							materializationReceipts.push({
								path: outputPath,
								status: "failed",
								reason: prepared.reason,
							});
							return {
								path: outputPath,
								exists: false,
							};
						}
						writeFileSync(destination, recordedOutput);
						emitWorkspaceWrite(prepared.hashBefore);
						materializationReceipts.push({
							path: outputPath,
							status: "copied",
							source: "parent_vcr_output_store",
						});
						return {
							path: outputPath,
							exists: fsExistsSync(destination),
						};
					}
					const sourceMatch = sourceRoots
						.map((sourceRoot) => {
							const sourceResult = resolveContainedPath(
								sourceRoot.root,
								outputPath,
							);
							return sourceResult.ok
								? { ...sourceRoot, path: sourceResult.path }
								: undefined;
						})
						.find((source) => {
							if (!source) {
								return false;
							}
							if (
								!fsExistsSync(source.path) ||
								!statSync(source.path).isFile()
							) {
								return false;
							}
							return isPathBelowRoot(source.root, safeRealpath(source.path));
						});
					if (sourceMatch) {
						const prepared = prepareDestination();
						if (!prepared.ok) {
							materializationReceipts.push({
								path: outputPath,
								status: "failed",
								reason: prepared.reason,
							});
							return {
								path: outputPath,
								exists: false,
							};
						}
						copyFileSync(sourceMatch.path, destination);
						emitWorkspaceWrite(prepared.hashBefore);
						materializationReceipts.push({
							path: outputPath,
							status: "copied",
							source: sourceMatch.label,
						});
					} else if (!fsExistsSync(destination)) {
						materializationReceipts.push({
							path: outputPath,
							status: "missing-parent-output",
						});
					}
				} catch (error) {
					materializationReceipts.push({
						path: outputPath,
						status: "failed",
						reason: error instanceof Error ? error.message : String(error),
					});
				}
				return {
					path: outputPath,
					exists: fsExistsSync(destination),
				};
			});
			return { outputChecks, materializationReceipts };
		};
		originalForkExecutePacket = forkCommandExecutor.executePacket;
		forkCommandExecutor.executePacket = (
			packetUnknown: unknown,
			executionRoot: string,
		): unknown => {
			const p = packetUnknown as {
				execution: { command: string; args?: readonly string[]; cwd?: string };
				verification: { requiredOutputs: readonly string[] };
			};
			const worktreeRoot = pathResolve(executionRoot);
			const perCallRawRegistry = createToolRegistry(
				worktreeRoot,
				toolRegistryOptionsForPacket(packetUnknown, {
					emitter,
					runId: plan.new_run_id,
				}),
			);
			const perCallRegistry = wrapToolRegistryForLedger(
				perCallRawRegistry,
				emitter,
				getForkUnitCtx,
			);
			const effectiveCwd = p.execution.cwd
				? pathResolve(worktreeRoot, p.execution.cwd)
				: worktreeRoot;
			const startedAt = new Date().toISOString();
			const vcrKey = toolRequestKey({
				tool_name: "run_command",
				arguments: {
					command: p.execution.command,
					args: p.execution.args ?? [],
				},
				working_directory: p.execution.cwd ?? "",
			});
			if (vcr.enabled) {
				const ctx = getForkUnitCtx();
				const toolReqId = newEventId();
				emitter.emit(
					"tool_request",
					{
						ToolRequestStoredV1: {
							tool_name: "run_command",
							arguments: {
								command: p.execution.command,
								args: p.execution.args ?? [],
							},
							env: {
								redacted: true,
								hash: `sha256:${createHash("sha256")
									.update("{}")
									.digest("hex")}`,
								hint: "env_var",
							},
							working_directory: p.execution.cwd ?? "",
							unit_id: ctx?.unitId ?? "",
						},
					},
					{ parent: ctx?.parentEventId, id: toolReqId },
				);
				const recordedQueue = vcrCassette.get(vcrKey);
				const recorded = recordedQueue?.shift();
				if (recordedQueue?.length === 0) {
					vcrCassette.delete(vcrKey);
				}
				if (recorded) {
					const { outputChecks, materializationReceipts } =
						materializeVcrOutputChecks(
							p.verification.requiredOutputs,
							worktreeRoot,
							toolReqId,
						);
					emitter.emit(
						"tool_result",
						{
							ToolResultV1: {
								tool_request_id: toolReqId,
								stdout: recorded.stdout,
								stderr: recorded.stderr,
								exit_code: recorded.exitCode,
								output: {
									vcr: "hit",
									parent_tool_request_id: recorded.parentToolRequestId,
									parent_output: recorded.output,
									materialized_outputs: materializationReceipts,
								},
								duration_ms: 0,
							},
						},
						{ parent: toolReqId },
					);
					return {
						command: p.execution.command,
						args: [...(p.execution.args ?? [])],
						cwd: effectiveCwd,
						startedAt,
						completedAt: new Date().toISOString(),
						exitCode: recorded.exitCode,
						stdout: recorded.stdout,
						stderr: recorded.stderr,
						outputChecks,
					};
				}
				if (vcr.miss === "fail") {
					const reason = `VCR miss for deterministic tool call ${p.execution.command}`;
					emitter.emit(
						"tool_result",
						{
							ToolResultV1: {
								tool_request_id: toolReqId,
								stdout: "",
								stderr: reason,
								exit_code: 97,
								output: { vcr: "miss", policy: "fail" },
								duration_ms: 0,
							},
						},
						{ parent: toolReqId },
					);
					return {
						command: p.execution.command,
						args: [...(p.execution.args ?? [])],
						cwd: effectiveCwd,
						startedAt,
						completedAt: new Date().toISOString(),
						exitCode: 97,
						stdout: "",
						stderr: reason,
						outputChecks: p.verification.requiredOutputs.map(
							(outputPath: string) => ({
								path: outputPath,
								exists: (() => {
									const outputResult = resolveContainedPath(
										worktreeRoot,
										outputPath,
									);
									return outputResult.ok && fsExistsSync(outputResult.path);
								})(),
							}),
						),
					};
				}
				emitter.emit(
					"tool_result",
					{
						ToolResultV1: {
							tool_request_id: toolReqId,
							stdout: "",
							stderr: "VCR miss; explicit reexecute policy selected",
							exit_code: null,
							output: { vcr: "miss", policy: "reexecute" },
							duration_ms: 0,
						},
					},
					{ parent: toolReqId },
				);
			}
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
				outputChecks: p.verification.requiredOutputs.map(
					(outputPath: string) => ({
						path: outputPath,
						exists: (() => {
							const outputResult = resolveContainedPath(
								safeRealpath(worktreeRoot),
								outputPath,
							);
							return outputResult.ok && fsExistsSync(outputResult.path);
						})(),
					}),
				),
				...(vcr.enabled
					? {
							vcr: {
								miss: "reexecute",
								reason: "no deterministic parent tape match",
							},
						}
					: {}),
			};
		};

		const runStartMs = Date.now();
		const forkPacket = await parsePlannedForkPacket(plan.packet_json);
		const packetHash = `sha256:${createHash("sha256")
			.update(JSON.stringify(forkPacket))
			.digest("hex")}`;
		runStartEventId = emitLedgerRunStarted(
			emitter,
			packetHash,
			workspace,
			plan.parent_run_id,
			plan.parent_event_id,
			plan.checkout_sha,
		);

		// Invoke the orchestrator with the normalized fork packet.
		const orchResult = await forkOrchestrator.runPacketAsync(
			forkPacket as never,
			forkEventBus,
			{ runId: plan.new_run_id, parentRunId: plan.parent_run_id },
		);
		const status = (orchResult as { run?: { status?: string } }).run?.status;
		exitCode = status === "passed" ? 0 : 1;
		forkCurrentUnit = completeLedgerUnit(
			emitter,
			plan.new_run_id,
			ledgerWorkspacePath,
			forkCurrentUnit,
			exitCode === 0 ? "passed" : "failed",
		);

		// Emit run_completed.
		emitLedgerRunCompleted(
			emitter,
			exitCode === 0 ? "passed" : "failed",
			Date.now() - runStartMs,
		);
	} catch (err) {
		opts.stderr(`fork orchestrator error: ${String(err)}\n`);
		exitCode = 1;
		try {
			emitter.emit("run_failed", {
				RunFailedV1: {
					reason: String(err),
				},
			});
		} catch {
			// best-effort; original error already logged
		}
	} finally {
		unsubscribeFork?.();
		forkCurrentUnit = completeLedgerUnit(
			emitter,
			plan.new_run_id,
			ledgerWorkspacePath,
			forkCurrentUnit,
			exitCode === 0 ? "passed" : "failed",
		);
		if (forkCommandExecutor && originalForkExecutePacket) {
			forkCommandExecutor.executePacket = originalForkExecutePacket;
		}
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
	if (isHelpRequested(rest)) {
		opts.stdout(forkUsageText());
		return 0;
	}

	const args = parseForkArgs(rest);
	if (!args.ok) {
		opts.stderr(`buildplane fork: ${args.error}\n`);
		opts.stderr(forkUsageText());
		return 1;
	}

	const workspace = resolve(args.value.workspace ?? opts.cwd);
	// Resolve the packet path against the user's cwd BEFORE spawning the native
	// binary — the plan subprocess runs in `planSpawnCwd` (project root), not
	// `opts.cwd`, so a relative path like `./packet.json` would otherwise be
	// resolved from the wrong directory.
	const packet = resolve(opts.cwd, args.value.packet);
	const binary = resolveLedgerBinary(opts.cwd);
	let vcrCassette: Map<string, VcrToolResult[]> | undefined;
	let vcrOutputStore: Map<string, Buffer> | undefined;
	if (args.value.vcr) {
		try {
			vcrCassette = await loadForkVcrCassette(
				workspace,
				args.value.runId,
				args.value.at,
			);
			vcrOutputStore = loadForkVcrOutputStore(workspace, args.value.runId);
		} catch (error) {
			opts.stderr(`buildplane fork: ${String(error)}\n`);
			return 1;
		}
	}

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
		packet,
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
	const exitCode = await runForkExecution(
		plan,
		workspace,
		{
			enabled: args.value.vcr,
			miss: args.value.vcrMiss,
			parentRunId: args.value.runId,
			cassette: vcrCassette,
			outputStore: vcrOutputStore,
		},
		opts,
	);

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

// LedgerChild / deriveLedgerSpawnCwd / spawnLedgerSubprocess /
// PLANFORGE_KERNEL_SIGNING_KEY_ID / kernelSigningKeyPath / assertKernelSigningKey
// were lifted verbatim to ./ledger-emit.ts (GAP-10) so the new
// `planforge authorize-envelope` command can reuse them without importing
// run-cli.ts (circular). They are re-imported at the top of this file.

/**
 * Deterministic plan-scoped run id for a PlanForge admission, derived from the
 * plan's idempotency key so re-admitting the same plan resolves to the same run
 * — the idempotency check (and, later, dispatch) finds the admission by run id.
 * Syntactically a UUID, the only constraint the envelope `run_id` imposes.
 */
function planAdmitRunId(idempotencyKey: string): string {
	const h = createHash("sha256")
		.update(`planforge.admit.run:${idempotencyKey}`)
		.digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface PlanForgeDispatchManifest {
	readonly runId: string;
	readonly inputPath: string;
	readonly planId: string;
	readonly idempotencyKey: string;
	readonly createdAt: string;
	/**
	 * Worker model the loop dispatched with (`planforge loop --model <id>`),
	 * persisted so a crash-and-resume re-dispatches the remaining suffix on the
	 * same model. Absent when no override was set (the resume falls back to the
	 * dispatch default `DISPATCH_WORKER_MODEL`). `recover` has no `--input` flags,
	 * so the manifest is the only place the override survives a crash.
	 */
	readonly model?: string;
}

/**
 * Recover the worker-model override for a resuming/recovering dispatch from its
 * crash-recovery manifest (R-001): the matching manifest's `model`, or undefined
 * when none recorded (⇒ the dispatch default `DISPATCH_WORKER_MODEL`, unchanged).
 */
export function resolvePlanForgeResumeModel(
	manifests: readonly PlanForgeDispatchManifest[],
	runId: string,
): string | undefined {
	return manifests.find((m) => m.runId === runId)?.model;
}

function planForgeDispatchDir(workspace: string): string {
	return resolve(workspace, ".buildplane", "planforge", "dispatch");
}

/**
 * Persist a dispatch manifest BEFORE the run loop so a crash mid-dispatch leaves
 * an on-disk pointer from the (deterministic) tape runId back to the --input plan
 * file. Crash recovery cannot reconstruct the plan otherwise: storage `running`
 * rows carry kernel-generated run ids, not the tape runId, and no input path.
 */
export function writePlanForgeDispatchManifest(
	workspace: string,
	manifest: PlanForgeDispatchManifest,
): void {
	const dir = planForgeDispatchDir(workspace);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		resolve(dir, `${manifest.runId}.json`),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
}

export function readPlanForgeDispatchManifests(
	workspace: string,
): PlanForgeDispatchManifest[] {
	const dir = planForgeDispatchDir(workspace);
	if (!existsSync(dir)) {
		return [];
	}
	const manifests: PlanForgeDispatchManifest[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const parsed = JSON.parse(
			readFileSync(resolve(dir, entry), "utf8"),
		) as PlanForgeDispatchManifest;
		manifests.push(parsed);
	}
	return manifests;
}

/**
 * S7 crash-recovery scan: a dispatch manifest is orphaned iff a `running` storage
 * row's `unitId` begins with `${planId}:` (the dispatch died before a terminal
 * status) AND the tape carries no terminal `plan_receipt` for the manifest's tape
 * `runId`. The tape is authoritative over the storage status field, so a receipted
 * run is never an orphan even if a storage row is stale-`running`.
 */
export async function findOrphanedPlanForgeDispatches(
	workspace: string,
): Promise<PlanForgeDispatchManifest[]> {
	const manifests = readPlanForgeDispatchManifests(workspace);
	if (manifests.length === 0) {
		return [];
	}
	const { createBuildplaneStorage } = (await cliImport(
		"@buildplane/storage",
	)) as {
		createBuildplaneStorage: (root: string) => {
			listRunsByStatus: (status: string) => readonly { unitId: string }[];
		};
	};
	const storage = createBuildplaneStorage(workspace);
	const runningUnitIds = storage
		.listRunsByStatus("running")
		.map((r) => r.unitId);
	const orphans: PlanForgeDispatchManifest[] = [];
	for (const manifest of manifests) {
		const hasRunningTask = runningUnitIds.some((unitId) =>
			unitId.startsWith(`${manifest.planId}:`),
		);
		if (!hasRunningTask) {
			continue;
		}
		// Tape is authoritative: a terminal plan_receipt on this run_id means the
		// dispatch already finished even if a storage row is stale-`running`; not an
		// orphan. Probe events.db directly for ANY plan_receipt on the tape run_id
		// (independent of admission_event_id, which is unknown here).
		const eventsDbPath = resolve(
			workspace,
			".buildplane",
			"ledger",
			"events.db",
		);
		if (existsSync(eventsDbPath)) {
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(eventsDbPath, { readOnly: true });
			try {
				const receipted = db
					.prepare(
						"SELECT 1 FROM events WHERE run_id = ? AND kind = 'plan_receipt' LIMIT 1",
					)
					.get(manifest.runId);
				if (receipted) {
					continue;
				}
			} finally {
				db.close();
			}
		}
		orphans.push(manifest);
	}
	return orphans;
}

interface PlanAdmittedEventRow {
	id: string;
	payload: string;
}

interface PlanForgeEventRow {
	id: string;
	kind: string;
	payload: string;
}

interface KernelSignatureRow {
	actor_id?: string;
	key_id?: string;
	algorithm?: string;
}

interface VerifiedPlanAdmission {
	eventId: string;
	payload: PlanAdmittedV1;
}

interface RecordedPlanActivity {
	eventId: string;
	activityId: string;
	runId: string;
	resultDigest: string;
	result: unknown;
}

interface RecordedPlanReceipt {
	eventId: string;
	outcome: string;
}

interface PlanForgeReplayState {
	completedActivities: RecordedPlanActivity[];
	receipt?: RecordedPlanReceipt;
}

/**
 * Event id of an existing signed `plan_admitted` on the tape for `runId` whose
 * payload carries `idempotencyKey`, or undefined if none. Makes re-admitting the
 * same plan a no-op.
 *
 * This is a read-then-append check, sound under buildplane's single-writer /
 * single-operator model (the same assumption `bp-ledger`'s `validate_external_append`
 * documents — one `serve` connection writes a given run). Two *concurrent* admits
 * of the same plan could both pass this scan and append; that race is the ledger's
 * documented multi-writer boundary (a DB-level uniqueness constraint), deliberately
 * out of scope for M2-S3.
 */
async function findExistingPlanAdmitted(
	workspace: string,
	runId: string,
	idempotencyKey: string,
): Promise<string | undefined> {
	const eventsDbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	if (!existsSync(eventsDbPath)) {
		return undefined;
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				"SELECT id, payload FROM events WHERE run_id = ? AND kind = 'plan_admitted' ORDER BY id ASC",
			)
			.all(runId) as unknown as PlanAdmittedEventRow[];
		for (const row of rows) {
			const payload = JSON.parse(row.payload) as {
				PlanAdmittedV1?: { idempotency_key?: string };
			};
			if (payload.PlanAdmittedV1?.idempotency_key === idempotencyKey) {
				return row.id;
			}
		}
		return undefined;
	} finally {
		db.close();
	}
}

function assertKernelSignature(
	signature: KernelSignatureRow | undefined,
	eventId: string,
): void {
	if (
		signature?.actor_id !== "kernel" ||
		signature.key_id !== PLANFORGE_KERNEL_SIGNING_KEY_ID ||
		signature.algorithm !== "ed25519"
	) {
		throw new Error(
			`plan-not-admitted: plan_admitted event ${eventId} is not signed by kernel/${PLANFORGE_KERNEL_SIGNING_KEY_ID}.`,
		);
	}
}

function assertPlanAdmissionMatchesInput(
	payload: PlanAdmittedV1,
	plan: PlanForgePlan,
): void {
	const expected: Record<string, string> = {
		plan_id: plan.id,
		plan_digest: plan.receiptPreview.planDigest,
		input_digest: plan.receiptPreview.inputDigest,
		trusted_base: plan.trustedBase,
		idempotency_key: plan.idempotencyKey,
		authorized_next_step: PLANFORGE_AUTHORIZED_NEXT_STEP,
	};
	const actual = payload as unknown as Record<string, string>;
	for (const [field, expectedValue] of Object.entries(expected)) {
		if (actual[field] !== expectedValue) {
			throw new Error(
				`plan-admission-mismatch: signed plan_admitted ${field} does not match --input plan (expected ${expectedValue}, got ${String(actual[field])}).`,
			);
		}
	}
}

async function findVerifiedPlanAdmission(
	workspace: string,
	runId: string,
	plan: PlanForgePlan,
): Promise<VerifiedPlanAdmission | undefined> {
	const eventsDbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	if (!existsSync(eventsDbPath)) {
		return undefined;
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				"SELECT id, payload FROM events WHERE run_id = ? AND kind = 'plan_admitted' ORDER BY id ASC",
			)
			.all(runId) as unknown as PlanAdmittedEventRow[];
		for (const row of rows) {
			const payload = JSON.parse(row.payload) as {
				PlanAdmittedV1?: PlanAdmittedV1;
			};
			const admitted = payload.PlanAdmittedV1;
			if (!admitted || admitted.idempotency_key !== plan.idempotencyKey) {
				continue;
			}
			assertPlanAdmissionMatchesInput(admitted, plan);
			const signature = db
				.prepare(
					"SELECT actor_id, key_id, algorithm FROM event_signatures WHERE event_id = ?",
				)
				.get(row.id) as KernelSignatureRow | undefined;
			assertKernelSignature(signature, row.id);
			return { eventId: row.id, payload: admitted };
		}
		return undefined;
	} finally {
		db.close();
	}
}

async function readPlanForgeReplayState(
	workspace: string,
	runId: string,
	plan: PlanForgePlan,
	admittedEventId: string,
): Promise<PlanForgeReplayState> {
	const eventsDbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	if (!existsSync(eventsDbPath)) {
		return { completedActivities: [] };
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				"SELECT id, kind, payload FROM events WHERE run_id = ? AND kind IN ('activity_completed', 'plan_receipt') ORDER BY id ASC",
			)
			.all(runId) as unknown as PlanForgeEventRow[];
		const completedActivities: RecordedPlanActivity[] = [];
		let receipt: RecordedPlanReceipt | undefined;
		for (const row of rows) {
			const payload = JSON.parse(row.payload) as {
				ActivityCompletedV1?: {
					activity_id?: string;
					run_id?: string;
					result_digest?: string;
					result?: unknown;
				};
				PlanReceiptRecordedV1?: {
					plan_id?: string;
					admission_event_id?: string;
					outcome?: string;
				};
			};
			if (row.kind === "activity_completed") {
				const completed = payload.ActivityCompletedV1;
				if (!completed?.activity_id || !completed.run_id) {
					throw new Error(
						`plan-resume-invalid-tape: activity_completed ${row.id} is missing activity_id or run_id.`,
					);
				}
				completedActivities.push({
					eventId: row.id,
					activityId: completed.activity_id,
					runId: completed.run_id,
					resultDigest: completed.result_digest ?? "",
					result: completed.result,
				});
				continue;
			}
			const receiptPayload = payload.PlanReceiptRecordedV1;
			if (
				receiptPayload?.plan_id === plan.id &&
				receiptPayload.admission_event_id === admittedEventId
			) {
				receipt = {
					eventId: row.id,
					outcome: receiptPayload.outcome ?? "unknown",
				};
			}
		}
		return { completedActivities, receipt };
	} finally {
		db.close();
	}
}

/**
 * `buildplane planforge admit --input <file> --approve --operator <id>`:
 * record an operator-approved admission as a signed `plan_admitted` event on the
 * L0 tape (kernel key; the operator is the `decided_by` payload field). Fails
 * closed with no tape write on a non-PASS plan, a missing --approve, or a missing
 * operator. Idempotent: a plan already admitted is a no-op.
 */
async function runPlanForgeAdmitCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	if (!args.includes("--approve")) {
		throw new Error(
			"PlanForge admit requires explicit --approve to record a signed admission.",
		);
	}
	const operator = readFlag(args, "--operator")?.trim();
	if (!operator) {
		throw new Error(
			"PlanForge admit requires --operator <id> to record the deciding operator identity.",
		);
	}
	const inputPath = readFlag(args, "--input");
	if (!inputPath) {
		throw new Error(
			"Missing required --input <file> argument for PlanForge admit.",
		);
	}
	const jsonOut = args.includes("--json");

	const plan = createPlanForgeDryRunPlan(resolve(cwd, inputPath));
	const decidedBy = operator.startsWith("operator:")
		? operator
		: `operator:${operator}`;

	// Throws PlanForgeAdmitRejectedError on a non-PASS plan — fail closed BEFORE
	// resolving the binary or spawning the signed ledger.
	const payload: PlanAdmittedV1 = buildPlanAdmittedPayload({
		plan,
		decidedBy,
		decidedAt: new Date().toISOString(),
	});

	const workspace = resolve(cwd);
	const runId = planAdmitRunId(payload.idempotency_key);

	const existingEventId = await findExistingPlanAdmitted(
		workspace,
		runId,
		payload.idempotency_key,
	);
	if (existingEventId) {
		stdout(
			jsonOut
				? formatJson({
						status: "already_admitted",
						plan_id: payload.plan_id,
						idempotency_key: payload.idempotency_key,
						run_id: runId,
						event_id: existingEventId,
					})
				: `PlanForge plan ${payload.plan_id} is already admitted; no new tape event written.`,
		);
		return 0;
	}

	const binary = resolveLedgerBinary(cwd);
	const ledgerChild = spawnLedgerSubprocess(binary, runId, workspace, {
		sign: true,
		signingKeyId: PLANFORGE_KERNEL_SIGNING_KEY_ID,
	});

	let emitter: TapeEmitter;
	try {
		emitter = await createTapeEmitter({
			childStdin: ledgerChild.stdin,
			childStderr: ledgerChild.stderr,
			childExit: ledgerChild.exit,
			workspacePath: workspace,
			runId,
		});
	} catch (err) {
		if (ledgerChild.child.exitCode === null) {
			ledgerChild.child.kill("SIGTERM");
		}
		throw new Error(
			`PlanForge admit: signed ledger handshake failed: ${String(err)}`,
		);
	}

	try {
		emitter.emit("plan_admitted", { PlanAdmittedV1: payload });
		await emitter.flush();
		await emitter.close();
	} catch (err) {
		if (ledgerChild.child.exitCode === null) {
			ledgerChild.child.kill("SIGTERM");
		}
		throw new Error(
			`PlanForge admit: failed to append signed plan_admitted: ${String(err)}`,
		);
	}

	const eventId = emitter.stats().lastAckedEventId ?? undefined;
	stdout(
		jsonOut
			? formatJson({
					status: "admitted",
					plan_id: payload.plan_id,
					idempotency_key: payload.idempotency_key,
					decided_by: payload.decided_by,
					run_id: runId,
					event_id: eventId,
					payload,
				})
			: `Admitted PlanForge plan ${payload.plan_id} (signed plan_admitted on run ${runId}).`,
	);
	return 0;
}

const DEFAULT_DISPATCH_POLICY_PROFILE = "default";

/**
 * Runs `pnpm install --frozen-lockfile` inside an isolated git worktree so the
 * acceptance gate's `verificationCommands` (which invoke workspace tooling) have
 * their binaries and packages available. Synchronous to match the existing sync
 * git operations in `prepareRun`. Throws on a non-zero exit (or a spawn error)
 * with captured stderr so the orchestrator can surface a
 * `workspace-provision-failed` infrastructure failure and retain the worktree.
 */
export function provisionWorktreeDeps(workspacePath: string): void {
	const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
		cwd: workspacePath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) {
		throw new Error(
			`pnpm install failed in worktree ${workspacePath}: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		const detail = (result.stderr ?? result.stdout ?? "").trim();
		throw new Error(
			`pnpm install failed in worktree ${workspacePath} (exit ${
				result.status ?? "null"
			}): ${detail}`,
		);
	}
}

/**
 * Declared side-effect scopes for the plan receipt (M2-S6, D4): the union of every
 * task's `allowedSideEffects`, deduped and stably ordered. Declared scopes are the
 * deterministic S6 grain; reconciling observed `workspace_write` events is M4 work.
 */
function collectDeclaredSideEffects(plan: PlanForgePlan): string[] {
	const scopes = new Set<string>();
	for (const task of plan.tasks) {
		for (const scope of task.allowedSideEffects) {
			scopes.add(scope);
		}
	}
	return [...scopes].sort();
}

interface PlanForgeResumeRunResult {
	task: string;
	run_id: string;
	status: string;
	source: "recorded" | "executed";
	activity_id?: string;
	completed_event_id?: string;
}

function recordedActivityStatus(result: unknown): string {
	if (result && typeof result === "object") {
		const record = result as { exitCode?: unknown; status?: unknown };
		if (typeof record.exitCode === "number") {
			return record.exitCode === 0 ? "passed" : "failed";
		}
		if (typeof record.status === "string") {
			return record.status;
		}
	}
	return "unknown";
}

function isPassedPlanForgeRun(status: string): boolean {
	return status === "passed";
}

export async function emitPlanForgeTerminalReceipt(input: {
	emitter: TapeEmitter;
	workspace: string;
	runId: string;
	plan: PlanForgePlan;
	admittedEventId: string;
	outcome: "completed" | "failed";
	result: unknown;
}): Promise<void> {
	// Dedup-on-append (D5/S7): a crash between emitting and flushing the receipt
	// must not double-receipt on resume. The tape is authoritative — if a
	// plan_receipt for this plan identity already exists on the run, the prior
	// emit succeeded. The receipt is keyed on the tape `run_id`, which is the
	// deterministic `planAdmitRunId(idempotency_key)` (a 1:1 function of the
	// idempotency key), further disambiguated by the payload's plan_id +
	// admission_event_id. The read-path `already_receipted` short-circuit covers
	// the durable case; this closes the partial-flush race it cannot see.
	if (
		await planForgeReceiptExists(
			input.workspace,
			input.runId,
			input.plan.id,
			input.admittedEventId,
		)
	) {
		return;
	}
	await createLedgerReceiptPort(input.emitter).emitPlanReceipt(
		buildPlanReceiptPayload({
			planId: input.plan.id,
			admissionEventId: input.admittedEventId,
			outcome: input.outcome,
			sideEffects: collectDeclaredSideEffects(input.plan),
			result: input.result,
			decidedAt: new Date().toISOString(),
		}),
	);
}

/**
 * True iff the signed tape already carries a `plan_receipt` for this plan
 * identity on `runId`. Direct `node:sqlite` probe on `events.db` — the dedup key
 * is the deterministic tape `run_id` (derived 1:1 from `idempotency_key`), with
 * the payload's `plan_id` + `admission_event_id` disambiguating within the run.
 */
export async function planForgeReceiptExists(
	workspace: string,
	runId: string,
	planId: string,
	admittedEventId: string,
): Promise<boolean> {
	const eventsDbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	if (!existsSync(eventsDbPath)) {
		return false;
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const row = db
			.prepare(
				"SELECT payload FROM events WHERE run_id = ? AND kind = 'plan_receipt' LIMIT 1",
			)
			.get(runId) as { payload: string } | undefined;
		if (!row) {
			return false;
		}
		const payload = JSON.parse(row.payload) as {
			PlanReceiptRecordedV1?: {
				plan_id?: string;
				admission_event_id?: string;
			};
		};
		const receipt = payload.PlanReceiptRecordedV1;
		return (
			receipt?.plan_id === planId &&
			receipt.admission_event_id === admittedEventId
		);
	} finally {
		db.close();
	}
}

/**
 * Persist a structured plan summary as a searchable document after `plan_receipt`,
 * so the supervisor (GAP-7) can inject it as `TaskIntent.context.priorWork` into the
 * next iteration's packet. Best-effort metadata; the caller wraps this in its own
 * try/catch so a storage failure cannot shadow the signed receipt flush. No-op when
 * storage is unavailable (pre-cold-path project).
 */
export function writePlanSummaryToStorage(
	storage: Pick<BuildplaneStoragePort, "createSearchableDocument"> | undefined,
	plan: PlanForgePlan,
	runs: ReadonlyArray<{ task: string; status: string }>,
	outcome: "completed" | "failed",
	mergedSha?: string,
): void {
	if (!storage) {
		return;
	}
	const summary: PlanSummary = summarizePlanReceipt(
		plan,
		runs,
		outcome,
		mergedSha,
	);
	storage.createSearchableDocument({
		sourceTable: "planforge_receipts",
		sourceId: plan.id,
		documentKind: "plan-summary",
		title: plan.title,
		bodyText: formatPriorWorkEntry(summary),
		metadata: {
			planId: summary.planId,
			outcome: summary.outcome,
			taskCount: summary.taskCount,
			passedCount: summary.passedCount,
			mergedSha: summary.mergedSha,
			decidedAt: summary.decidedAt,
		},
	});
}

/**
 * Load the full Buildplane storage port for plan-summary persistence. Unlike
 * `loadStoragePort` (narrowed to memory-list reads), this exposes
 * `createSearchableDocument`. Returns undefined for a pre-cold-path project.
 */
async function loadSearchableDocumentStoragePort(
	projectRoot: string,
): Promise<
	Pick<BuildplaneStoragePort, "createSearchableDocument"> | undefined
> {
	try {
		const { resolveProjectLayout, createBuildplaneStorage } = (await import(
			"@buildplane/storage"
		)) as unknown as {
			resolveProjectLayout: (root: string) => { stateDbPath: string };
			createBuildplaneStorage: (
				root: string,
			) => Pick<BuildplaneStoragePort, "createSearchableDocument">;
		};
		const layout = resolveProjectLayout(projectRoot);
		if (existsSync(layout.stateDbPath)) {
			return createBuildplaneStorage(projectRoot);
		}
	} catch {
		// Storage port unavailable (pre-cold-path project)
	}
	return undefined;
}

/**
 * `buildplane planforge dispatch --input <file>`: dispatch an operator-admitted
 * plan as one run per PlanForgeTask. Fails closed (exit 1, `plan-not-admitted`)
 * when no signed plan_admitted exists on the tape — a fast CLI-side pre-check; the
 * kernel admission gate is the load-bearing enforcement. Tasks run sequentially so
 * a dependent task does not start if its predecessor fails.
 */
export interface PlanForgeDispatchOutcome {
	readonly allPassed: boolean;
	readonly mergedHeadSha: string | null;
	/** Real total token usage (input + output) summed across this dispatch's tasks. */
	readonly tokenUsage: number;
	/**
	 * The FAILING task's OWN side-effect evidence — a merged HEAD or a non-empty
	 * worktree diff. R1: NOT an OR across every task, so a pass-then-infra-fail
	 * chain (an earlier task merged, then the failing task died with no diff/merge —
	 * the 429 fingerprint) reports `false` and the supervisor labels it
	 * `dispatch-error` rather than `acceptance-fail`. `false` when the dispatch
	 * passed (the supervisor does not read it on the success path).
	 */
	readonly producedSideEffects: boolean;
	/** The failing task's policy-decision reasons (see LoopDispatchResult). */
	readonly reasons: readonly string[];
	readonly runs: ReadonlyArray<{
		task: string;
		run_id: string;
		status: string;
	}>;
}

/**
 * Per-task evidence the dispatch fold consumes — a projection of the kernel's
 * `runPacketAsync` result for one packet.
 */
interface DispatchTaskResult {
	readonly task: string;
	readonly runId: string;
	readonly status: string;
	readonly mergedHeadSha: string | null;
	readonly changedFilesCount: number;
	readonly tokenUsage: number;
	readonly reasons: readonly string[];
}

/**
 * Fold the per-task dispatch results into the supervisor's terminal outcome.
 *
 * R1 terminal-reason fidelity: `producedSideEffects` reflects the FAILING task's
 * OWN evidence (a merged HEAD or a non-empty worktree diff), never an OR across
 * every task. Tasks dispatch sequentially and the loop breaks on the first
 * failure, so the failing task is the last recorded result; a pass-then-infra-fail
 * chain (PF1 merges, then PF2 dies with a 429 — no diff, no merge) therefore
 * reports `false`, so the supervisor labels it `dispatch-error`, not
 * `acceptance-fail`. `mergedHeadSha` and `tokenUsage` still aggregate across the
 * whole dispatch (last merged tip; summed usage).
 */
export function summarizeDispatchOutcome(
	results: readonly DispatchTaskResult[],
	packetCount: number,
): PlanForgeDispatchOutcome {
	let mergedHeadSha: string | null = null;
	let tokenUsage = 0;
	let producedSideEffects = false;
	let reasons: readonly string[] = [];
	let sawFailure = false;
	for (const result of results) {
		if (result.mergedHeadSha) {
			mergedHeadSha = result.mergedHeadSha;
		}
		tokenUsage += result.tokenUsage;
		if (result.status !== "passed" && !sawFailure) {
			sawFailure = true;
			producedSideEffects =
				result.mergedHeadSha != null || result.changedFilesCount > 0;
			reasons = result.reasons;
		}
	}
	const runs = results.map((result) => ({
		task: result.task,
		run_id: result.runId,
		status: result.status,
	}));
	const allPassed =
		runs.length === packetCount && runs.every((run) => run.status === "passed");
	return {
		allPassed,
		mergedHeadSha,
		tokenUsage,
		producedSideEffects,
		reasons,
		runs,
	};
}

async function runPlanForgeDispatchCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
	opts?: {
		/** Lowered worker turn cap for the supervisor loop's runaway guard. */
		readonly claudeMaxTurns?: number;
		/**
		 * Per-packet budget caps for the supervisor loop's runaway guard. Threaded
		 * to the orchestrator so the AbortController aborts a runaway model worker
		 * mid-stream. The dispatched packet's acceptance profile has no budgets, so
		 * the orchestrator falls through to these top-level budgets.
		 */
		readonly budgets?: BudgetConstraints;
		/** Receives the rich dispatch outcome (incl. mergedHeadSha) for the loop. */
		readonly onOutcome?: (outcome: PlanForgeDispatchOutcome) => void;
		/** Worker model override stamped onto every dispatched packet. Defaults to
		 * planforge's `DISPATCH_WORKER_MODEL` when omitted. */
		readonly model?: string;
	},
): Promise<number> {
	const inputPath = readFlag(args, "--input");
	if (!inputPath) {
		throw new Error(
			"Missing required --input <file> argument for PlanForge dispatch.",
		);
	}
	const jsonOut = args.includes("--json");
	// The acceptance gate is ON by default. Worktree dependencies are provisioned
	// (`pnpm install --frozen-lockfile`) before the gate runs, so a task's
	// `verificationCommands` (`pnpm lint`/`pnpm typecheck`/…) have their binaries.
	// `--no-enforce-acceptance` opts OUT (e.g. during initial dogfood bringup or
	// when the worktree has no pnpm workspace). The legacy `--enforce-acceptance`
	// flag is still accepted but redundant — the gate is already on.
	const enforceAcceptance = !args.includes("--no-enforce-acceptance");

	const plan = createPlanForgeDryRunPlan(resolve(cwd, inputPath));
	const workspace = resolve(cwd);
	// priorWork handoff (GAP-5): a second storage connection for the single
	// post-receipt summary INSERT. SQLite WAL mode allows it to coexist with the
	// orchestrator's primary connection — the write executes after emitPlanReceipt
	// returns, so there is no concurrent-writer window in the sequential dispatch loop.
	const summaryStore = await loadSearchableDocumentStoragePort(workspace);
	const runId = planAdmitRunId(plan.idempotencyKey);
	const admission = await findVerifiedPlanAdmission(workspace, runId, plan);
	const admittedEventId = admission?.eventId;
	if (!admittedEventId) {
		throw new Error(
			`plan-not-admitted: PlanForge plan ${plan.id} has no signed plan_admitted on the tape. Run \`buildplane planforge admit\` first.`,
		);
	}

	// S7 crash-recovery sidecar: pin the deterministic tape runId to the --input
	// plan file BEFORE the run loop so `planforge recover` can reconstruct the plan
	// if the process dies mid-dispatch (storage `running` rows carry no input path).
	writePlanForgeDispatchManifest(workspace, {
		runId,
		inputPath: resolve(cwd, inputPath),
		planId: plan.id,
		idempotencyKey: plan.idempotencyKey,
		createdAt: new Date().toISOString(),
		// Persist the worker-model override BEFORE the run loop so a crash-and-resume
		// re-dispatches the suffix on the same model (R-001). Omitted when undefined.
		model: opts?.model,
	});

	const packets = dispatchAdmittedPlan({
		plan,
		admittedEventId: String(admittedEventId),
		policyProfile: DEFAULT_DISPATCH_POLICY_PROFILE,
		model: opts?.model,
	});

	// M4 acceptance contract: derive one fail-closed contract per task (diff-scope
	// = the task's capability bundle fsWrite; checks = its verificationCommands),
	// expose them through a per-task policy profile the kernel resolves at the
	// finalization gate. `plan.tasks[i]` maps 1:1 (in order) to `packets[i]`.
	const acceptanceProfiles = new Map<
		string,
		{
			readonly profileName: string;
			readonly contractDigest: string;
			readonly profile: PolicyProfile;
		}
	>();
	if (enforceAcceptance) {
		plan.tasks.forEach((task, index) => {
			const contract = deriveAcceptanceContract(plan, task);
			const profileName = `planforge-${plan.id}-${task.id}`;
			acceptanceProfiles.set(packets[index].unit.id, {
				profileName,
				contractDigest: acceptanceContractDigest(contract),
				profile: {
					name: profileName,
					trustGates: { acceptanceContract: contract },
				},
			});
		});
	}
	const profileRegistry: BuildplaneProfileRegistryPort = {
		resolve(name) {
			for (const entry of acceptanceProfiles.values()) {
				if (entry.profile.name === name) {
					return entry.profile;
				}
			}
			throw new Error(`unknown policy profile: ${name}`);
		},
	};

	const { parseUnitPacket } = (await cliImport("@buildplane/kernel")) as {
		parseUnitPacket: (input: string) => unknown;
	};

	// Activity bracketing rides a kernel-signed tape (D2). Fail fast if the kernel
	// key is missing rather than letting the signed subprocess die opaquely.
	assertKernelSigningKey();
	const binary = resolveLedgerBinary(cwd);
	const ledgerChild = spawnLedgerSubprocess(binary, runId, workspace, {
		sign: true,
		signingKeyId: PLANFORGE_KERNEL_SIGNING_KEY_ID,
	});
	let emitter: TapeEmitter;
	try {
		emitter = await createTapeEmitter({
			childStdin: ledgerChild.stdin,
			childStderr: ledgerChild.stderr,
			childExit: ledgerChild.exit,
			workspacePath: workspace,
			runId,
		});
	} catch (err) {
		if (ledgerChild.child.exitCode === null) {
			ledgerChild.child.kill("SIGTERM");
		}
		throw new Error(
			`PlanForge dispatch: signed ledger handshake failed: ${String(err)}`,
		);
	}

	let runs: PlanForgeDispatchOutcome["runs"] = [];
	let allPassed = false;
	// The squash-merge happens INSIDE orchestrator.runPacketAsync (GAP-8). Collect
	// each task's OWN evidence (merged HEAD, diff size, usage, reasons) and fold it
	// once via summarizeDispatchOutcome, so the terminal reason keys off the FAILING
	// task's side effects rather than an OR across passing predecessors (R1).
	const taskResults: DispatchTaskResult[] = [];
	try {
		// Demo crash-injection (M6 Property 1): NO-OP unless BUILDPLANE_CRASH_AFTER_ACTIVITY=1,
		// in which case the dispatch aborts hard right after the first activity_completed
		// is durable+signed on the tape — never reaching the terminal plan_receipt.
		const ledgerActivityPort = withCrashAfterActivityGuard(
			createLedgerActivityPort(emitter),
			emitter,
		);
		// Tasks dispatch sequentially, so a single mutable identity holder safely
		// scopes the acceptance verdict's plan identity to the task in flight.
		const acceptanceIdentity = { planId: plan.id, contractDigest: "" };
		const acceptancePort = enforceAcceptance
			? createAcceptancePort(emitter, {
					get planId() {
						return acceptanceIdentity.planId;
					},
					get contractDigest() {
						return acceptanceIdentity.contractDigest;
					},
				})
			: undefined;
		const { orchestrator, eventBus: cliEventBus } = await loadCliOrchestrator(
			workspace,
			enforceAcceptance
				? {
						ledgerActivityPort,
						profileRegistry,
						acceptancePort,
						provisionDeps: provisionWorktreeDeps,
						claudeMaxTurns: opts?.claudeMaxTurns,
						budgets: opts?.budgets,
					}
				: {
						ledgerActivityPort,
						claudeMaxTurns: opts?.claudeMaxTurns,
						budgets: opts?.budgets,
					},
		);

		for (const packet of packets) {
			const acceptance = acceptanceProfiles.get(packet.unit.id);
			acceptanceIdentity.contractDigest = acceptance?.contractDigest ?? "";
			// Route the packet through its per-task acceptance profile so the kernel
			// resolves the contract at the finalization gate.
			const dispatchedPacket = acceptance
				? {
						...packet,
						unit: { ...packet.unit, policyProfile: acceptance.profileName },
					}
				: packet;
			const result = (await orchestrator.runPacketAsync(
				parseUnitPacket(JSON.stringify(dispatchedPacket)),
				cliEventBus,
			)) as {
				run: { id: string; status: string };
				mergedHeadSha?: string;
				receipt?: { tokenUsage?: number; changedFiles?: readonly string[] };
				decision?: { reasons?: readonly string[] };
			};
			// Record this task's OWN evidence. A non-empty worktree diff or a merged
			// HEAD means the worker ran and mutated the tree — a durable side effect,
			// even if acceptance later rejected it. Attributing side effects per-task
			// (vs a shared OR) lets the fold key the terminal reason off the FAILING
			// task, so a passing predecessor's merge cannot mask an infra death (R1).
			taskResults.push({
				task: packet.unit.id,
				runId: result.run.id,
				status: result.run.status,
				mergedHeadSha: result.mergedHeadSha ?? null,
				changedFilesCount: result.receipt?.changedFiles?.length ?? 0,
				// Real per-task usage (terminal `usage`), summed even for a failed task —
				// the worker still consumed those tokens against the budget.
				tokenUsage: result.receipt?.tokenUsage ?? 0,
				// The failing task's decision reasons feed the supervisor's terminal
				// detail (verbatim; empty when the run reported none).
				reasons: result.decision?.reasons ?? [],
			});
			if (result.run.status !== "passed") {
				break; // PF2 dependsOn PF1: stop the chain on first failure.
			}
		}

		const outcome = summarizeDispatchOutcome(taskResults, packets.length);
		allPassed = outcome.allPassed;
		runs = outcome.runs;

		opts?.onOutcome?.(outcome);

		// Terminal plan receipt (M2-S6): one signed plan_receipt per admitted plan,
		// chaining to the plan_admitted event, emitted after all activities and made
		// durable (flush) before the signed emitter closes in the finally. Routed
		// through emitPlanForgeTerminalReceipt so it is gated on planForgeReceiptExists:
		// re-firing the same plan/idempotencyKey (e.g. `planforge loop --once` twice,
		// same deterministic runId) can never append a second plan_receipt for the run.
		const result = {
			status: allPassed ? "dispatched" : "failed",
			plan_id: plan.id,
			admitted_event_id: String(admittedEventId),
			runs,
		};
		await emitPlanForgeTerminalReceipt({
			emitter,
			workspace,
			runId,
			plan,
			admittedEventId: String(admittedEventId),
			outcome: allPassed ? "completed" : "failed",
			result,
		});

		// priorWork handoff (GAP-5): persist a structured plan summary for the next
		// iteration. Best-effort and wrapped so a storage failure cannot shadow the
		// already-flushed plan_receipt. mergedSha is undefined here; GAP-7 passes
		// result.mergedHeadSha after commitAndMergeWorkspace.
		try {
			writePlanSummaryToStorage(
				summaryStore,
				plan,
				runs,
				allPassed ? "completed" : "failed",
			);
		} catch (summaryErr) {
			stdout(`[warn] failed to persist plan summary: ${String(summaryErr)}`);
		}
	} finally {
		try {
			await emitter.close(); // flushes + closes the signed subprocess
		} catch {
			if (ledgerChild.child.exitCode === null) {
				ledgerChild.child.kill("SIGTERM");
			}
		}
	}

	stdout(
		jsonOut
			? formatJson({
					status: allPassed ? "dispatched" : "failed",
					plan_id: plan.id,
					admitted_event_id: String(admittedEventId),
					runs,
				})
			: `Dispatched PlanForge plan ${plan.id}: ${runs.length}/${packets.length} task(s).`,
	);
	return allPassed ? 0 : 1;
}

/**
 * `buildplane planforge plan --roadmap <file> --out <plan.md> --trusted-base <sha>`:
 * read the L0 tape's completed slices, select the next eligible roadmap slice,
 * deterministically emit its `plan.md`, and validate it through the dry-run
 * pipeline. Writes the plan.md and exits 0 iff the emitted plan validates PASS —
 * the gate that proves the plan is real is `planforge validate`, not a worker
 * exit code. The `--once` loop path drives this deterministic emitter; the
 * LLM-authored-plan worker path is gated behind a later flag.
 */
async function runPlanForgePlanCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	const roadmapPath = readFlag(args, "--roadmap") ?? "docs/roadmap.json";
	const outPath = readFlag(args, "--out");
	if (!outPath) {
		throw new Error(
			"Missing required --out <plan.md> argument for PlanForge plan.",
		);
	}
	const trustedBase = readFlag(args, "--trusted-base");
	if (!trustedBase) {
		throw new Error(
			"Missing required --trusted-base <sha> argument for PlanForge plan.",
		);
	}
	const jsonOut = args.includes("--json");
	const remote =
		readFlag(args, "--remote") ??
		"https://github.com/SollanSystems/buildplane.git";
	const proposal = await runPlannerProposal({
		roadmapPath: resolve(cwd, roadmapPath),
		workspace: resolve(cwd),
		remote,
		trustedBase,
	});
	writeFileSync(resolve(cwd, outPath), proposal.planMarkdown, "utf8");
	stdout(
		jsonOut
			? formatJson({
					slice_id: proposal.sliceId,
					status: proposal.status,
					out: outPath,
				})
			: `PlanForge planner proposed ${proposal.sliceId} -> ${outPath} (${proposal.status}).`,
	);
	return proposal.status === PLANFORGE_VALIDATION_STATUS_PASS ? 0 : 1;
}

/**
 * Strict positive-integer flag parse for the loop's runaway-guard bounds.
 * Accepts both `--flag=N` and `--flag N`. Rejects non-positive / non-integer.
 */
function parseIntFlag(
	args: readonly string[],
	flag: string,
	fallback: number | null,
): number | null {
	const eq = args.find((a) => a.startsWith(`${flag}=`));
	const raw = eq ? eq.slice(flag.length + 1) : readFlag(args, flag);
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isSafeInteger(n) || n <= 0) {
		throw new Error(`${flag} must be a positive integer.`);
	}
	return n;
}

const LOOP_DEFAULT_REMOTE = "https://github.com/SollanSystems/buildplane.git";

/**
 * Default planner port: load `docs/roadmap.json`, select the next eligible
 * slice relative to the loop's pinned `trustedBase`, deterministically emit its
 * `plan.md` into `.buildplane/loop/<sliceId>.plan.md`, and return its path +
 * slice id + the roadmap milestone. A roadmap-exhausted / dependency-blocked
 * roadmap reports `{ done: true }` (terminal roadmap-complete).
 */
async function defaultLoopPlanner(ctx: {
	workspace: string;
	lastMergedHeadSha: string | null;
	trustedBase: string | null;
}): Promise<LoopSliceProposal | { done: true }> {
	const roadmapPath = resolve(ctx.workspace, "docs", "roadmap.json");
	if (!existsSync(roadmapPath)) {
		return { done: true };
	}
	// Pin one base for the loop's lifetime (GAP-9 carry-forward): the planner
	// reads completed-slice ids relative to this base, so it must not move
	// across iterations or completed slices read as not-done.
	const trustedBase = ctx.trustedBase ?? ctx.lastMergedHeadSha ?? "";
	const doc: RoadmapDoc = loadRoadmapFromString(
		readFileSync(roadmapPath, "utf8"),
	);
	const proposal = await runPlannerProposal({
		roadmapPath,
		workspace: ctx.workspace,
		remote: LOOP_DEFAULT_REMOTE,
		trustedBase,
	}).catch((err) => {
		// selectNextRoadmapSlice throws when the roadmap is exhausted /
		// dependency-blocked — that is "done", not a planner error.
		if (
			err instanceof Error &&
			/no eligible roadmap slice|roadmap exhausted/i.test(err.message)
		) {
			return null;
		}
		throw err;
	});
	if (!proposal) {
		return { done: true };
	}
	const loopDir = resolve(ctx.workspace, ".buildplane", "loop");
	mkdirSync(loopDir, { recursive: true });
	const planPath = join(loopDir, `${proposal.sliceId}.plan.md`);
	writeFileSync(planPath, proposal.planMarkdown, "utf8");
	return { planPath, sliceId: proposal.sliceId, milestone: doc.milestone };
}

/** Default envelope port: load the active signed envelope + subset-check. */
const defaultLoopEnvelope = {
	async load(
		workspace: string,
	): Promise<{ envelope: AuthorizationEnvelopeV0 } | null> {
		const active = await loadActiveAuthorizationEnvelope(resolve(workspace));
		return active ? { envelope: active.envelope } : null;
	},
	check(
		proposal: EnvelopeProposal,
		envelope: AuthorizationEnvelopeV0 | null,
	): { ok: true } | { ok: false; reason: string } {
		if (!envelope) {
			return {
				ok: false,
				reason:
					"no active kernel-signed authorization envelope — run `buildplane planforge authorize-envelope` first.",
			};
		}
		const evaluation = evaluateEnvelopeAdmission(
			proposal,
			envelope,
			new Date(),
		);
		if (evaluation.status === "admitted") {
			return { ok: true };
		}
		return { ok: false, reason: evaluation.reasons.join(" ") };
	},
};

/** Default dry-run port: validate the plan.md through the dry-run pipeline. */
async function defaultLoopDryRun(
	planPath: string,
	cwd: string,
): Promise<{ ok: true; plan: PlanForgePlan } | { ok: false; reason: string }> {
	const plan = createPlanForgeDryRunPlan(resolve(cwd, planPath));
	if (plan.validation.status !== PLANFORGE_VALIDATION_STATUS_PASS) {
		return {
			ok: false,
			reason: `plan validation ${plan.validation.status}`,
		};
	}
	return { ok: true, plan };
}

/** Default admit port: route through the existing signed-admit command. */
async function defaultLoopAdmit(
	planPath: string,
	cwd: string,
): Promise<{ admittedEventId: string }> {
	const code = await runPlanForgeAdmitCommand(
		[
			"--input",
			planPath,
			"--approve",
			"--operator",
			"loop-supervisor",
			"--json",
		],
		cwd,
		() => {},
	);
	if (code !== 0) {
		throw new Error(`planforge admit failed (exit ${code}).`);
	}
	return { admittedEventId: "" };
}

/** Default dispatch port: route through the existing dispatch command with the
 * runaway-guard turn cap AND budgets, capturing the rich outcome (incl.
 * mergedHeadSha + real token usage). The lowered worker turn cap is bound by the
 * loop command (closure over maxTurns).
 *
 * The guard's `budgets` are threaded to the orchestrator so its per-packet
 * AbortController aborts a runaway model worker mid-stream once it crosses
 * maxTokens / maxComputeTimeMs (GAP-7 CRITICAL-1). `dispatchCommand` is injected
 * so the budget-threading contract is unit-testable without a full dispatch.
 */
export function makeDefaultLoopDispatch(
	maxTurns: number,
	dispatchCommand: typeof runPlanForgeDispatchCommand = runPlanForgeDispatchCommand,
	model?: string,
): (
	planPath: string,
	cwd: string,
	guard: PolicyProfile,
) => Promise<LoopDispatchResult> {
	return async (planPath, cwd, guard) => {
		// Default stands only if `onOutcome` never fires (the dispatch aborted before
		// reporting) — that IS an infra death (no worker work), so `producedSideEffects`
		// defaults false → a failed dispatch with no outcome maps to `dispatch-error`.
		let outcome: LoopDispatchResult = {
			allPassed: false,
			mergedHeadSha: null,
			tokenUsage: 0,
			producedSideEffects: false,
			reasons: [],
			runs: [],
		};
		await dispatchCommand(["--input", planPath, "--json"], cwd, () => {}, {
			claudeMaxTurns: maxTurns,
			// Deliver the guard's budgets so the orchestrator installs the
			// per-packet AbortController budget subscription for this dispatch.
			budgets: guard.budgets,
			// Worker model override (`planforge loop --model <id>`); undefined keeps
			// the dispatch default (`DISPATCH_WORKER_MODEL`).
			model,
			onOutcome: (o) => {
				outcome = o;
			},
		});
		return outcome;
	};
}

/**
 * `buildplane planforge loop`: the supervisor FSM. Each iteration runs
 * plan → dry-run → envelope-check → admit → dispatch → accept → merge →
 * re-anchor → advance, persisting `loop-state.json` atomically after every
 * transition. Resumes from a persisted non-terminal state. Halts on any
 * terminal condition: roadmap-complete, `.buildplane/loop.stop`, acceptance
 * FAIL, envelope breach, cumulative token budget, max-iterations, planner
 * error. The squash-merge happens INSIDE the dispatch (GAP-8); the re-anchor
 * phase only READS the merged HEAD (D3) — no second merge.
 */
async function runPlanForgeLoopCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
	_stderr: (line: string) => void,
	deps: RunCliDependencies | undefined,
): Promise<number> {
	const workspace = resolve(cwd);
	const jsonOut = args.includes("--json");

	// `--reset`: clear the persisted loop-state and exit before starting a run. A
	// loop that halted on a sticky terminal (e.g. `dispatch-error` from a 429)
	// otherwise resumes straight back into it; this is the re-fire path.
	if (args.includes("--reset")) {
		const cleared = clearLoopState(workspace);
		stdout(
			jsonOut
				? formatJson({ reset: cleared, statePath: loopStatePath(workspace) })
				: cleared
					? `loop state cleared: ${loopStatePath(workspace)}`
					: "no loop state to clear.",
		);
		return 0;
	}

	const once = args.includes("--once");
	const maxIterations = once ? 1 : parseIntFlag(args, "--max-iterations", null);
	const maxTurns = parseIntFlag(args, "--max-turns", 12) ?? 12;
	const maxTokens = parseIntFlag(args, "--max-tokens", 200_000) ?? 200_000;
	const wallClockMs =
		parseIntFlag(args, "--wall-clock-ms", 30 * 60_000) ?? 30 * 60_000;
	// Optional worker-model override threaded to every dispatched packet; omitted
	// leaves the dispatch default (`DISPATCH_WORKER_MODEL`) untouched.
	const model = readFlag(args, "--model");

	const planner = deps?.loopPlanner ?? defaultLoopPlanner;
	const envelope = deps?.loopEnvelope ?? defaultLoopEnvelope;
	const dryRun = deps?.loopDryRun ?? defaultLoopDryRun;
	const admit = deps?.loopAdmit ?? defaultLoopAdmit;
	const dispatch =
		deps?.loopDispatch ??
		makeDefaultLoopDispatch(maxTurns, runPlanForgeDispatchCommand, model);

	// Per-iteration runaway guard (distinct from the cumulative token budget):
	// maxTurns is the lowered worker turn cap; maxTokens/wallClockMs drive the
	// orchestrator's per-packet AbortController.
	const guard = runawayGuardProfile({
		profileName: "planforge-loop-guard",
		maxTokens,
		maxComputeTimeMs: wallClockMs,
	});

	// Resume from a persisted non-terminal state, else start fresh. tokenBudget
	// is the envelope's cumulative cross-iteration cap (D6), pinned at start.
	const loadedEnvelope = await envelope.load(workspace);
	let state: LoopState =
		readLoopState(workspace) ??
		initialLoopState({
			maxIterations,
			tokenBudget: loadedEnvelope?.envelope?.token_budget ?? null,
			trustedBase: null,
		});
	let exitCode = 0;
	const commit = (s: LoopState): void => {
		state = s;
		writeLoopStateAtomic(workspace, state);
	};

	// The driver always re-enters at the planner each iteration; it does NOT
	// resume from a persisted mid-iteration `phase`. A crash mid-iteration simply
	// re-runs the whole iteration — which is idempotent (admit dedupes on the
	// signed tape, dispatch re-derives the verified admission), so `state.phase`
	// is informational (an observability breadcrumb), not resume-driving.
	while (!state.terminal) {
		if (stopFileRequested(workspace)) {
			commit(nextLoopState(state, { type: "stop-file" }));
			break;
		}
		// Stop BEFORE starting another slice once the completed-iteration count
		// has reached the cap (`--once` => maxIterations 1 runs exactly one slice).
		if (
			state.maxIterations !== null &&
			state.iteration >= state.maxIterations
		) {
			commit(
				nextLoopState({ ...state, phase: "advance" }, { type: "advance" }),
			);
			break;
		}
		const env = await envelope.load(workspace);
		let proposal: LoopSliceProposal | { done: true };
		try {
			proposal = await planner({
				workspace,
				lastMergedHeadSha: state.lastMergedHeadSha,
				trustedBase: state.trustedBase,
			});
		} catch (err) {
			commit(
				nextLoopState(state, {
					type: "planner-error",
					detail: err instanceof Error ? err.message : String(err),
				}),
			);
			exitCode = 1;
			break;
		}
		if ("done" in proposal) {
			commit(nextLoopState(state, { type: "roadmap-complete" }));
			break;
		}
		commit(
			nextLoopState(state, {
				type: "slice-selected",
				sliceId: proposal.sliceId,
				planPath: proposal.planPath,
			}),
		);

		const dr = await dryRun(proposal.planPath, cwd);
		if (!dr.ok) {
			commit(
				nextLoopState(state, { type: "acceptance-failed", detail: dr.reason }),
			);
			exitCode = 1;
			break;
		}
		commit(nextLoopState(state, { type: "dry-run-ok" }));

		const check = envelope.check(
			buildEnvelopeProposal(dr.plan, proposal.milestone),
			env?.envelope ?? null,
		);
		if (!check.ok) {
			commit(
				nextLoopState(state, { type: "envelope-breach", detail: check.reason }),
			);
			exitCode = 2;
			break;
		}
		commit(nextLoopState(state, { type: "envelope-ok" }));

		await admit(proposal.planPath, cwd);
		commit(nextLoopState(state, { type: "admitted" }));

		const d = await dispatch(proposal.planPath, cwd, guard);
		commit(nextLoopState(state, { type: "dispatched" }));

		// Feed the REAL per-dispatch token usage into the cumulative cross-iteration
		// token-budget cap (GAP-7 CRITICAL-2). Tokens are consumed even when the
		// dispatch failed, so account for them before the acceptance branch. If the
		// cumulative total exceeds the envelope's token_budget, the loop terminates
		// `token-budget` here and stops.
		if (d.tokenUsage > 0) {
			const afterTokens = nextLoopState(state, {
				type: "token-deltas-observed",
				count: d.tokenUsage,
			});
			commit(afterTokens);
			if (afterTokens.terminal?.reason === "token-budget") break;
		}

		if (!d.allPassed) {
			// Thread the real decision reasons into the terminal detail (verbatim);
			// fall back to a placeholder only when the dispatch reported none.
			const detail =
				d.reasons.length > 0
					? d.reasons.join("; ")
					: "dispatch/acceptance failed";
			// Distinguish an infra/dispatch death (worker produced NO side effects —
			// e.g. a 429 rejection: 0 tokens, 0 turns, empty diff) from a genuine
			// acceptance failure (worker built a diff the contract rejected). Only the
			// explicit `producedSideEffects === false` negative signal downgrades to
			// `dispatch-error`; anything else stays `acceptance-fail`.
			commit(
				nextLoopState(
					state,
					d.producedSideEffects
						? { type: "acceptance-failed", detail }
						: { type: "dispatch-error", detail },
				),
			);
			exitCode = 1;
			break;
		}
		commit(nextLoopState(state, { type: "accepted" }));

		// D3: the squash-merge already happened inside the dispatch; read the
		// merged HEAD, never merge again.
		const headSha = d.mergedHeadSha ?? state.lastMergedHeadSha ?? "";
		commit(nextLoopState(state, { type: "merged", headSha }));
		commit(nextLoopState({ ...state, phase: "advance" }, { type: "advance" }));
	}

	const summary = {
		status: state.terminal?.reason ?? "stopped",
		iterations: state.iteration,
		terminal: state.terminal,
		statePath: loopStatePath(workspace),
	};
	stdout(
		jsonOut
			? formatJson(summary)
			: `loop terminated: ${summary.status} after ${state.iteration} iteration(s).`,
	);
	if (state.terminal?.reason === "acceptance-fail") exitCode = exitCode || 1;
	if (state.terminal?.reason === "dispatch-error") exitCode = exitCode || 1;
	if (state.terminal?.reason === "planner-error") exitCode = exitCode || 1;
	if (state.terminal?.reason === "envelope-breach") exitCode = 2;
	return exitCode;
}

/**
 * `buildplane planforge resume --input <file>`: explicit-input S7b recovery.
 * Rebuilds the PlanForge plan from input, verifies the signed admission payload,
 * replays durable activity completions from the tape, skips those completed
 * activities, executes only the remaining suffix, and appends a terminal receipt
 * if the prior run crashed after execution but before `plan_receipt`.
 */
async function runPlanForgeResumeCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	const inputPath = readFlag(args, "--input");
	if (!inputPath) {
		throw new Error(
			"Missing required --input <file> argument for PlanForge resume.",
		);
	}
	return resumePlanForgePlanFromInput(inputPath, cwd, stdout, {
		json: args.includes("--json"),
	});
}

/**
 * Shared replay-skip-resume body, extracted from `runPlanForgeResumeCommand` so
 * both `planforge resume --input` and `planforge recover` (S7 crash recovery)
 * drive the identical path: reconstruct the plan from `inputPath`, re-verify the
 * signed `plan_admitted`, replay durable activity completions from the tape, skip
 * the recorded prefix, execute only the remaining suffix, and append the terminal
 * receipt if the prior run crashed after execution but before `plan_receipt`.
 */
export async function resumePlanForgePlanFromInput(
	inputPath: string,
	cwd: string,
	stdout: (line: string) => void,
	opts: { json: boolean },
): Promise<number> {
	const jsonOut = opts.json;

	const plan = createPlanForgeDryRunPlan(resolve(cwd, inputPath));
	const workspace = resolve(cwd);
	const runId = planAdmitRunId(plan.idempotencyKey);
	// R-001: recover the worker-model override the original dispatch ran with from
	// the crash-recovery manifest, so the re-dispatched suffix keeps the same model
	// (recover has no flags — the manifest is the only place it survives a crash).
	const recoveredModel = resolvePlanForgeResumeModel(
		readPlanForgeDispatchManifests(workspace),
		runId,
	);
	const admission = await findVerifiedPlanAdmission(workspace, runId, plan);
	if (!admission) {
		throw new Error(
			`plan-not-admitted: PlanForge plan ${plan.id} has no signed plan_admitted on the tape. Run \`buildplane planforge admit\` first.`,
		);
	}
	const admittedEventId = admission.eventId;
	const replay = await readPlanForgeReplayState(
		workspace,
		runId,
		plan,
		admittedEventId,
	);
	const packets = dispatchAdmittedPlan({
		plan,
		admittedEventId,
		policyProfile: DEFAULT_DISPATCH_POLICY_PROFILE,
		model: recoveredModel,
	});
	if (replay.completedActivities.length > packets.length) {
		throw new Error(
			`plan-resume-invalid-tape: found ${replay.completedActivities.length} completed activities for ${packets.length} PlanForge task(s).`,
		);
	}

	const runs: PlanForgeResumeRunResult[] = [];
	for (let i = 0; i < replay.completedActivities.length; i += 1) {
		const recorded = replay.completedActivities[i];
		runs.push({
			task: packets[i].unit.id,
			run_id: recorded.runId,
			status: recordedActivityStatus(recorded.result),
			source: "recorded",
			activity_id: recorded.activityId,
			completed_event_id: recorded.eventId,
		});
	}

	if (replay.receipt) {
		const terminalOk = replay.receipt.outcome === "completed";
		stdout(
			jsonOut
				? formatJson({
						status: "already_receipted",
						plan_id: plan.id,
						admitted_event_id: admittedEventId,
						receipt_event_id: replay.receipt.eventId,
						receipt_outcome: replay.receipt.outcome,
						runs,
					})
				: `PlanForge plan ${plan.id} already has terminal plan_receipt ${replay.receipt.eventId}.`,
		);
		return terminalOk ? 0 : 1;
	}

	const recordedFailure = runs.find((run) => !isPassedPlanForgeRun(run.status));
	let allPassed = false;
	let emitter: TapeEmitter | undefined;
	let ledgerChild: ReturnType<typeof spawnLedgerSubprocess> | undefined;
	try {
		assertKernelSigningKey();
		const binary = resolveLedgerBinary(cwd);
		ledgerChild = spawnLedgerSubprocess(binary, runId, workspace, {
			sign: true,
			signingKeyId: PLANFORGE_KERNEL_SIGNING_KEY_ID,
		});
		emitter = await createTapeEmitter({
			childStdin: ledgerChild.stdin,
			childStderr: ledgerChild.stderr,
			childExit: ledgerChild.exit,
			workspacePath: workspace,
			runId,
		});

		if (!recordedFailure) {
			const { parseUnitPacket } = (await cliImport("@buildplane/kernel")) as {
				parseUnitPacket: (input: string) => unknown;
			};
			const ledgerActivityPort = createLedgerActivityPort(emitter);
			const { orchestrator, eventBus: cliEventBus } = await loadCliOrchestrator(
				workspace,
				{ ledgerActivityPort },
			);
			for (
				let i = replay.completedActivities.length;
				i < packets.length;
				i += 1
			) {
				const packet = packets[i];
				const result = await orchestrator.runPacketAsync(
					parseUnitPacket(JSON.stringify(packet)),
					cliEventBus,
				);
				runs.push({
					task: packet.unit.id,
					run_id: result.run.id,
					status: result.run.status,
					source: "executed",
				});
				if (result.run.status !== "passed") {
					break;
				}
			}
		}

		allPassed =
			runs.length === packets.length &&
			runs.every((run) => isPassedPlanForgeRun(run.status));
		const result = {
			status: allPassed ? "resumed" : "failed",
			plan_id: plan.id,
			admitted_event_id: admittedEventId,
			resume: true,
			recorded_activity_count: replay.completedActivities.length,
			executed_activity_count: runs.filter((run) => run.source === "executed")
				.length,
			runs,
		};
		await emitPlanForgeTerminalReceipt({
			emitter,
			workspace,
			runId,
			plan,
			admittedEventId,
			outcome: allPassed ? "completed" : "failed",
			result,
		});
	} catch (err) {
		if (ledgerChild?.child.exitCode === null) {
			ledgerChild.child.kill("SIGTERM");
		}
		throw new Error(`PlanForge resume failed: ${String(err)}`);
	} finally {
		if (emitter) {
			try {
				await emitter.close();
			} catch {
				if (ledgerChild?.child.exitCode === null) {
					ledgerChild.child.kill("SIGTERM");
				}
			}
		}
	}

	stdout(
		jsonOut
			? formatJson({
					status: allPassed ? "resumed" : "failed",
					plan_id: plan.id,
					admitted_event_id: admittedEventId,
					recorded_activity_count: replay.completedActivities.length,
					executed_activity_count: runs.filter(
						(run) => run.source === "executed",
					).length,
					runs,
				})
			: `Resumed PlanForge plan ${plan.id}: ${runs.length}/${packets.length} task(s).`,
	);
	return allPassed ? 0 : 1;
}

/**
 * `buildplane planforge recover [--json]`: S7 startup crash recovery with NO
 * `--input`. Scans storage for orphaned `running` PlanForge dispatches (via the
 * dispatch-manifest sidecar), then replays the signed tape for each to resume the
 * remaining suffix and emit any missing terminal receipt — re-establishing
 * `will_execute_worker` trust FROM THE TAPE, not the lost in-memory WeakSet. The
 * tape is authoritative over the storage status field; recover re-runs the suffix
 * and emits the receipt on the TAPE, and does NOT rewrite the storage `running`
 * row. Exit 0 iff every orphan resumes to completion (or there are no orphans).
 */
async function runPlanForgeRecoverCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	const jsonOut = args.includes("--json");
	const workspace = resolve(cwd);
	const orphans = await findOrphanedPlanForgeDispatches(workspace);
	if (orphans.length === 0) {
		stdout(
			jsonOut
				? formatJson({ status: "no_orphans", recovered: [] })
				: "PlanForge recover: no orphaned running dispatches found.",
		);
		return 0;
	}
	const recovered: Array<{
		plan_id: string;
		run_id: string;
		status: "resumed" | "failed";
	}> = [];
	let allOk = true;
	for (const orphan of orphans) {
		const captured: string[] = [];
		const code = await resumePlanForgePlanFromInput(
			orphan.inputPath,
			cwd,
			(line) => captured.push(line),
			{ json: true },
		);
		const ok = code === 0;
		allOk = allOk && ok;
		recovered.push({
			plan_id: orphan.planId,
			run_id: orphan.runId,
			status: ok ? "resumed" : "failed",
		});
	}
	stdout(
		jsonOut
			? formatJson({
					status: allOk ? "recovered" : "failed",
					recovered,
				})
			: `PlanForge recover: ${recovered.length} orphan(s) processed.`,
	);
	return allOk ? 0 : 1;
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
	const resolvedCwd = resolve(cwd);
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
		if (command === "admission") {
			const subcommand = rest[0];
			if (subcommand === "receipt") {
				return runAdmissionReceiptDryRunCommand(rest.slice(1), cwd, stdout);
			}
			throw new Error(
				`Unknown admission command: ${subcommand ?? "(missing subcommand)"}`,
			);
		}

		if (command === "bootstrap") {
			const subcommand = rest[0];
			const doctorArgs = rest.slice(1);
			if (subcommand === "doctor") {
				const supportedDoctorFlags = new Set(["--json", "--capabilities"]);
				const seenDoctorFlags = new Set<string>();
				const hasOnlySupportedDoctorArgs = doctorArgs.every((arg) => {
					if (!supportedDoctorFlags.has(arg) || seenDoctorFlags.has(arg)) {
						return false;
					}
					seenDoctorFlags.add(arg);
					return true;
				});
				if (!hasOnlySupportedDoctorArgs) {
					throw new Error(
						`Unsupported bootstrap doctor arguments: ${doctorArgs.join(" ")}`,
					);
				}
				const json = seenDoctorFlags.has("--json");
				const capabilities = seenDoctorFlags.has("--capabilities");
				if (capabilities) {
					const report =
						deps?.inspectCapabilities?.() ?? inspectCapabilities({ cwd });
					if (json) {
						stdout(formatJson(report));
					} else {
						for (const line of formatCapabilityReport(report)) {
							stdout(line);
						}
					}
					return report.ok ? 0 : 1;
				}
				const report =
					deps?.inspectBootstrapDoctor?.() ?? inspectBootstrapDoctor({ cwd });
				if (json) {
					stdout(formatJson(report));
				} else {
					for (const line of formatBootstrapDoctorReport(report)) {
						stdout(line);
					}
				}
				return report.ok ? 0 : 1;
			}
			if (subcommand === "seed") {
				const supportedSeedFlags = new Set(["--json"]);
				const seenSeedFlags = new Set<string>();
				const hasOnlySupportedSeedArgs = doctorArgs.every((arg) => {
					if (!supportedSeedFlags.has(arg) || seenSeedFlags.has(arg)) {
						return false;
					}
					seenSeedFlags.add(arg);
					return true;
				});
				if (!hasOnlySupportedSeedArgs) {
					throw new Error(
						`Unsupported bootstrap seed arguments: ${doctorArgs.join(" ")}`,
					);
				}
				const json = seenSeedFlags.has("--json");
				const storage = (await cliImport("@buildplane/storage")) as unknown as {
					createBuildplaneStorage: (
						root: string,
					) => Pick<BuildplaneStoragePort, "upsertRepoFact">;
				};
				const seeded = seedRepoFactsFromInspection(
					storage.createBuildplaneStorage(cwd),
					detectRepoSignals(cwd),
					{ branch: resolveCurrentBranch(cwd) },
				);
				if (json) {
					stdout(formatJson(seeded));
				} else if (seeded.length === 0) {
					stdout("No repo signals detected; nothing seeded.");
				} else {
					for (const fact of seeded) {
						stdout(`seeded ${fact.factKey} = ${String(fact.factValue)}`);
					}
				}
				return 0;
			}
			throw new Error(
				`Unknown bootstrap command: ${subcommand ?? "(missing subcommand)"}`,
			);
		}

		if (command === "planforge") {
			const subcommand = rest[0];
			if (isHelpRequested(rest)) {
				for (const line of formatPlanForgeHelp()) {
					stdout(line);
				}
				return 0;
			}
			if (subcommand === "admit") {
				return await runPlanForgeAdmitCommand(rest.slice(1), cwd, stdout);
			}
			if (subcommand === "dispatch") {
				return await runPlanForgeDispatchCommand(rest.slice(1), cwd, stdout);
			}
			if (subcommand === "resume") {
				return await runPlanForgeResumeCommand(rest.slice(1), cwd, stdout);
			}
			if (subcommand === "recover") {
				return await runPlanForgeRecoverCommand(rest.slice(1), cwd, stdout);
			}
			if (subcommand === "plan") {
				return await runPlanForgePlanCommand(rest.slice(1), cwd, stdout);
			}
			if (subcommand === "authorize-envelope") {
				return await runPlanForgeAuthorizeEnvelopeCommand(
					rest.slice(1),
					cwd,
					stdout,
				);
			}
			if (subcommand === "loop") {
				return await runPlanForgeLoopCommand(
					rest.slice(1),
					cwd,
					stdout,
					stderr,
					deps,
				);
			}
			if (subcommand !== "dry-run") {
				throw new Error(
					"Unsupported PlanForge command. Only dry-run, admit, dispatch, resume, recover, plan, loop, and authorize-envelope are available; other non-dry-run PlanForge forms are intentionally disabled.",
				);
			}
			const subRest = rest.slice(1);
			if (
				subRest.some((arg) =>
					["--write", "--execute", "--admit"].some(
						(flag) => arg === flag || arg.startsWith(`${flag}=`),
					),
				)
			) {
				throw new Error(
					"Unsupported PlanForge dry-run arguments: write, execute, and admit side-effect forms are disabled.",
				);
			}
			if (!subRest.includes("--json")) {
				throw new Error(
					"PlanForge dry-run requires --json for stable review output.",
				);
			}
			const inputPath = readFlag(subRest, "--input");
			if (!inputPath) {
				throw new Error(
					"Missing required --input <file> argument for PlanForge dry-run.",
				);
			}
			const plan = createPlanForgeDryRunPlan(resolve(cwd, inputPath));
			stdout(formatJson(plan));
			return plan.validation.status === PLANFORGE_VALIDATION_STATUS_PASS
				? 0
				: 1;
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
			if (subcommand === "promote") {
				const subRest = rest.slice(1);
				if (isHelpRequested(subRest)) {
					for (const line of formatMemoryPromoteHelp()) {
						stdout(line);
					}
					return 0;
				}
				const json = subRest.includes("--json");
				const receiptLikeArgs = subRest.filter(
					(arg) => arg === "--receipt" || arg.startsWith("--receipt="),
				);
				if (receiptLikeArgs.length === 0) {
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
				const receiptFlagIndexes = subRest.reduce<number[]>(
					(indexes, arg, index) => {
						if (arg === "--receipt") {
							indexes.push(index);
						}
						return indexes;
					},
					[],
				);
				const failUnsupportedReceiptArgs = (
					args: readonly string[],
				): number => {
					const msg = `Unsupported arguments for memory promote --receipt: ${args.join(" ")}.`;
					if (json) {
						stdout(formatJson(formatJsonError("UNSUPPORTED_ARGUMENTS", msg)));
					} else {
						stderr(msg);
					}
					return 1;
				};
				if (receiptFlagIndexes.length !== 1) {
					return failUnsupportedReceiptArgs(
						subRest.filter((arg) => arg !== "--json"),
					);
				}
				const receiptIndex = receiptFlagIndexes[0];
				const receiptId = subRest[receiptIndex + 1];
				if (!receiptId || receiptId.startsWith("--")) {
					const msg =
						"Missing required --receipt <run-id> argument for memory promote.";
					if (json) {
						stdout(formatJson(formatJsonError("MISSING_ARGUMENT", msg)));
					} else {
						stderr(msg);
					}
					return 1;
				}
				const unsupportedArgs = subRest.filter((arg, index) => {
					if (arg === "--json" || arg === "--receipt") {
						return false;
					}
					if (arg.startsWith("--receipt=")) {
						return true;
					}
					return index !== receiptIndex + 1;
				});
				if (unsupportedArgs.length > 0) {
					return failUnsupportedReceiptArgs(unsupportedArgs);
				}
				const promotion = await promoteMemoryFromReceipt(cwd, receiptId);
				if (json) {
					stdout(formatJson(promotion.report));
				} else if (promotion.ok) {
					for (const line of formatMemoryPromotionHuman(promotion.report)) {
						stdout(line);
					}
				} else {
					const failedPromotion = promotion as {
						readonly ok: false;
						readonly report: ReceiptNotAcceptedReport;
					};
					stderr(failedPromotion.report.error.message);
				}
				return promotion.ok ? 0 : 1;
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
			if (subcommand === "facts") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const optionError = validateMemoryListOptions(subRest, {
					valued: ["--scope"],
				});
				if (optionError) {
					if (json) {
						stdout(
							formatJson(
								formatJsonError(optionError.code, optionError.message),
							),
						);
					} else {
						stderr(optionError.message);
					}
					return 1;
				}
				const scopeIdx = subRest.indexOf("--scope");
				const scopeType =
					scopeIdx >= 0
						? (subRest[
								scopeIdx + 1
							] as import("@buildplane/kernel").MemoryScopeType)
						: undefined;
				let facts: ReturnType<MemoryListPortLike["listRepoFacts"]> = [];
				const storagePort = await loadStoragePort(cwd);
				if (storagePort) {
					facts = storagePort.listRepoFacts(
						scopeType ? { scopeType } : undefined,
					);
				}
				if (json) {
					stdout(formatJson(facts));
				} else {
					for (const line of formatRepoFactsList(facts)) {
						stdout(line);
					}
				}
				return 0;
			}
			if (subcommand === "procedures") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const optionError = validateMemoryListOptions(subRest, {
					valued: ["--task-type"],
				});
				if (optionError) {
					if (json) {
						stdout(
							formatJson(
								formatJsonError(optionError.code, optionError.message),
							),
						);
					} else {
						stderr(optionError.message);
					}
					return 1;
				}
				const taskTypeIdx = subRest.indexOf("--task-type");
				const taskType =
					taskTypeIdx >= 0 ? subRest[taskTypeIdx + 1] : undefined;
				let procedures: ReturnType<MemoryListPortLike["listProcedures"]> = [];
				const storagePort = await loadStoragePort(cwd);
				if (storagePort) {
					procedures = storagePort.listProcedures(
						taskType ? { taskType } : undefined,
					);
				}
				if (json) {
					stdout(formatJson(procedures));
				} else {
					for (const line of formatProceduresList(procedures)) {
						stdout(line);
					}
				}
				return 0;
			}
			if (subcommand === "episodes") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const runId = subRest.find((arg) => !arg.startsWith("--"));
				const optionError = validateMemoryListOptions(
					runId ? subRest.filter((arg) => arg !== runId) : subRest,
					{ valued: ["--limit"] },
				);
				if (optionError) {
					if (json) {
						stdout(
							formatJson(
								formatJsonError(optionError.code, optionError.message),
							),
						);
					} else {
						stderr(optionError.message);
					}
					return 1;
				}
				if (!runId) {
					const msg = "Missing required <runId> argument for memory episodes.";
					if (json) {
						stdout(formatJson(formatJsonError("MISSING_ARGUMENT", msg)));
					} else {
						stderr(msg);
					}
					return 1;
				}
				const limitIdx = subRest.indexOf("--limit");
				const limitRaw = limitIdx >= 0 ? subRest[limitIdx + 1] : undefined;
				const limit =
					limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
				if (limit !== undefined && (Number.isNaN(limit) || limit < 0)) {
					const msg = `Invalid value for --limit: ${limitRaw}.`;
					if (json) {
						stdout(formatJson(formatJsonError("INVALID_ARGUMENT", msg)));
					} else {
						stderr(msg);
					}
					return 1;
				}
				let events: ReturnType<MemoryListPortLike["listEvents"]> = [];
				const storagePort = await loadStoragePort(cwd);
				if (storagePort) {
					events = storagePort.listEvents(
						limit !== undefined ? { runId, limit } : { runId },
					);
				}
				if (json) {
					stdout(formatJson(events));
				} else {
					for (const line of formatEventsList(events)) {
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

		if (command === "replay" && isHelpRequested(rest)) {
			for (const line of formatReplayHelp()) {
				stdout(line);
			}
			return 0;
		}

		if (command === "pack" && (rest[0] === "show" || rest[0] === "export")) {
			const packAction = rest[0];
			try {
				return await (deps?.runNativeCommand ?? runNativeCommand)(
					rest.slice(1),
					{
						cwd,
						commandPath: ["pack", packAction],
						stdout,
						stderr,
					},
				);
			} catch (error) {
				throw createNativeDispatchError(["pack", packAction], error);
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

		if (command === "goal") {
			const trustedBaseOverride = readFlag(rest, "--trusted-base");
			const goalParts: string[] = [];
			for (let i = 0; i < rest.length; i++) {
				if (rest[i] === "--trusted-base") {
					// Mirror readFlag: only consume the next token as the value when
					// it isn't itself a flag, so `--trusted-base --other` doesn't
					// silently swallow `--other` from the goal text.
					const next = rest[i + 1];
					if (next !== undefined && !next.startsWith("--")) {
						i++;
					}
					continue;
				}
				goalParts.push(rest[i]);
			}
			const goalText = goalParts.join(" ").trim();
			if (!goalText) {
				stderr('Missing required goal text. Usage: bp goal "<text>"');
				return 1;
			}
			const result = buildGoalPlan({
				goal: goalText,
				cwd,
				trustedBaseOverride,
				stdout,
				stderr,
			});
			stdout(formatJson(result));
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

		if (command === "verify") {
			if (isHelpRequested(rest)) {
				for (const line of formatVerifyHelp()) {
					stdout(line);
				}
				return 0;
			}
			const json = rest.includes("--json");
			const runIndex = rest.indexOf("--run");
			if (runIndex === -1 || !rest[runIndex + 1]) {
				throw new Error("Missing required --run <id> argument.");
			}
			const runId = rest[runIndex + 1];
			const storage = (await cliImport("@buildplane/storage")) as unknown as {
				verifyRunFinalVerdict: (
					root: string,
					options: { runId: string },
				) => { verdict: string; runId: string } & Record<string, unknown>;
			};
			const report = storage.verifyRunFinalVerdict(cwd, { runId });
			if (json) {
				stdout(formatJson(report));
			} else {
				stdout(`verify: ${report.verdict}`);
				stdout(`run-id: ${report.runId}`);
			}
			return report.verdict === "PASSED" ? 0 : 1;
		}

		if (command === "evidence") {
			const subcommand = rest[0];
			if (isHelpRequested(rest)) {
				for (const line of formatEvidenceHelp()) {
					stdout(line);
				}
				return 0;
			}

			if (subcommand === "export") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const runIndex = subRest.indexOf("--run");
				const outIndex = subRest.indexOf("--out");
				if (runIndex === -1 || !subRest[runIndex + 1]) {
					throw new Error("Missing required --run <id> argument.");
				}
				if (outIndex === -1 || !subRest[outIndex + 1]) {
					throw new Error("Missing required --out <path> argument.");
				}

				const runId = subRest[runIndex + 1];
				const outPath = resolve(cwd, subRest[outIndex + 1]);
				const storage = (await cliImport("@buildplane/storage")) as unknown as {
					exportRunBundle: (
						root: string,
						options: { runId: string; outPath: string },
					) => Record<string, unknown>;
				};
				const bundle = storage.exportRunBundle(cwd, { runId, outPath });
				if (json) {
					stdout(formatJson(bundle));
				} else {
					stdout("evidence-export: wrote");
					stdout(`run-id: ${runId}`);
					stdout(`out: ${outPath}`);
				}
				return 0;
			}

			throw new Error(
				`Unknown evidence command: ${subcommand ?? "(missing subcommand)"}`,
			);
		}

		if (command === "trace") {
			const subcommand = rest[0];
			if (isHelpRequested(rest)) {
				for (const line of formatTraceHelp()) {
					stdout(line);
				}
				return 0;
			}

			if (subcommand === "export") {
				const subRest = rest.slice(1);
				const json = subRest.includes("--json");
				const runIndex = subRest.indexOf("--run");
				const formatIndex = subRest.indexOf("--format");
				const outIndex = subRest.indexOf("--out");
				if (runIndex === -1 || !subRest[runIndex + 1]) {
					throw new Error("Missing required --run <id> argument.");
				}
				if (formatIndex === -1 || !subRest[formatIndex + 1]) {
					throw new Error("Missing required --format otel-json argument.");
				}
				if (subRest[formatIndex + 1] !== "otel-json") {
					throw new Error("Unsupported trace format. Supported: otel-json.");
				}
				if (outIndex === -1 || !subRest[outIndex + 1]) {
					throw new Error("Missing required --out <path> argument.");
				}

				const runId = subRest[runIndex + 1];
				const outPath = resolve(cwd, subRest[outIndex + 1]);
				const storage = (await cliImport("@buildplane/storage")) as unknown as {
					createBuildplaneStorage: (root: string) => {
						inspectTarget: (id: string) => unknown;
					};
				};
				const snapshot = storage
					.createBuildplaneStorage(cwd)
					.inspectTarget(runId);
				const exportResult = createOtelTraceExport(
					snapshot as Parameters<typeof createOtelTraceExport>[0],
					outPath,
				);
				mkdirSync(dirname(outPath), { recursive: true });
				writeFileSync(
					outPath,
					JSON.stringify(exportResult.trace, null, 2),
					"utf8",
				);
				const summary = {
					format: exportResult.format,
					runId: exportResult.runId,
					spanCount: exportResult.spanCount,
					outPath: exportResult.outPath,
					traceGrading: exportResult.traceGrading,
				};
				if (json) {
					stdout(formatJson(summary));
				} else {
					stdout("trace-export: wrote");
					stdout(`run-id: ${runId}`);
					stdout(`format: ${exportResult.format}`);
					stdout(`spans: ${exportResult.spanCount}`);
					stdout(`out: ${outPath}`);
				}
				return 0;
			}

			throw new Error(
				`Unknown trace command: ${subcommand ?? "(missing subcommand)"}`,
			);
		}

		if (command === "pr-check") {
			const subcommand = rest[0];
			if (isHelpRequested(rest)) {
				for (const line of formatPrCheckHelp()) {
					stdout(line);
				}
				return 0;
			}
			const subRest = rest.slice(1);
			const json = subRest.includes("--json");
			if (subcommand !== "dry-run" && subcommand !== "publish") {
				throw new Error(
					`Unknown pr-check command: ${subcommand ?? "(missing subcommand)"}`,
				);
			}

			const runId = requireFlag(subRest, "--run", "--run <id>");
			const repository = requireFlag(subRest, "--repo", "--repo <owner/repo>");
			const headSha = requireHeadSha(subRest);
			const name = readFlag(subRest, "--name");
			const detailsUrl = readFlag(subRest, "--details-url");
			const storage = (await cliImport("@buildplane/storage")) as unknown as {
				verifyRunFinalVerdict: (
					root: string,
					options: { runId: string },
				) => { verdict: string; runId: string } & Record<string, unknown>;
			};
			const report = storage.verifyRunFinalVerdict(cwd, { runId });

			if (subcommand === "dry-run") {
				const preview = planPrCheckOperation({
					report,
					repository,
					headSha,
					name,
					detailsUrl,
				});
				if (json) {
					stdout(formatJson(preview));
				} else {
					for (const line of formatPrCheckHuman(preview)) {
						stdout(line);
					}
				}
				return 0;
			}

			const grantFile = requireFlag(
				subRest,
				"--grant-file",
				"--grant-file <file>",
			);
			const grantId = requireFlag(subRest, "--grant-id", "--grant-id <id>");
			const credentialEnv =
				readFlag(subRest, "--credential-env") ?? "GITHUB_TOKEN";
			const grants = loadCapabilityGrantsFromJson(
				JSON.parse(readFileSync(resolve(cwd, grantFile), "utf8")),
			);
			const published = await publishPrCheckOperation({
				report,
				repository,
				headSha,
				name,
				detailsUrl,
				grants,
				grantId,
				credential: () => process.env[credentialEnv] ?? "",
				request: deps?.publishPrCheckRequest ?? defaultPrCheckRequest,
			});
			if (json) {
				stdout(formatJson(published));
			} else {
				for (const line of formatPrCheckHuman(published)) {
					stdout(line);
				}
			}
			return 0;
		}

		if (command === "pr-comment") {
			const subcommand = rest[0];
			if (isHelpRequested(rest)) {
				for (const line of formatPrCommentHelp()) {
					stdout(line);
				}
				return 0;
			}
			const subRest = rest.slice(1);
			const json = subRest.includes("--json");
			if (subcommand !== "dry-run" && subcommand !== "publish") {
				throw new Error(
					`Unknown pr-comment command: ${subcommand ?? "(missing subcommand)"}`,
				);
			}

			const runId = requireFlag(subRest, "--run", "--run <id>");
			const repository = requireFlag(subRest, "--repo", "--repo <owner/repo>");
			const prNumber = requirePrNumber(subRest);
			const headSha = requireHeadSha(subRest);
			const detailsUrl = readFlag(subRest, "--details-url");
			const bundleUrl = readFlag(subRest, "--bundle-url");
			const storage = (await cliImport("@buildplane/storage")) as unknown as {
				verifyRunFinalVerdict: (
					root: string,
					options: { runId: string },
				) => { verdict: string; runId: string } & Record<string, unknown>;
			};
			const report = storage.verifyRunFinalVerdict(cwd, { runId });

			if (subcommand === "dry-run") {
				const preview = planPrCommentOperation({
					report,
					repository,
					prNumber,
					headSha,
					detailsUrl,
					bundleUrl,
				});
				if (json) {
					stdout(formatJson(preview));
				} else {
					for (const line of formatPrCommentHuman(preview)) {
						stdout(line);
					}
				}
				return 0;
			}

			const grantFile = requireFlag(
				subRest,
				"--grant-file",
				"--grant-file <file>",
			);
			const grantId = requireFlag(subRest, "--grant-id", "--grant-id <id>");
			const credentialEnv =
				readFlag(subRest, "--credential-env") ?? "GITHUB_TOKEN";
			const grants = loadCapabilityGrantsFromJson(
				JSON.parse(readFileSync(resolve(cwd, grantFile), "utf8")),
			);
			const published = await publishPrCommentOperation({
				report,
				repository,
				prNumber,
				headSha,
				detailsUrl,
				bundleUrl,
				grants,
				grantId,
				credential: () => process.env[credentialEnv] ?? "",
				verifyPrHead: deps?.verifyPrHeadRequest ?? defaultPrHeadVerifier,
				request: deps?.publishPrCommentRequest ?? defaultPrCommentRequest,
			});
			if (json) {
				stdout(formatJson(published));
			} else {
				for (const line of formatPrCommentHuman(published)) {
					stdout(line);
				}
			}
			return 0;
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

		if (command === "web") {
			const check = rest.includes("--check");
			const allowExternal = rest.includes("--allow-external");
			const portRaw = readFlag(rest, "--port");
			let port = DEFAULT_WEB_PORT;
			if (portRaw !== undefined) {
				port = Number.parseInt(portRaw, 10);
				if (!Number.isInteger(port) || port < 0 || port > 65535) {
					stderr(`Invalid --port value: ${portRaw}`);
					return 1;
				}
			}

			const webOptions: WebCommandOptions = {
				cwd: resolvedCwd,
				port,
				check,
				allowExternal,
				stdout,
				stderr,
			};
			if (deps?.runWebCommand) {
				return deps.runWebCommand(webOptions);
			}

			// SIGINT/SIGTERM ⇒ graceful close (the served process otherwise runs
			// until the host is terminated). `--check` never reaches the wait.
			const controller = new AbortController();
			const onSignal = () => controller.abort();
			process.once("SIGINT", onSignal);
			process.once("SIGTERM", onSignal);
			try {
				return await executeWebCommand(
					{ ...webOptions, signal: controller.signal },
					{
						loadServerModule: () =>
							import("@buildplane/mission-control-server"),
						loadDeps: async (root) => {
							const { orchestrator } = await loadCliOrchestrator(root);
							const storageModule = (await cliImport(
								"@buildplane/storage",
							)) as {
								createBuildplaneStorage: (dir: string) => MissionControlStore;
							};
							// The orchestrator from `loadCliOrchestrator` already owns the
							// ledger-backed OperatorDecisionPort (it defaults to
							// `createOperatorDecisionPort(root)`); the decision route emits
							// through `orchestrator.recordOperatorDecision`, so the server
							// deps intentionally carry no separate port (see web-command.ts).
							return {
								orchestrator:
									orchestrator as unknown as MissionControlOrchestrator,
								store: storageModule.createBuildplaneStorage(root),
							};
						},
					},
				);
			} finally {
				process.removeListener("SIGINT", onSignal);
				process.removeListener("SIGTERM", onSignal);
			}
		}

		// Deferred activity-bracket port (M2-S5): the run orchestrator is constructed
		// here, BEFORE the run-block signed ledger emitter is spawned (~200 lines down,
		// gated on `useLedger`). The port reads the emitter lazily at activity time, by
		// which point the run block has bound it (or left it null for a non-ledger run,
		// in which case bracketing is skipped — byte-unchanged).
		//
		// SCOPE NOTE: the default strategy path (`!useRaw`) returns before the emitter
		// bind, and is unledgered by construction (pre-existing — `events.db` is empty
		// without `--raw`), so its activities are intentionally NOT bracketed: the
		// deferred port no-ops there. S5 bracketing covers the `--raw` run path +
		// `planforge dispatch`. Bracketing the strategy/default run path would require
		// giving it a signed ledger subprocess (a tracked follow-up; it also gates
		// whether default runs are crash-recoverable for the M6 demo).
		let runActivityEmitter: TapeEmitter | null = null;
		const runLedgerActivityPort = createDeferredLedgerActivityPort(
			() => runActivityEmitter,
		);
		// Per-tool-call ledger sink for the Claude worker (M6-S8). Bound to the
		// concrete ledger-backed emitter once the run-block tape is spawned
		// (~200 lines down); this stable wrapper reads it lazily, mirroring
		// `runActivityEmitter`. Null on a non-ledger run → tool blocks no-op.
		let runClaudeToolSink: ((event: ClaudeToolEvent) => void) | null = null;
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
			: await loadCliOrchestrator(cwd, {
					ledgerActivityPort: runLedgerActivityPort,
					onClaudeToolEvent: (event) => runClaudeToolSink?.(event),
				});
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

				const useRaw = rest.includes("--raw");
				const useJson = rest.includes("--json");

				// ── Strategy path (default) ──────────────────────────────
				if (!useRaw) {
					const { wrapAsStrategy } = await import("./strategy-wrapper.js");
					const { preparePacketMemoryEnrichment } =
						await loadPacketEnrichmentModule();

					// Enrich the implementer packet exactly as the single-packet
					// path does, then wrap it so the executed implementer leg carries
					// its memory context. The reviewer child is enriched on top below
					// without re-enriching the implementer.
					const preparedImplementer = await preparePacketMemoryEnrichment(
						packet,
						memoryPort,
						honchoAdapter,
						userId,
						structuredMemoryPort,
						currentBranch,
					);
					const enrichedImplementer = preparedImplementer.packet;
					const implementerUnitId =
						(enrichedImplementer as { unit?: { id?: string } }).unit?.id ??
						(packet as { unit?: { id?: string } }).unit?.id ??
						"";

					const baseStrategy = wrapAsStrategy(
						enrichedImplementer as Parameters<typeof wrapAsStrategy>[0],
					) as unknown as {
						children: Array<{ role: string; packet: unknown }>;
					};

					const injectedMemoriesByUnitId: InjectedMemoryRecordsByUnitId = {};
					if (preparedImplementer.injectedMemories.length > 0) {
						injectedMemoriesByUnitId[implementerUnitId] =
							preparedImplementer.injectedMemories;
					}

					const enrichedChildren = await Promise.all(
						baseStrategy.children.map(async (child) => {
							if (child.role !== "reviewer") {
								return child;
							}
							const preparedReviewer = await preparePacketMemoryEnrichment(
								child.packet,
								memoryPort,
								honchoAdapter,
								userId,
								structuredMemoryPort,
								currentBranch,
							);
							const reviewerUnitId = (
								child.packet as { unit?: { id?: string } }
							).unit?.id;
							if (
								reviewerUnitId &&
								preparedReviewer.injectedMemories.length > 0
							) {
								injectedMemoriesByUnitId[reviewerUnitId] =
									preparedReviewer.injectedMemories;
							}
							return { ...child, packet: preparedReviewer.packet };
						}),
					);
					const preparedStrategy = {
						strategy: {
							...baseStrategy,
							children: enrichedChildren,
						} as unknown as Record<string, unknown>,
						injectedMemoriesByUnitId,
					};

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
						preparedStrategy.strategy,
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

				// Raw path enriches the single packet directly (no strategy children).
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
				const ledgerRunId = newEventId();
				const ledgerWorkspacePath = resolvedCwd;

				// Unit-context tracker: mutable state that getUnitCtx returns on demand.
				// Updated by the unit-boundary subscription below.
				let currentUnit: LedgerUnitContext | null = null;
				let runStartEventId: string | undefined;
				const getUnitCtx = () => currentUnit;

				if (useLedger) {
					try {
						// Activity bracketing rides a kernel-signed tape (D2). Fail fast if
						// the kernel key is missing rather than letting the signed subprocess
						// die opaquely.
						assertKernelSigningKey();
						const binary = resolveLedgerBinary(cwd);
						ledgerChild = spawnLedgerSubprocess(
							binary,
							ledgerRunId,
							resolvedCwd,
							{ sign: true, signingKeyId: PLANFORGE_KERNEL_SIGNING_KEY_ID },
						);
						ledgerEmitter = await createTapeEmitter({
							childStdin: ledgerChild.stdin,
							childStderr: ledgerChild.stderr,
							childExit: ledgerChild.exit,
							workspacePath: resolvedCwd,
							runId: ledgerRunId,
						});
						// Bind the signed emitter so the deferred activity-bracket port
						// (passed into the orchestrator above) emits onto this tape.
						runActivityEmitter = ledgerEmitter;
						// Bind the per-tool-call sink so the Claude worker's stream
						// `tool_use`/`tool_result` blocks land on this signed tape (M6-S8).
						// `ledgerWorkspacePath` (== resolvedCwd) is the run's workspace
						// cwd the worker's tools execute against → `working_directory`.
						runClaudeToolSink = createClaudeToolLedgerEmitter(
							ledgerEmitter,
							getUnitCtx,
							ledgerWorkspacePath,
						);
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
						unsubscribeLedger = cliEventBus.subscribe((evt: unknown) => {
							if (!ledgerEmitter) return;
							const e = evt as {
								kind?: string;
								unitId?: string;
								exitCode?: number;
								executionType?: "command" | "model";
							};
							switch (e.kind) {
								case "execution-started": {
									// Unit-level start. If a previous attempt is still open, close it
									// as failed before starting the new attempt.
									const unitId = e.unitId ?? "unknown";
									currentUnit = completeLedgerUnit(
										ledgerEmitter,
										ledgerRunId,
										ledgerWorkspacePath,
										currentUnit,
										"failed",
									);
									currentUnit = beginLedgerUnit(
										ledgerEmitter,
										ledgerRunId,
										ledgerWorkspacePath,
										unitId,
										e.executionType ?? "command",
										runStartEventId,
									);
									break;
								}
								case "command-execution-complete": {
									currentUnit = completeLedgerUnit(
										ledgerEmitter,
										ledgerRunId,
										ledgerWorkspacePath,
										currentUnit,
										e.exitCode === 0 ? "passed" : "failed",
									);
									break;
								}
								case "model-response-complete": {
									// Do not finalize the ledger unit here. Some async model executors
									// can emit a response event and still finish the overall run as
									// failed (for example budget-aborted streams). Leave the unit
									// open so cleanup can close it using the final run outcome.
									break;
								}
								case "execution-error": {
									currentUnit = completeLedgerUnit(
										ledgerEmitter,
										ledgerRunId,
										ledgerWorkspacePath,
										currentUnit,
										"failed",
									);
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
				const ledgerRunOptions = ledgerEmitter
					? { runId: ledgerRunId }
					: undefined;

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
				let originalExecutePacket:
					| ((packetUnknown: unknown, executionRoot: string) => unknown)
					| undefined;
				const makeReceipt = (
					packetUnknown: unknown,
					executionRoot: string,
					ledgerEmitterForCommand: TapeEmitter,
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
					const perCallRawRegistry = createToolRegistry(
						workspaceRoot,
						toolRegistryOptionsForPacket(packetUnknown, {
							emitter: ledgerEmitterForCommand,
							runId: ledgerRunId,
						}),
					);
					const perCallRegistry = wrapToolRegistryForLedger(
						perCallRawRegistry,
						ledgerEmitterForCommand,
						runGetUnitCtx,
					);
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
					const realWorkspaceRoot = (() => {
						try {
							return fsRealpathSync(workspaceRoot);
						} catch {
							return workspaceRoot;
						}
					})();
					const outputChecks = p.verification.requiredOutputs.map(
						(outputPath: string) => {
							const outputResult = resolveContainedPath(
								realWorkspaceRoot,
								outputPath,
							);
							return {
								path: outputPath,
								exists: outputResult.ok && fsExistsSync(outputResult.path),
							};
						},
					);
					for (const check of outputChecks) {
						if (!check.exists) {
							continue;
						}
						try {
							const sourceResult = resolveContainedPath(
								realWorkspaceRoot,
								check.path,
							);
							const destinationResult = resolveContainedPath(
								vcrOutputStoreRoot(resolvedCwd, ledgerRunId),
								check.path,
							);
							if (!sourceResult.ok || !destinationResult.ok) {
								continue;
							}
							const source = sourceResult.path;
							if (!statSync(source).isFile()) {
								continue;
							}
							const realSource = fsRealpathSync(source);
							if (!isPathBelowRoot(realWorkspaceRoot, realSource)) {
								continue;
							}
							const destination = destinationResult.path;
							const destinationParent = ensureContainedDirectory(
								resolvedCwd,
								dirname(destination),
								fsRealpathSync,
							);
							if (!destinationParent.ok) {
								continue;
							}
							const realDestinationRoot = fsRealpathSync(
								vcrOutputStoreRoot(resolvedCwd, ledgerRunId),
							);
							if (
								!isPathAtOrBelowRoot(
									realDestinationRoot,
									fsRealpathSync(dirname(destination)),
								)
							) {
								continue;
							}
							copyFileSync(source, destination);
						} catch {
							// VCR output capture is opportunistic; the authoritative run
							// receipt below still records whether the required output existed.
						}
					}
					return {
						command: p.execution.command,
						args: [...(p.execution.args ?? [])],
						cwd: effectiveCwd,
						startedAt,
						completedAt,
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
						outputChecks,
					};
				};
				if (runLedgerEmitter) {
					const activeLedgerEmitter = runLedgerEmitter;
					originalExecutePacket = commandExecutor.executePacket;
					commandExecutor.executePacket = (
						packetUnknown: unknown,
						root: string,
					) => makeReceipt(packetUnknown, root, activeLedgerEmitter);
				}
				const runStartMs = Date.now();

				if (useAsync && !useTui) {
					// Model packets auto-switch to async (no TUI)
					let asyncOrchestratorResult:
						| Awaited<ReturnType<typeof orchestrator.runPacketAsync>>
						| undefined;
					let asyncResultUnknown: unknown;
					const packetHash = `sha256:${createHash("sha256")
						.update(JSON.stringify(enrichedPacket))
						.digest("hex")}`;
					try {
						runStartEventId = emitLedgerRunStarted(
							ledgerEmitter,
							packetHash,
							resolvedCwd,
							null,
						);
						asyncOrchestratorResult = await orchestrator.runPacketAsync(
							enrichedPacket,
							cliEventBus,
							ledgerRunOptions,
						);
						asyncResultUnknown = withPersistedInjectedMemories(
							asyncOrchestratorResult,
							structuredMemoryPort,
							preparedPacket.injectedMemories,
						);
						emitLedgerRunCompleted(
							ledgerEmitter,
							asyncOrchestratorResult.run.status === "passed"
								? "passed"
								: "failed",
							Date.now() - runStartMs,
						);
					} finally {
						// --- begin ledger cleanup ---
						if (ledgerEmitter) {
							currentUnit = completeLedgerUnit(
								ledgerEmitter,
								ledgerRunId,
								ledgerWorkspacePath,
								currentUnit,
								asyncOrchestratorResult?.run?.status === "passed"
									? "passed"
									: "failed",
							);
						}
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
						if (originalExecutePacket) {
							commandExecutor.executePacket = originalExecutePacket;
						}
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
					const tui = (await cliImport("@buildplane/ui-tui")) as unknown as {
						renderTui: (eventBus: unknown) => {
							waitUntilExit(): Promise<void>;
							unmount(): void;
							clear(): void;
						};
					};

					const tuiBus = cliEventBus;

					const tuiInstance = tui.renderTui(tuiBus);

					let tuiResult:
						| Awaited<ReturnType<typeof orchestrator.runPacketAsync>>
						| undefined;
					const packetHash = `sha256:${createHash("sha256")
						.update(JSON.stringify(enrichedPacket))
						.digest("hex")}`;
					const tuiStartMs = Date.now();
					try {
						runStartEventId = emitLedgerRunStarted(
							ledgerEmitter,
							packetHash,
							resolvedCwd,
							null,
						);
						tuiResult = await orchestrator.runPacketAsync(
							enrichedPacket,
							tuiBus,
							ledgerRunOptions,
						);
						emitLedgerRunCompleted(
							ledgerEmitter,
							tuiResult.run.status === "passed" ? "passed" : "failed",
							Date.now() - tuiStartMs,
						);
					} finally {
						// --- begin ledger cleanup ---
						if (ledgerEmitter) {
							currentUnit = completeLedgerUnit(
								ledgerEmitter,
								ledgerRunId,
								ledgerWorkspacePath,
								currentUnit,
								tuiResult?.run?.status === "passed" ? "passed" : "failed",
							);
						}
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
						if (originalExecutePacket) {
							commandExecutor.executePacket = originalExecutePacket;
						}
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
				const packetHash = `sha256:${createHash("sha256")
					.update(JSON.stringify(enrichedPacket))
					.digest("hex")}`;
				try {
					// Emit run_started directly for the sync path (runPacket does not use the
					// event bus, so we cannot rely on bus subscription here).
					runStartEventId = emitLedgerRunStarted(
						ledgerEmitter,
						packetHash,
						resolvedCwd,
						null,
					);
					syncResultUnknown = withPersistedInjectedMemories(
						useAsync
							? await orchestrator.runPacketAsync(
									enrichedPacket,
									cliEventBus,
									ledgerRunOptions,
								)
							: orchestrator.runPacket(
									enrichedPacket,
									cliEventBus,
									ledgerRunOptions,
								),
						structuredMemoryPort,
						preparedPacket.injectedMemories,
					);
					// Emit run_completed on success.
					const r = syncResultUnknown as { run?: { status?: string } };
					const outcome = r.run?.status === "passed" ? "passed" : "failed";
					emitLedgerRunCompleted(
						ledgerEmitter,
						outcome,
						Date.now() - runStartMs,
					);
				} finally {
					// --- begin ledger cleanup ---
					if (ledgerEmitter) {
						currentUnit = completeLedgerUnit(
							ledgerEmitter,
							ledgerRunId,
							ledgerWorkspacePath,
							currentUnit,
							(syncResultUnknown as { run?: { status?: string } } | undefined)
								?.run?.status === "passed"
								? "passed"
								: "failed",
						);
					}
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
					if (originalExecutePacket) {
						commandExecutor.executePacket = originalExecutePacket;
					}
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
				const viewIndex = rest.indexOf("--view");
				const inlineView = rest.find((value) => value.startsWith("--view="));
				const view =
					inlineView?.slice("--view=".length) ??
					(viewIndex >= 0 ? rest[viewIndex + 1] : "detail");
				if (viewIndex >= 0 && (!view || view.startsWith("--"))) {
					throw new Error("Missing required inspect view after --view.");
				}
				if (view !== "detail" && view !== "inspector") {
					throw new Error(
						`Unsupported inspect view '${view}'. Supported views: detail, inspector.`,
					);
				}
				const id = rest.find((value, index) => {
					if (value === "--json" || value === "--view") return false;
					if (viewIndex >= 0 && index === viewIndex + 1) return false;
					if (value.startsWith("--view=")) return false;
					return !value.startsWith("--");
				});
				if (!id) {
					throw new Error("Missing required run or unit id for inspect.");
				}

				const result = orchestrator.inspect(id);
				if (view === "inspector") {
					const projection = createInspectorProjection(
						result as unknown as Parameters<
							typeof createInspectorProjection
						>[0],
					);
					if (json) {
						stdout(formatJson(projection));
					} else {
						for (const line of formatInspectorProjection(projection)) {
							stdout(line);
						}
					}
					return 0;
				}

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

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
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
		} else if (arg === "--policy") {
			const policyProfile = args[index + 1];
			if (policyProfile && !policyProfile.startsWith("--")) {
				const unit = (result.unit as Record<string, unknown>) ?? {};
				result.unit = { ...unit, policyProfile };
				index += 1;
			}
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

	if (/No run or unit found|No run found/i.test(message)) {
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
