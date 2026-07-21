import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
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

import {
	type AuthorizationEnvelopeV0,
	type BudgetConstraints,
	type BuildplaneAcceptancePort,
	type BuildplaneProfileRegistryPort,
	type BuildplaneStoragePort,
	type CandidateCreatedV2,
	canonicalGovernedUnitPacketV1Digest,
	type EnvelopeProposal,
	type LedgerActivityPort,
	type OperatorDecisionPort,
	type PolicyProfile,
	parseCandidateCreatedV2,
	parseGovernedUnitPacket,
	type RecordOperatorDecisionInput,
	type ResultReadyPort,
	type RunCompletionPort,
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
import { createDispatchToolUnitTracker } from "./dispatch-tool-unit-tracker.js";
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
import { tryGitInWorkspace } from "./git-in-workspace.js";
import { buildGoalPlan } from "./goal-command.js";
import {
	type HostOwnedCandidateApprovalV1,
	type HostOwnedCandidateSessionV1,
	type HostOwnedPlanForgeCandidateSessionV1,
	resolveHostOwnedGovernedBroker,
} from "./governed-authority-broker-host.js";
import { GOVERNED_AUTHORITY_BROKER_REQUIRED_CODE } from "./governed-ledger-authority.js";
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
import { createResultReadyPort } from "./ledger-result-ready.js";
import { createRunCompletionPort } from "./ledger-run-completed.js";
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
	seedTrustedBaseFromHead,
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
	buildPlanReceiptPayload,
	createPlanForgeDryRunPlan,
	DISPATCH_WORKER_MODEL,
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
		"    run --packet <path>    Compile and validate a governed-run preview (default)",
		'    goal "<text>" [--trusted-base <sha>]  Compile + preview a raw goal into plan JSON',
		"    demo --raw [--model]   Run the unsafe local flywheel demo",
		"",
		"  Observe:",
		"    status [--json]        Project health snapshot",
		"    history [--json]       List all runs",
		"    inspect <id> [--json] [--view inspector]  Deep-dive into a run and event tape",
		"    verify --run <id> [--json]  Final receipt-backed verdict",
		"    evidence export --run <id> --out <file>  Export Mission Control bundle",
		"    web [--port N] [--check] [--allow-external]  Serve the Mission Control web UI",
		"    trace export --run <id> --format otel-json --out <file>  Export unsafe local trace artifact",
		"    pr-check dry-run --run <id> --repo <owner/repo> --sha <head> [--json]  Preview GitHub check-run publish",
		"    pr-comment dry-run --run <id> --repo <owner/repo> --pr <n> --sha <head> [--json]  Preview PR evidence comment",
		"    replay <id> --raw [--json]  Re-execute an unsafe legacy packet snapshot",
		"    ledger replay --run-id <id> --workspace <path>  Read-only tape replay",
		"    ledger export-signed-tape --run-id <id> --workspace <path> --out <dir>  Export buildplane.signed-tape.v1",
		"    fork <id> --at <event> --packet <file> --raw    Unsafe legacy unit-boundary re-execution",
		"    planforge dry-run --input <file> --json          Emit dry-run plan artifact",
		"",
		"  Advanced:",
		"    run-graph --raw --graph <p>  Execute a DAG of tasks (unsafe legacy lane)",
		"    run-strategy --raw     Run a custom multi-role strategy (unsafe legacy lane)",
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
		"  buildplane run --help    Show governed-run options (--raw is unsafe)",
	];
}

function formatRunHelp(): string[] {
	return [
		"buildplane run --packet <path> [options]",
		"buildplane run --resume <opaque-recovery-reference> --approve [--json]",
		"",
		"  By default, Buildplane enters the governed front door.",
		"  It blocks in preview until a privileged host verifies the signed envelope,",
		"  tape, ActionGateway, and sandbox path; it never falls back to raw execution.",
		"",
		"  Options:",
		"    --approve        Request host-brokered governed admission; blocks until a privileged authority broker is available",
		"    --resume <ref>   Ask the privileged host to reconcile an existing workflow; requires --approve and cannot take a packet or envelope",
		"    --envelope <path> Supply a sealed DispatchEnvelopeV3 for host-verified preauthorized admission; the CLI checks only closed shape/digest and the host must verify its signed tape",
		"    --raw            Explicitly unsafe legacy execution; emits no trusted receipt",
		"    --tui            Interactive terminal UI (unsafe --raw lane only)",
		"    --json           Machine-readable output",
	];
}

interface PacketRunCommandArguments {
	readonly kind: "packet";
	readonly packetPath: string;
	readonly raw: boolean;
	readonly tui: boolean;
	readonly json: boolean;
	readonly approve: boolean;
	readonly envelopePath?: string;
}

/**
 * A recovery handle is resolved only by the privileged host. It intentionally
 * excludes packet and envelope source, which could otherwise replace the
 * recorded workflow identity or authority during reconciliation.
 */
interface RecoveryRunCommandArguments {
	readonly kind: "recovery-resume";
	readonly raw: false;
	readonly tui: false;
	readonly json: boolean;
	readonly approve: true;
	readonly recoveryReference: string;
}

type RunCommandArguments =
	| PacketRunCommandArguments
	| RecoveryRunCommandArguments;

interface DispatchEnvelopePreview {
	readonly schemaVersion: 1 | 2 | 3;
	/** Parsing is structural only; the native tape/reducer has not verified authority. */
	readonly verification: "structural_only";
	readonly workflowId: string;
	readonly unitId: string;
	readonly executionRole: string;
	readonly commitMode: string;
	readonly provenanceRef: string;
	readonly trustTier: string;
	readonly baseCommitSha: string;
	readonly expiresAt: string;
	readonly envelopeDigest: string;
	/** V3 binds this protocol selector into the envelope digest. */
	readonly actionEvidenceVersion?: "sealed-v2" | "sealed_v3";
	/** Required for newly issued sealed_v3 authority; compared with the original packet bytes before broker resolution. */
	readonly governedPacketDigest?: string;
}

interface LoadedDispatchEnvelopePreview {
	/** Exact bytes passed to the host after local structural validation. */
	readonly source: string;
	readonly preview: DispatchEnvelopePreview;
}

interface GovernedSandboxPreview {
	readonly state: "feasible" | "blocked";
	readonly governedWorkerExecution: "not_implemented";
	readonly host: {
		readonly platform: string;
		readonly environment: string;
		readonly isWsl: boolean;
	};
	readonly failures: readonly {
		readonly code: string;
	}[];
}

interface GovernedRunPreview {
	readonly governance: "preview";
	readonly status: "blocked";
	readonly executionStarted: false;
	readonly approval: {
		readonly requested: boolean;
		readonly state: "not-recorded";
	};
	readonly authorityBroker: {
		readonly state: "unavailable";
		readonly code: typeof GOVERNED_AUTHORITY_BROKER_REQUIRED_CODE;
	};
	readonly packet: {
		readonly unitId: string | null;
		readonly executionRole: string | null;
		/** Whether the raw source explicitly named the role, rather than inheriting the legacy parser default. */
		readonly executionRoleExplicit: boolean;
		readonly provenancePresent: boolean;
		readonly capabilityBundlePresent: boolean;
		readonly acceptanceContractPresent: boolean;
		readonly trustScopePresent: boolean;
	};
	readonly envelope?: DispatchEnvelopePreview;
	readonly sandbox: GovernedSandboxPreview;
	readonly blockers: readonly string[];
}

/**
 * The unsafe lane is intentionally opt-in. Keep this parser closed so a typo
 * cannot silently select an execution path with different authority.
 */
function parseRunCommandArguments(
	args: readonly string[],
): RunCommandArguments {
	const booleans = new Set(["--raw", "--tui", "--json", "--approve"]);
	const values = new Set(["--packet", "--envelope", "--resume"]);
	const seen = new Set<string>();
	let packetPath: string | undefined;
	let envelopePath: string | undefined;
	let recoveryReference: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (booleans.has(arg)) {
			if (seen.has(arg)) {
				throw new Error(`Duplicate run argument: ${arg}`);
			}
			seen.add(arg);
			continue;
		}

		if (values.has(arg)) {
			if (seen.has(arg)) {
				throw new Error(`Duplicate run argument: ${arg}`);
			}
			const value = args[index + 1];
			if (!value || value.startsWith("--")) {
				throw new Error(`Missing required value after ${arg}.`);
			}
			seen.add(arg);
			index += 1;
			if (arg === "--packet") {
				packetPath = value;
			} else if (arg === "--envelope") {
				envelopePath = value;
			} else {
				recoveryReference = value;
			}
			continue;
		}

		throw new Error(`Unsupported run argument: ${arg}`);
	}

	const raw = seen.has("--raw");
	const approve = seen.has("--approve");
	if (recoveryReference !== undefined) {
		if (
			recoveryReference.length > 256 ||
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(recoveryReference) ||
			recoveryReference.includes("..") ||
			recoveryReference.includes("//") ||
			recoveryReference.includes("@{")
		) {
			throw new Error(
				"--resume must be an opaque host-issued recovery reference, not a path or serialized authority.",
			);
		}
		if (!approve) {
			throw new Error(
				"--resume requires --approve to acknowledge host-mediated reconciliation.",
			);
		}
		if (
			packetPath !== undefined ||
			envelopePath !== undefined ||
			raw ||
			seen.has("--tui")
		) {
			throw new Error(
				"--resume cannot be combined with --packet, --envelope, --raw, or --tui because recovered authority comes only from the privileged host.",
			);
		}
		return {
			kind: "recovery-resume",
			raw: false,
			tui: false,
			json: seen.has("--json"),
			approve: true,
			recoveryReference,
		};
	}

	if (!packetPath) {
		throw new Error("Missing required --packet <path> argument.");
	}

	if (raw && (approve || envelopePath !== undefined)) {
		throw new Error(
			"--raw cannot be combined with --approve or --envelope because raw execution is outside the governed trust boundary.",
		);
	}
	if (!raw && seen.has("--tui")) {
		throw new Error(
			"--tui is available only with --raw until the governed worker action plane is configured.",
		);
	}

	return {
		kind: "packet",
		packetPath,
		raw,
		tui: seen.has("--tui"),
		json: seen.has("--json"),
		approve,
		...(envelopePath === undefined ? {} : { envelopePath }),
	};
}

interface RawLegacyPathCommandArguments {
	readonly path: string;
	readonly json: boolean;
}

/**
 * Parse legacy graph/strategy invocation without treating a flag value as a
 * separate acknowledgement.  `--raw` is an explicit unsafe authority choice,
 * not a filename that may be consumed by `--graph` or `--strategy`.
 */
function parseRawLegacyPathCommandArguments(
	args: readonly string[],
	input: {
		readonly command: "run-graph" | "run-strategy";
		readonly pathFlag: "--graph" | "--strategy";
		readonly supportsJson: boolean;
	},
): RawLegacyPathCommandArguments {
	const seen = new Set<string>();
	let path: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--raw" || (input.supportsJson && arg === "--json")) {
			if (seen.has(arg)) {
				throw new Error(`Duplicate ${input.command} argument: ${arg}`);
			}
			seen.add(arg);
			continue;
		}
		if (arg === input.pathFlag) {
			if (seen.has(arg)) {
				throw new Error(`Duplicate ${input.command} argument: ${arg}`);
			}
			const value = args[index + 1];
			if (!value || value.startsWith("--")) {
				throw new Error(`Missing required value after ${input.pathFlag}.`);
			}
			seen.add(arg);
			path = value;
			index += 1;
			continue;
		}
		throw new Error(`Unsupported ${input.command} argument: ${arg}`);
	}

	if (!seen.has("--raw")) {
		throw new Error(
			`${input.command} is a legacy ambient-worker path. Pass --raw to acknowledge unsafe execution; use buildplane run for governed preview/admission.`,
		);
	}
	if (path === undefined) {
		throw new Error(`Missing required ${input.pathFlag} <path> argument.`);
	}
	return { path, json: seen.has("--json") };
}

interface UnsafeReplayArguments {
	readonly runId: string;
	readonly json: boolean;
	readonly policyProfile?: string;
	readonly model?: string;
}

/**
 * Replay executes ambient workers, so parse it before touching storage or an
 * orchestrator. In particular a required option value can never double as
 * the standalone `--raw` acknowledgement.
 */
function parseUnsafeReplayArguments(
	args: readonly string[],
): UnsafeReplayArguments {
	const seen = new Set<string>();
	let runId: string | undefined;
	let policyProfile: string | undefined;
	let model: string | undefined;

	const readValue = (flag: "--policy" | "--model", index: number): string => {
		const value = args[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`Missing required value after ${flag}.`);
		}
		return value;
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--raw" || arg === "--json") {
			if (seen.has(arg)) {
				throw new Error(`Duplicate replay argument: ${arg}`);
			}
			seen.add(arg);
			continue;
		}
		if (arg === "--policy" || arg === "--model") {
			if (seen.has(arg)) {
				throw new Error(`Duplicate replay argument: ${arg}`);
			}
			const value = readValue(arg, index);
			seen.add(arg);
			if (arg === "--policy") policyProfile = value;
			else model = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--policy=") || arg.startsWith("--model=")) {
			const equalsIndex = arg.indexOf("=");
			const flag = arg.slice(0, equalsIndex) as "--policy" | "--model";
			const value = arg.slice(equalsIndex + 1);
			if (!value || value.startsWith("--") || seen.has(flag)) {
				throw new Error(
					!value || value.startsWith("--")
						? `Missing required value after ${flag}.`
						: `Duplicate replay argument: ${flag}`,
				);
			}
			seen.add(flag);
			if (flag === "--policy") policyProfile = value;
			else model = value;
			continue;
		}
		if (arg.startsWith("--")) {
			throw new Error(`Unsupported replay argument: ${arg}`);
		}
		if (runId !== undefined) {
			throw new Error(`Unexpected replay argument: ${arg}`);
		}
		runId = arg;
	}

	if (!seen.has("--raw")) {
		throw new Error(
			"replay re-executes a legacy ambient-worker packet. Pass --raw to acknowledge unsafe execution; use buildplane ledger replay for read-only tape reconstruction.",
		);
	}
	if (runId === undefined) {
		throw new Error("Missing required run id for replay.");
	}
	return {
		runId,
		json: seen.has("--json"),
		...(policyProfile === undefined ? {} : { policyProfile }),
		...(model === undefined ? {} : { model }),
	};
}

function asPreviewRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EVENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_HOST_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PLANFORGE_HOST_REFERENCE_DIGEST_DOMAIN =
	"buildplane.planforge-host-reference.v1\0";
const PLANFORGE_REPOSITORY_IDENTITY_DIGEST_DOMAIN =
	"buildplane.planforge-repository-identity.v1\0";

const HOST_CANDIDATE_RECEIPT_V1_FIELDS = [
	"schemaVersion",
	"recoveryRef",
	"targetRef",
	"candidate",
	"candidateCreatedEventRef",
	"candidateCompletionEventRef",
	"candidateCompletionDigest",
	"tapeRootDigest",
	"nativeReceiptRef",
	"nativeReceiptDigest",
] as const;

const HOST_CANDIDATE_RECEIPT_V2_FIELDS = [
	...HOST_CANDIDATE_RECEIPT_V1_FIELDS,
	"governedPacketDigest",
] as const;

const HOST_CANDIDATE_RESULT_FIELDS = [
	"kind",
	"recoveryRef",
	"candidateReceipt",
] as const;

const HOST_CANDIDATE_SESSION_FIELDS = ["kind", "recoveryRef", "run"] as const;

const HOST_PLANFORGE_ADMISSION_FIELDS = [
	"kind",
	"admissionRef",
	"taskRefs",
	"planSourceDigest",
	"admissionDigest",
] as const;

const HOST_PLANFORGE_CANDIDATE_BINDING_FIELDS = [
	"schemaVersion",
	"admissionRefDigest",
	"taskRefDigest",
	"repositoryIdentityDigest",
] as const;

const HOST_PLANFORGE_CANDIDATE_RECEIPT_FIELDS = [
	...HOST_CANDIDATE_RECEIPT_V2_FIELDS,
	"planForgeBinding",
] as const;

const HOST_PLANFORGE_CANDIDATE_RESULT_FIELDS = [
	"kind",
	"schemaVersion",
	"recoveryRef",
	"candidateReceipt",
] as const;

const HOST_PLANFORGE_CANDIDATE_SESSION_FIELDS = [
	"kind",
	"schemaVersion",
	"recoveryRef",
	"run",
] as const;

interface GovernedRootSnapshot {
	readonly canonicalProjectRoot: string;
	readonly targetRef: string;
	readonly head: string;
	readonly tree: string;
	readonly commitCount: string;
	readonly status: string;
}

interface ParsedHostCandidateSession {
	readonly recoveryRef: string;
	readonly run: () => Promise<unknown>;
}

interface ParsedHostCandidateReceipt {
	readonly recoveryRef: string;
	readonly targetRef: string;
	readonly candidate: CandidateCreatedV2;
	readonly candidateCreatedEventRef: string;
	readonly candidateCompletionEventRef: string;
	readonly candidateCompletionDigest: string;
	readonly tapeRootDigest: string;
	readonly nativeReceiptRef: string;
	readonly nativeReceiptDigest: string;
	/** Present on V2 fresh-run receipts and bound to the original packet bytes. */
	readonly governedPacketDigest?: string;
}

interface ParsedHostPlanForgeCandidateBinding {
	readonly admissionRefDigest: string;
	readonly taskRefDigest: string;
	readonly repositoryIdentityDigest: string;
}

interface ParsedHostPlanForgeCandidateReceipt
	extends ParsedHostCandidateReceipt {
	readonly planForgeBinding: ParsedHostPlanForgeCandidateBinding;
}

interface ParsedHostCandidateResult {
	readonly recoveryRef: string;
	readonly candidateReceipt: ParsedHostCandidateReceipt;
}

interface ParsedHostPlanForgeCandidateSession {
	readonly recoveryRef: string;
	readonly run: () => Promise<unknown>;
}

interface ParsedHostPlanForgeCandidateResult {
	readonly recoveryRef: string;
	readonly candidateReceipt: ParsedHostPlanForgeCandidateReceipt;
}

interface ParsedHostPlanForgeAdmission {
	readonly admissionRef: string;
	readonly taskRefs: readonly string[];
	readonly planSourceDigest: string;
	readonly admissionDigest: string;
}

/**
 * Host replies cross a privilege boundary. Keep the CLI-side check closed and
 * descriptor-based so a malformed object cannot use inherited/accessor fields
 * to masquerade as a verified completion receipt. This validates shape only;
 * detached receipt/tape signature verification remains host/native-owned.
 */
function readClosedHostDataRecord(
	value: unknown,
	label: string,
	fields: readonly string[],
	requiredFields: readonly string[] = fields,
): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	) {
		throw new TypeError(`${label} must be a plain data object.`);
	}

	const expected = new Set(fields);
	const propertyNames = Object.getOwnPropertyNames(value);
	const propertySymbols = Object.getOwnPropertySymbols(value);
	if (propertySymbols.length > 0) {
		throw new TypeError(`${label} contains unsupported symbol field(s).`);
	}
	const unexpected = propertyNames.filter((key) => !expected.has(key));
	if (unexpected.length > 0) {
		throw new TypeError(
			`${label} contains unsupported field(s): ${unexpected.join(", ")}.`,
		);
	}
	const missing = requiredFields.filter((key) => !Object.hasOwn(value, key));
	if (missing.length > 0) {
		throw new TypeError(
			`${label} is missing required field(s): ${missing.join(", ")}.`,
		);
	}

	const normalized: Record<string, unknown> = {};
	for (const key of propertyNames) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be a data property.`);
		}
		normalized[key] = descriptor.value;
	}
	return normalized;
}

function readHostOpaqueReference(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 256 ||
		!OPAQUE_HOST_REFERENCE.test(value) ||
		value.includes("..") ||
		value.includes("//") ||
		value.includes("@{")
	) {
		throw new TypeError(`${label} must be an opaque host-issued reference.`);
	}
	return value;
}

function parseHostPlanForgeAdmission(
	value: unknown,
): ParsedHostPlanForgeAdmission {
	const record = readClosedHostDataRecord(
		value,
		"host PlanForge admission",
		HOST_PLANFORGE_ADMISSION_FIELDS,
	);
	if (record.kind !== "host-owned-planforge-admission-v1") {
		throw new TypeError(
			"host-owned governed broker returned an invalid PlanForge admission.",
		);
	}
	if (!Array.isArray(record.taskRefs) || record.taskRefs.length > 1_000) {
		throw new TypeError(
			"host PlanForge admission.taskRefs must be a bounded array of opaque host-issued references.",
		);
	}
	const taskRefs = record.taskRefs.map((taskRef, index) =>
		readHostOpaqueReference(
			taskRef,
			`host PlanForge admission.taskRefs[${index}]`,
		),
	);
	if (new Set(taskRefs).size !== taskRefs.length) {
		throw new TypeError(
			"host PlanForge admission.taskRefs must not contain duplicate references.",
		);
	}
	return Object.freeze({
		admissionRef: readHostOpaqueReference(
			record.admissionRef,
			"host PlanForge admission.admissionRef",
		),
		taskRefs: Object.freeze(taskRefs),
		planSourceDigest: readHostDigest(
			record.planSourceDigest,
			"host PlanForge admission.planSourceDigest",
		),
		admissionDigest: readHostDigest(
			record.admissionDigest,
			"host PlanForge admission.admissionDigest",
		),
	});
}

function readHostDigest(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
		throw new TypeError(`${label} must be a sha256 digest.`);
	}
	return value;
}

function readHostEventId(value: unknown, label: string): string {
	if (typeof value !== "string" || !EVENT_ID.test(value)) {
		throw new TypeError(`${label} must be a UUID event identity.`);
	}
	return value;
}

function isCanonicalTargetBranchRef(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!value.startsWith("refs/heads/") ||
		value.trim() !== value ||
		value.includes("..") ||
		value.includes("//") ||
		value.includes("@{")
	) {
		return false;
	}
	const suffix = value.slice("refs/heads/".length);
	return (
		suffix.length > 0 &&
		suffix
			.split("/")
			.every(
				(segment) =>
					/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) &&
					!segment.endsWith(".") &&
					!segment.endsWith(".lock"),
			)
	);
}

function parseHostCandidateSession(value: unknown): ParsedHostCandidateSession {
	const record = readClosedHostDataRecord(
		value,
		"host candidate session",
		HOST_CANDIDATE_SESSION_FIELDS,
	);
	if (
		record.kind !== "host-owned-governed-candidate-session-v1" ||
		typeof record.run !== "function"
	) {
		throw new TypeError(
			"host-owned governed broker returned an invalid candidate-only session.",
		);
	}
	return Object.freeze({
		recoveryRef: readHostOpaqueReference(
			record.recoveryRef,
			"host candidate session recoveryRef",
		),
		run: record.run as () => Promise<unknown>,
	});
}

function parseHostCandidateReceiptRecord(
	record: Record<string, unknown>,
): ParsedHostCandidateReceipt {
	if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
		throw new TypeError("host candidate receipt.schemaVersion must be 1 or 2.");
	}
	if (
		record.schemaVersion === 1 &&
		Object.hasOwn(record, "governedPacketDigest")
	) {
		throw new TypeError(
			"host candidate receipt.schemaVersion 1 must not contain governedPacketDigest.",
		);
	}
	if (!isCanonicalTargetBranchRef(record.targetRef)) {
		throw new TypeError(
			"host candidate receipt.targetRef must be a canonical target branch ref.",
		);
	}
	const governedPacketDigest =
		record.schemaVersion === 2
			? readHostDigest(
					record.governedPacketDigest,
					"host candidate receipt.governedPacketDigest",
				)
			: undefined;
	return Object.freeze({
		recoveryRef: readHostOpaqueReference(
			record.recoveryRef,
			"host candidate receipt.recoveryRef",
		),
		targetRef: record.targetRef,
		candidate: parseCandidateCreatedV2(record.candidate),
		candidateCreatedEventRef: readHostEventId(
			record.candidateCreatedEventRef,
			"host candidate receipt.candidateCreatedEventRef",
		),
		candidateCompletionEventRef: readHostEventId(
			record.candidateCompletionEventRef,
			"host candidate receipt.candidateCompletionEventRef",
		),
		candidateCompletionDigest: readHostDigest(
			record.candidateCompletionDigest,
			"host candidate receipt.candidateCompletionDigest",
		),
		tapeRootDigest: readHostDigest(
			record.tapeRootDigest,
			"host candidate receipt.tapeRootDigest",
		),
		nativeReceiptRef: readHostOpaqueReference(
			record.nativeReceiptRef,
			"host candidate receipt.nativeReceiptRef",
		),
		nativeReceiptDigest: readHostDigest(
			record.nativeReceiptDigest,
			"host candidate receipt.nativeReceiptDigest",
		),
		...(governedPacketDigest === undefined ? {} : { governedPacketDigest }),
	});
}

function parseHostCandidateReceipt(value: unknown): ParsedHostCandidateReceipt {
	return parseHostCandidateReceiptRecord(
		readClosedHostDataRecord(
			value,
			"host candidate receipt",
			HOST_CANDIDATE_RECEIPT_V2_FIELDS,
			HOST_CANDIDATE_RECEIPT_V1_FIELDS,
		),
	);
}

function parseHostPlanForgeCandidateBinding(
	value: unknown,
): ParsedHostPlanForgeCandidateBinding {
	const record = readClosedHostDataRecord(
		value,
		"host PlanForge candidate binding",
		HOST_PLANFORGE_CANDIDATE_BINDING_FIELDS,
	);
	if (record.schemaVersion !== 1) {
		throw new TypeError(
			"host PlanForge candidate binding.schemaVersion must be 1.",
		);
	}
	return Object.freeze({
		admissionRefDigest: readHostDigest(
			record.admissionRefDigest,
			"host PlanForge candidate binding.admissionRefDigest",
		),
		taskRefDigest: readHostDigest(
			record.taskRefDigest,
			"host PlanForge candidate binding.taskRefDigest",
		),
		repositoryIdentityDigest: readHostDigest(
			record.repositoryIdentityDigest,
			"host PlanForge candidate binding.repositoryIdentityDigest",
		),
	});
}

function parseHostPlanForgeCandidateReceipt(
	value: unknown,
): ParsedHostPlanForgeCandidateReceipt {
	const record = readClosedHostDataRecord(
		value,
		"host PlanForge candidate receipt",
		HOST_PLANFORGE_CANDIDATE_RECEIPT_FIELDS,
		[...HOST_CANDIDATE_RECEIPT_V1_FIELDS, "planForgeBinding"],
	);
	return Object.freeze({
		...parseHostCandidateReceiptRecord(record),
		planForgeBinding: parseHostPlanForgeCandidateBinding(
			record.planForgeBinding,
		),
	});
}

function parseHostCandidateResult(value: unknown): ParsedHostCandidateResult {
	const record = readClosedHostDataRecord(
		value,
		"host candidate result",
		HOST_CANDIDATE_RESULT_FIELDS,
	);
	if (record.kind !== "host-owned-governed-candidate-run-result-v1") {
		throw new TypeError(
			"host-owned governed broker returned an invalid candidate-only result.",
		);
	}
	const recoveryRef = readHostOpaqueReference(
		record.recoveryRef,
		"host candidate result.recoveryRef",
	);
	const candidateReceipt = parseHostCandidateReceipt(record.candidateReceipt);
	if (candidateReceipt.recoveryRef !== recoveryRef) {
		throw new TypeError(
			"host candidate result and receipt must bind the same recovery identity.",
		);
	}
	return Object.freeze({ recoveryRef, candidateReceipt });
}

function parseHostPlanForgeCandidateSession(
	value: unknown,
): ParsedHostPlanForgeCandidateSession {
	const record = readClosedHostDataRecord(
		value,
		"host PlanForge candidate session",
		HOST_PLANFORGE_CANDIDATE_SESSION_FIELDS,
	);
	if (
		record.kind !== "host-owned-planforge-candidate-session-v1" ||
		record.schemaVersion !== 1 ||
		typeof record.run !== "function"
	) {
		throw new TypeError(
			"host-owned governed broker returned an invalid PlanForge candidate-only session.",
		);
	}
	return Object.freeze({
		recoveryRef: readHostOpaqueReference(
			record.recoveryRef,
			"host PlanForge candidate session recoveryRef",
		),
		run: record.run as () => Promise<unknown>,
	});
}

function parseHostPlanForgeCandidateResult(
	value: unknown,
): ParsedHostPlanForgeCandidateResult {
	const record = readClosedHostDataRecord(
		value,
		"host PlanForge candidate result",
		HOST_PLANFORGE_CANDIDATE_RESULT_FIELDS,
	);
	if (
		record.kind !== "host-owned-planforge-candidate-run-result-v1" ||
		record.schemaVersion !== 1
	) {
		throw new TypeError(
			"host-owned governed broker returned an invalid PlanForge candidate-only result.",
		);
	}
	const recoveryRef = readHostOpaqueReference(
		record.recoveryRef,
		"host PlanForge candidate result.recoveryRef",
	);
	const candidateReceipt = parseHostPlanForgeCandidateReceipt(
		record.candidateReceipt,
	);
	if (candidateReceipt.recoveryRef !== recoveryRef) {
		throw new TypeError(
			"host PlanForge candidate result and receipt must bind the same recovery identity.",
		);
	}
	return Object.freeze({ recoveryRef, candidateReceipt });
}

function captureGovernedRootSnapshot(
	projectRoot: string,
): GovernedRootSnapshot | null {
	let canonicalProjectRoot: string;
	try {
		canonicalProjectRoot = realpathSync(projectRoot).split(sep).join("/");
	} catch {
		return null;
	}
	const targetRef = tryGitInWorkspace(projectRoot, [
		"symbolic-ref",
		"--quiet",
		"HEAD",
	])?.trim();
	if (!isCanonicalTargetBranchRef(targetRef)) return null;
	const head = tryGitInWorkspace(projectRoot, ["rev-parse", "HEAD"])?.trim();
	const targetHead = tryGitInWorkspace(projectRoot, [
		"rev-parse",
		targetRef,
	])?.trim();
	const tree = tryGitInWorkspace(projectRoot, [
		"rev-parse",
		"HEAD^{tree}",
	])?.trim();
	const commitCount = tryGitInWorkspace(projectRoot, [
		"rev-list",
		"--count",
		"HEAD",
	])?.trim();
	const status = tryGitInWorkspace(projectRoot, [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]);
	if (
		!head ||
		!targetHead ||
		!tree ||
		!commitCount ||
		status === null ||
		!GIT_OBJECT_ID.test(head) ||
		!GIT_OBJECT_ID.test(targetHead) ||
		!GIT_OBJECT_ID.test(tree) ||
		!/^\d+$/.test(commitCount) ||
		head !== targetHead
	) {
		return null;
	}
	return Object.freeze({
		canonicalProjectRoot,
		targetRef,
		head,
		tree,
		commitCount,
		status,
	});
}

function rootSnapshotMatches(
	before: GovernedRootSnapshot,
	projectRoot: string,
): boolean {
	const after = captureGovernedRootSnapshot(projectRoot);
	return (
		after !== null &&
		after.canonicalProjectRoot === before.canonicalProjectRoot &&
		after.targetRef === before.targetRef &&
		after.head === before.head &&
		after.tree === before.tree &&
		after.commitCount === before.commitCount &&
		after.status === before.status
	);
}

function assertCandidateReceiptMatchesInvocation(
	receipt: ParsedHostCandidateReceipt,
	before: GovernedRootSnapshot,
	sourcePacket: unknown | undefined,
	expectedEnvelopeDigest?: string,
): void {
	if (
		receipt.targetRef !== before.targetRef ||
		receipt.candidate.baseCommitSha !== before.head
	) {
		throw new TypeError(
			"host candidate receipt is stale or not bound to the checked-out target base.",
		);
	}
	if (
		expectedEnvelopeDigest !== undefined &&
		receipt.candidate.envelopeDigest !== expectedEnvelopeDigest
	) {
		throw new TypeError(
			"host candidate receipt is not bound to the supplied preauthorized dispatch envelope.",
		);
	}
	if (sourcePacket === undefined) return;
	const source = asPreviewRecord(sourcePacket);
	const unit = asPreviewRecord(source?.unit);
	const sourceUnitId = previewString(unit, "id");
	const sourceProvenanceRef = previewString(source, "provenance_ref");
	if (
		sourceUnitId === null ||
		sourceProvenanceRef === null ||
		receipt.candidate.unitId !== sourceUnitId ||
		receipt.candidate.provenanceRef !== sourceProvenanceRef
	) {
		throw new TypeError(
			"host candidate receipt is not bound to the original governed packet identity.",
		);
	}
	let expectedGovernedPacketDigest: string;
	try {
		expectedGovernedPacketDigest =
			strictGovernedSourcePacketDigest(sourcePacket);
	} catch {
		throw new GovernedCandidatePacketBindingViolation();
	}
	if (receipt.governedPacketDigest !== expectedGovernedPacketDigest) {
		throw new GovernedCandidatePacketBindingViolation();
	}
}

/**
 * A raw JSON value is not necessarily a governed packet. Digest binding must
 * first cross the closed source-admission boundary so unknown fields and
 * legacy defaults cannot become part of an authority-bearing packet digest.
 */
function strictGovernedSourcePacketDigest(sourcePacket: unknown): string {
	const serialized = JSON.stringify(sourcePacket);
	if (typeof serialized !== "string") {
		throw new TypeError("governed source packet must be JSON-serializable.");
	}
	return canonicalGovernedUnitPacketV1Digest(
		parseGovernedUnitPacket(serialized),
	);
}

function governedSourcePacketAdmissionBlocker(
	sourcePacket: unknown,
): string | undefined {
	try {
		strictGovernedSourcePacketDigest(sourcePacket);
	} catch {
		return "Governed packet source must pass strict admission before authority resolution.";
	}
	return undefined;
}

function previewString(
	record: Record<string, unknown> | null,
	key: string,
): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

const NATIVE_DISPATCH_ENVELOPE_V2_BODY_FIELDS = [
	"workflow_id",
	"workflow_revision",
	"unit_id",
	"attempt",
	"execution_role",
	"commit_mode",
	"provenance_ref",
	"base_commit_sha",
	"capability_bundle_digest",
	"acceptance_contract_digest",
	"context_manifest_digest",
	"worker_manifest_digest",
	"sandbox_profile_digest",
	"budget",
	"trust_tier",
	"idempotency_key",
	"issued_at",
	"expires_at",
] as const;

const NATIVE_DISPATCH_ENVELOPE_V3_FIELDS = [
	"body",
	"action_evidence_version",
	"repository_binding_digest",
	"ledger_authority_realm_digest",
	"governed_packet_digest",
	"envelope_digest",
] as const;

function readClosedPreviewRecord(
	value: unknown,
	label: string,
	allowedFields: readonly string[],
	requiredFields: readonly string[] = allowedFields,
): Record<string, unknown> {
	const record = asPreviewRecord(value);
	if (!record) {
		throw new TypeError(`${label} must be an object`);
	}
	const allowed = new Set(allowedFields);
	const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
	if (unexpected.length > 0) {
		throw new TypeError(
			`${label} contains unsupported field(s): ${unexpected.join(", ")}`,
		);
	}
	const missing = requiredFields.filter((key) => !Object.hasOwn(record, key));
	if (missing.length > 0) {
		throw new TypeError(
			`${label} is missing required field(s): ${missing.join(", ")}`,
		);
	}
	return record;
}

/**
 * The Rust tape uses externally tagged, snake_case payloads. Translate that
 * presentation-only wire form into the kernel's closed camelCase V2 proposal
 * before parsing it. This does not verify the detached tape signature or
 * grant authority; governed execution remains blocked without the native
 * admission/replay bridge.
 */
function translateNativeDispatchEnvelopeV2Body(
	value: unknown,
	label: string,
): Record<string, unknown> {
	const body = readClosedPreviewRecord(
		value,
		label,
		NATIVE_DISPATCH_ENVELOPE_V2_BODY_FIELDS,
	);
	const budget = readClosedPreviewRecord(
		body.budget,
		`${label}.budget`,
		["max_tokens", "max_compute_time_ms"],
		[],
	);

	return {
		workflowId: body.workflow_id,
		workflowRevision: body.workflow_revision,
		unitId: body.unit_id,
		attempt: body.attempt,
		executionRole: body.execution_role,
		commitMode: body.commit_mode,
		provenanceRef: body.provenance_ref,
		baseCommitSha: body.base_commit_sha,
		capabilityBundleDigest: body.capability_bundle_digest,
		acceptanceContractDigest: body.acceptance_contract_digest,
		contextManifestDigest: body.context_manifest_digest,
		workerManifestDigest: body.worker_manifest_digest,
		sandboxProfileDigest: body.sandbox_profile_digest,
		budget: {
			...(Object.hasOwn(budget, "max_tokens")
				? { maxTokens: budget.max_tokens }
				: {}),
			...(Object.hasOwn(budget, "max_compute_time_ms")
				? { maxComputeTimeMs: budget.max_compute_time_ms }
				: {}),
		},
		trustTier: body.trust_tier,
		idempotencyKey: body.idempotency_key,
		issuedAt: body.issued_at,
		expiresAt: body.expires_at,
	};
}

function translateNativeDispatchEnvelopeV2Preview(
	raw: unknown,
): unknown | undefined {
	const outer = asPreviewRecord(raw);
	if (!outer) return undefined;

	let envelopeValue: unknown;
	if (Object.hasOwn(outer, "DispatchEnvelopeV2")) {
		envelopeValue = readClosedPreviewRecord(
			outer,
			"DispatchEnvelopeV2 payload",
			["DispatchEnvelopeV2"],
		).DispatchEnvelopeV2;
	} else if (
		Object.hasOwn(outer, "body") ||
		Object.hasOwn(outer, "envelope_digest")
	) {
		// Accept the inner native payload too, which is useful when inspecting a
		// ledger export that has already removed the external event tag.
		envelopeValue = outer;
	} else {
		return undefined;
	}

	const envelope = readClosedPreviewRecord(
		envelopeValue,
		"DispatchEnvelopeV2",
		["body", "envelope_digest"],
	);
	return {
		schemaVersion: 2,
		body: translateNativeDispatchEnvelopeV2Body(
			envelope.body,
			"DispatchEnvelopeV2.body",
		),
		envelopeDigest: envelope.envelope_digest,
	};
}

/**
 * V3 keeps the V2 authority body and additionally binds the sealed action
 * evidence protocol. This translation is preview-only: it recognizes the
 * exact native wire schema but never treats an on-disk JSON proposal as a
 * trusted signed tape record.
 */
function translateNativeDispatchEnvelopeV3Preview(
	raw: unknown,
): unknown | undefined {
	const outer = asPreviewRecord(raw);
	if (!outer) return undefined;

	let envelopeValue: unknown;
	if (Object.hasOwn(outer, "DispatchEnvelopeV3")) {
		envelopeValue = readClosedPreviewRecord(
			outer,
			"DispatchEnvelopeV3 payload",
			["DispatchEnvelopeV3"],
		).DispatchEnvelopeV3;
	} else if (
		Object.hasOwn(outer, "action_evidence_version") ||
		Object.hasOwn(outer, "envelope_digest")
	) {
		envelopeValue = outer;
	} else {
		return undefined;
	}

	const envelope = readClosedPreviewRecord(
		envelopeValue,
		"DispatchEnvelopeV3",
		NATIVE_DISPATCH_ENVELOPE_V3_FIELDS,
		[
			"body",
			"action_evidence_version",
			"repository_binding_digest",
			"ledger_authority_realm_digest",
			"envelope_digest",
		],
	);
	return {
		schemaVersion: 3,
		body: translateNativeDispatchEnvelopeV2Body(
			envelope.body,
			"DispatchEnvelopeV3.body",
		),
		actionEvidenceVersion: envelope.action_evidence_version,
		repositoryBindingDigest: envelope.repository_binding_digest,
		ledgerAuthorityRealmDigest: envelope.ledger_authority_realm_digest,
		...(Object.hasOwn(envelope, "governed_packet_digest")
			? { governedPacketDigest: envelope.governed_packet_digest }
			: {}),
		envelopeDigest: envelope.envelope_digest,
	};
}

async function loadDispatchEnvelopePreview(
	path: string,
): Promise<LoadedDispatchEnvelopePreview> {
	const kernel = (await cliImport("@buildplane/kernel")) as unknown as {
		parseDispatchEnvelopeV1: (
			input: unknown,
		) => Omit<DispatchEnvelopePreview, "schemaVersion" | "verification">;
		parseDispatchEnvelopeV2: (input: unknown) => {
			readonly schemaVersion: 2;
			readonly body: Omit<
				DispatchEnvelopePreview,
				"schemaVersion" | "verification" | "envelopeDigest"
			>;
			readonly envelopeDigest: string;
		};
		parseDispatchEnvelopeV3: (input: unknown) => {
			readonly schemaVersion: 3;
			readonly body: Omit<
				DispatchEnvelopePreview,
				| "schemaVersion"
				| "verification"
				| "envelopeDigest"
				| "actionEvidenceVersion"
			>;
			readonly actionEvidenceVersion: "sealed-v2" | "sealed_v3";
			readonly governedPacketDigest?: string;
			readonly envelopeDigest: string;
		};
	};
	const source = readFileSync(path, "utf8");
	const raw: unknown = JSON.parse(source);
	const loaded = (
		preview: DispatchEnvelopePreview,
	): LoadedDispatchEnvelopePreview => Object.freeze({ source, preview });
	if (asPreviewRecord(raw)?.schemaVersion === 3) {
		const parsed = kernel.parseDispatchEnvelopeV3(raw);
		return loaded({
			schemaVersion: 3,
			verification: "structural_only",
			...parsed.body,
			actionEvidenceVersion: parsed.actionEvidenceVersion,
			...(parsed.governedPacketDigest === undefined
				? {}
				: { governedPacketDigest: parsed.governedPacketDigest }),
			envelopeDigest: parsed.envelopeDigest,
		});
	}
	if (asPreviewRecord(raw)?.schemaVersion === 2) {
		const parsed = kernel.parseDispatchEnvelopeV2(raw);
		return loaded({
			schemaVersion: 2,
			verification: "structural_only",
			...parsed.body,
			envelopeDigest: parsed.envelopeDigest,
		});
	}
	const nativeV3Preview = translateNativeDispatchEnvelopeV3Preview(raw);
	if (nativeV3Preview !== undefined) {
		const parsed = kernel.parseDispatchEnvelopeV3(nativeV3Preview);
		return loaded({
			schemaVersion: 3,
			verification: "structural_only",
			...parsed.body,
			actionEvidenceVersion: parsed.actionEvidenceVersion,
			...(parsed.governedPacketDigest === undefined
				? {}
				: { governedPacketDigest: parsed.governedPacketDigest }),
			envelopeDigest: parsed.envelopeDigest,
		});
	}
	const nativeV2Preview = translateNativeDispatchEnvelopeV2Preview(raw);
	if (nativeV2Preview !== undefined) {
		const parsed = kernel.parseDispatchEnvelopeV2(nativeV2Preview);
		return loaded({
			schemaVersion: 2,
			verification: "structural_only",
			...parsed.body,
			envelopeDigest: parsed.envelopeDigest,
		});
	}
	return loaded({
		schemaVersion: 1,
		verification: "structural_only",
		...kernel.parseDispatchEnvelopeV1(raw),
	});
}

async function probeGovernedSandboxForPreview(): Promise<GovernedSandboxPreview> {
	const runtime = (await cliImport("@buildplane/runtime")) as unknown as {
		probeGovernedSandbox: () => GovernedSandboxPreview;
	};
	return runtime.probeGovernedSandbox();
}

function buildGovernedRunPreview(
	packet: unknown,
	options: {
		readonly approvalRequested: boolean;
		readonly envelope?: DispatchEnvelopePreview;
		readonly sandbox: GovernedSandboxPreview;
		/** Original JSON packet, used to distinguish omitted legacy fields from parser defaults. */
		readonly sourcePacket?: unknown;
	},
): GovernedRunPreview {
	const packetRecord = asPreviewRecord(packet);
	const sourcePacketRecord = asPreviewRecord(options.sourcePacket);
	const unitRecord = asPreviewRecord(packetRecord?.unit);
	const unitId = previewString(unitRecord, "id");
	const executionRole = previewString(packetRecord, "execution_role");
	const explicitExecutionRole = previewString(
		sourcePacketRecord,
		"execution_role",
	);
	const executionRoleExplicit = explicitExecutionRole !== null;
	const provenanceRef = previewString(packetRecord, "provenance_ref");
	const capabilityDigest = previewString(
		packetRecord,
		"capability_bundle_digest",
	);
	const capabilityBundlePresent =
		packetRecord?.capability_bundle !== undefined && capabilityDigest !== null;
	const acceptanceContractPresent =
		packetRecord?.acceptance_contract !== undefined;
	const trustScopePresent = packetRecord?.trust_scope !== undefined;
	const blockers: string[] = [];

	if (!unitId) blockers.push("Packet does not contain a valid unit id.");
	if (!executionRole || !executionRoleExplicit) {
		blockers.push("Packet does not contain a declared execution role.");
	}
	if (!provenanceRef) {
		blockers.push(
			"Packet is missing provenance_ref required for governed admission.",
		);
	}
	if (!capabilityBundlePresent) {
		blockers.push(
			"Packet is missing a capability_bundle and matching capability_bundle_digest.",
		);
	}
	if (!acceptanceContractPresent) {
		blockers.push(
			"Packet is missing acceptance_contract required for governed admission.",
		);
	}
	if (!trustScopePresent) {
		blockers.push(
			"Packet is missing trust_scope required for governed admission.",
		);
	}

	const envelope = options.envelope;
	if (!envelope) {
		blockers.push(
			options.approvalRequested
				? "Governed admission was requested, but no DispatchEnvelopeV1, V2, or V3 was supplied."
				: "No signed DispatchEnvelopeV1, V2, or V3 or explicit operator approval was supplied.",
		);
	} else {
		if (envelope.schemaVersion !== 3) {
			blockers.push(
				"Governed execution requires a sealed DispatchEnvelopeV3; V1 and V2 envelopes are preview-only compatibility artifacts.",
			);
		}
		if (envelope.schemaVersion === 3) {
			if (envelope.actionEvidenceVersion === "sealed-v2") {
				blockers.push(
					"DispatchEnvelopeV3 actionEvidenceVersion sealed-v2 is a preview-only compatibility artifact; newly governed execution requires sealed_v3.",
				);
			} else if (envelope.actionEvidenceVersion !== "sealed_v3") {
				blockers.push(
					"DispatchEnvelopeV3 must bind actionEvidenceVersion sealed_v3.",
				);
			}
		}
		if (envelope.trustTier !== "governed") {
			blockers.push("Dispatch envelope trustTier must be governed.");
		}
		if (envelope.commitMode !== "atomic") {
			blockers.push("Governed admission supports only atomic commitMode.");
		}
		if (unitId && envelope.unitId !== unitId) {
			blockers.push("Dispatch envelope unitId does not match the packet.");
		}
		if (executionRole && envelope.executionRole !== executionRole) {
			blockers.push(
				"Dispatch envelope executionRole does not match the packet.",
			);
		}
		if (provenanceRef && envelope.provenanceRef !== provenanceRef) {
			blockers.push(
				"Dispatch envelope provenanceRef does not match the packet.",
			);
		}
		if (Date.parse(envelope.expiresAt) <= Date.now()) {
			blockers.push("Dispatch envelope is expired.");
		}
	}
	if (options.sandbox.state !== "feasible") {
		const codes = options.sandbox.failures.map((failure) => failure.code);
		blockers.push(
			`Governed sandbox is unavailable (${codes.join(", ") || "unknown sandbox failure"}); no host fallback is permitted.`,
		);
	}

	// This is deliberately a permanent blocker until execution is delegated to
	// the signed tape + ActionGateway + OCI sandbox path. A syntactically valid
	// envelope is not proof of a verified signature or usable authority.
	blockers.push(
		"Governed execution is unavailable until signed-tape verification, ActionGateway authorization, and OCI sandbox initialization are configured.",
	);
	blockers.push(
		"Governed authority broker is unavailable; no approval was recorded and no execution authority was created.",
	);

	return {
		governance: "preview",
		status: "blocked",
		executionStarted: false,
		approval: {
			requested: options.approvalRequested,
			state: "not-recorded",
		},
		authorityBroker: {
			state: "unavailable",
			code: GOVERNED_AUTHORITY_BROKER_REQUIRED_CODE,
		},
		packet: {
			unitId,
			executionRole,
			executionRoleExplicit,
			provenancePresent: provenanceRef !== null,
			capabilityBundlePresent,
			acceptanceContractPresent,
			trustScopePresent,
		},
		...(envelope === undefined ? {} : { envelope }),
		sandbox: options.sandbox,
		blockers,
	};
}

function formatGovernedRunPreview(preview: GovernedRunPreview): string[] {
	const envelopeLines =
		preview.envelope === undefined
			? []
			: [
					`envelope-schema: DispatchEnvelopeV${preview.envelope.schemaVersion}`,
					`envelope-version: ${preview.envelope.schemaVersion}`,
					`envelope-digest: ${preview.envelope.envelopeDigest}`,
					`envelope-verification: ${preview.envelope.verification}`,
					...(preview.envelope.actionEvidenceVersion === undefined
						? []
						: [
								`envelope-action-evidence: ${preview.envelope.actionEvidenceVersion}`,
							]),
				];

	return [
		"Governed run preview: execution blocked",
		`unit: ${preview.packet.unitId ?? "(invalid)"}`,
		`role: ${preview.packet.executionRole ?? "(invalid)"}${
			preview.packet.executionRoleExplicit ? "" : " (legacy default; blocked)"
		}`,
		`provenance: ${preview.packet.provenancePresent ? "present" : "missing"}`,
		`capability: ${preview.packet.capabilityBundlePresent ? "present" : "missing"}`,
		`acceptance: ${preview.packet.acceptanceContractPresent ? "present" : "missing"}`,
		`trust-scope: ${preview.packet.trustScopePresent ? "present" : "missing"}`,
		`approval: ${preview.approval.requested ? "requested" : "not requested"} (${preview.approval.state})`,
		`authority-broker: ${preview.authorityBroker.state} (${preview.authorityBroker.code})`,
		...envelopeLines,
		`governed-sandbox: ${preview.sandbox.state} (${preview.sandbox.host.environment})`,
		"blockers:",
		...preview.blockers.map((blocker) => `  - ${blocker}`),
		"Use --raw only when you explicitly accept unsafe, legacy execution.",
	];
}

/**
 * The candidate-producing result deliberately carries no target-branch or
 * promotion authority. The privileged host keeps the candidate identity and
 * signed evidence opaque until the separate review and promotion stages.
 */
interface GovernedCandidateRunOutput {
	readonly governance: "governed";
	readonly status: "candidate-awaiting-review";
	readonly executionStarted: true;
	readonly promotion: {
		readonly state: "not-authorized";
	};
}

function buildGovernedCandidateRunOutput(): GovernedCandidateRunOutput {
	return Object.freeze({
		governance: "governed" as const,
		status: "candidate-awaiting-review" as const,
		executionStarted: true as const,
		promotion: Object.freeze({ state: "not-authorized" as const }),
	});
}

function formatGovernedCandidateRun(
	output: GovernedCandidateRunOutput,
): readonly string[] {
	return [
		"Governed candidate created: awaiting review",
		`execution-started: ${output.executionStarted}`,
		"promotion: not authorized (candidate review and a bound promotion decision are required)",
	];
}

function emitGovernedRunPreview(
	preview: GovernedRunPreview,
	json: boolean,
	stdout: (line: string) => void,
): number {
	if (json) {
		stdout(formatJson(preview));
	} else {
		for (const line of formatGovernedRunPreview(preview)) {
			stdout(line);
		}
	}
	return 2;
}

/**
 * A host call can fail after admission or after an external effect. The CLI
 * deliberately cannot collapse that into a failed preview or retry locally:
 * only the privileged host has the activity identity and tape state needed to
 * reconcile the outcome safely.
 */
interface GovernedHostRecoveryOutput {
	readonly governance: "governed";
	readonly status: "recovery-required";
	readonly executionStarted: "unknown";
	readonly promotion: {
		readonly state: "not-authorized";
	};
	readonly recovery: {
		readonly action: "contact-host";
		readonly retry: "blocked";
		/** Present only for a locally observable host-result integrity failure. */
		readonly reason?: "root-integrity-violation" | "packet-binding-violation";
	};
}

type GovernedHostRecoveryReason = NonNullable<
	GovernedHostRecoveryOutput["recovery"]["reason"]
>;

function buildGovernedHostRecoveryOutput(
	reason?: GovernedHostRecoveryReason,
): GovernedHostRecoveryOutput {
	return Object.freeze({
		governance: "governed" as const,
		status: "recovery-required" as const,
		executionStarted: "unknown" as const,
		promotion: Object.freeze({ state: "not-authorized" as const }),
		recovery: Object.freeze({
			action: "contact-host" as const,
			retry: "blocked" as const,
			...(reason === undefined ? {} : { reason }),
		}),
	});
}

function emitGovernedHostRecovery(
	json: boolean,
	stdout: (line: string) => void,
	reason?: GovernedHostRecoveryReason,
): number {
	const output = buildGovernedHostRecoveryOutput(reason);
	if (json) {
		stdout(formatJson(output));
	} else {
		stdout("Governed host outcome is unknown: recovery required");
		stdout("execution-started: unknown");
		stdout("promotion: not authorized");
		stdout(
			"retry: blocked; contact the privileged host to reconcile this session",
		);
		if (reason === "root-integrity-violation") {
			stdout(
				"root-integrity: changed target observed; do not retry until the privileged host reconciles it",
			);
		} else if (reason === "packet-binding-violation") {
			stdout(
				"packet-binding: host result does not match the exact governed packet; do not retry until the privileged host reconciles it",
			);
		}
	}
	return 2;
}

function assertGovernedProjectInitialized(projectRoot: string): void {
	const stateDirectory = join(projectRoot, ".buildplane");
	if (
		!existsSync(join(stateDirectory, "project.json")) ||
		!existsSync(join(stateDirectory, "state.db"))
	) {
		throw new Error(
			"Buildplane project is not initialized. Run `buildplane init` first.",
		);
	}
}

/**
 * The CLI can observe only whether its checked-out target remained unchanged.
 * The privileged host is responsible for verifying detached signatures,
 * reducer state, and the native completion receipt before it returns this
 * candidate-only result. Any malformed result, root mutation, or unavailable
 * observation is an unknown-effect recovery condition—not a retry signal.
 *
 * The post-outcome check is containment rather than authorization: the shipped
 * resolver remains unavailable until a native host can put the target root
 * behind a read-only OCI mount. It makes a mutation observable even if the
 * host throws or returns malformed data, but it cannot roll a target change
 * back safely from the CLI process.
 */
class GovernedRootIntegrityViolation extends Error {
	constructor() {
		super(
			"checked-out target changed during governed candidate execution; host reconciliation is required.",
		);
		this.name = "GovernedRootIntegrityViolation";
	}
}

class GovernedCandidatePacketBindingViolation extends Error {
	constructor() {
		super(
			"host candidate receipt is not bound to the exact original governed packet.",
		);
		this.name = "GovernedCandidatePacketBindingViolation";
	}
}

class GovernedPlanForgeAdmissionRootIntegrityViolation extends Error {
	constructor() {
		super(
			"checked-out target changed during governed PlanForge admission; host reconciliation is required.",
		);
		this.name = "GovernedPlanForgeAdmissionRootIntegrityViolation";
	}
}

class GovernedPlanForgeAdmissionSourceIntegrityViolation extends Error {
	constructor() {
		super(
			"PlanForge input source changed during governed admission; host reconciliation is required.",
		);
		this.name = "GovernedPlanForgeAdmissionSourceIntegrityViolation";
	}
}

class GovernedPlanForgeAdmissionSourceBindingViolation extends Error {
	constructor() {
		super(
			"host PlanForge admission is not bound to the exact input source bytes.",
		);
		this.name = "GovernedPlanForgeAdmissionSourceBindingViolation";
	}
}

function contentDigest(value: Uint8Array): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalPlanForgeHostReferenceDigest(reference: string): string {
	return `sha256:${createHash("sha256")
		.update(`${PLANFORGE_HOST_REFERENCE_DIGEST_DOMAIN}${reference}`)
		.digest("hex")}`;
}

function canonicalPlanForgeRepositoryIdentityDigest(
	root: GovernedRootSnapshot,
): string {
	return `sha256:${createHash("sha256")
		.update(
			`${PLANFORGE_REPOSITORY_IDENTITY_DIGEST_DOMAIN}${JSON.stringify({
				schema_version: 1,
				project_root: root.canonicalProjectRoot,
				target_ref: root.targetRef,
				base_commit_sha: root.head,
				base_tree: root.tree,
			})}`,
		)
		.digest("hex")}`;
}

/**
 * `openSession` and `admit` are legacy structural JavaScript callbacks. Their
 * input carries the checked-out project root, so invoking either would hand an
 * untrusted host a target checkout capable of mutation before any sealed
 * PromotionDecision V3 exists. There is deliberately no JavaScript escape
 * hatch here: a future implementation must replace this with a native,
 * capability-bound host contract that never exposes a writable target
 * checkout.
 */
function requireNativeGovernedHostContract(): void {
	throw new Error(
		"Governed host execution is unavailable: no native trusted host contract can keep the target checkout immutable before a sealed PromotionDecision V3.",
	);
}

async function executeHostCandidateSession(
	projectRoot: string,
	openSession: () => Promise<HostOwnedCandidateSessionV1>,
	sourcePacket?: unknown,
	expectedEnvelopeDigest?: string,
): Promise<void> {
	// This must precede both `openSession()` and `session.run()`. The callback
	// receives `projectRoot` only below, after a native contract exists.
	requireNativeGovernedHostContract();
	const before = captureGovernedRootSnapshot(projectRoot);
	if (!before) {
		throw new Error(
			"governed root integrity snapshot is unavailable; the host candidate session was not opened.",
		);
	}
	let sessionFailure: unknown;
	try {
		const session = parseHostCandidateSession(await openSession());
		const result = parseHostCandidateResult(await session.run());
		if (result.recoveryRef !== session.recoveryRef) {
			throw new TypeError(
				"host candidate session and completion result must bind the same recovery identity.",
			);
		}
		assertCandidateReceiptMatchesInvocation(
			result.candidateReceipt,
			before,
			sourcePacket,
			expectedEnvelopeDigest,
		);
	} catch (error) {
		sessionFailure = error;
	}
	if (!rootSnapshotMatches(before, projectRoot)) {
		throw new GovernedRootIntegrityViolation();
	}
	if (sessionFailure !== undefined) {
		throw sessionFailure;
	}
}

function assertPlanForgeCandidateReceiptMatchesInvocation(
	receipt: ParsedHostPlanForgeCandidateReceipt,
	before: GovernedRootSnapshot,
	admissionRef: string,
	taskRef: string,
	repositoryIdentityDigest: string,
): void {
	assertCandidateReceiptMatchesInvocation(receipt, before, undefined);
	const expectedAdmissionRefDigest =
		canonicalPlanForgeHostReferenceDigest(admissionRef);
	const expectedTaskRefDigest = canonicalPlanForgeHostReferenceDigest(taskRef);
	if (
		receipt.planForgeBinding.admissionRefDigest !==
			expectedAdmissionRefDigest ||
		receipt.planForgeBinding.taskRefDigest !== expectedTaskRefDigest ||
		receipt.planForgeBinding.repositoryIdentityDigest !==
			repositoryIdentityDigest
	) {
		throw new TypeError(
			"host PlanForge candidate receipt is not bound to the requested admission, task, and repository identity.",
		);
	}
}

/**
 * This is intentionally separate from generic candidate execution. A
 * PlanForge task has no CLI-visible packet, so its signed completion must
 * prove the opaque admission/task pair and registered repository identity.
 */
async function executeHostPlanForgeCandidateSession(
	projectRoot: string,
	admissionRef: string,
	taskRef: string,
	openSession: () => Promise<HostOwnedPlanForgeCandidateSessionV1>,
): Promise<void> {
	// PlanForge uses the same legacy callback boundary and therefore cannot be
	// opened until the native capability-bound host contract is available.
	requireNativeGovernedHostContract();
	const before = captureGovernedRootSnapshot(projectRoot);
	if (!before) {
		throw new Error(
			"governed root integrity snapshot is unavailable; the host PlanForge candidate session was not opened.",
		);
	}
	const repositoryIdentityDigest =
		canonicalPlanForgeRepositoryIdentityDigest(before);
	let sessionFailure: unknown;
	try {
		const session = parseHostPlanForgeCandidateSession(await openSession());
		const result = parseHostPlanForgeCandidateResult(await session.run());
		if (result.recoveryRef !== session.recoveryRef) {
			throw new TypeError(
				"host PlanForge candidate session and completion result must bind the same recovery identity.",
			);
		}
		assertPlanForgeCandidateReceiptMatchesInvocation(
			result.candidateReceipt,
			before,
			admissionRef,
			taskRef,
			repositoryIdentityDigest,
		);
	} catch (error) {
		sessionFailure = error;
	}
	if (!rootSnapshotMatches(before, projectRoot)) {
		throw new GovernedRootIntegrityViolation();
	}
	if (sessionFailure !== undefined) {
		throw sessionFailure;
	}
}

/**
 * PlanForge admission is itself a privileged host activity. The CLI cannot
 * roll a root change back, but it can ensure a changed target always wins over
 * a host return or host error so no local caller observes a successful
 * admission after an unknown effect.
 */
async function executeHostPlanForgeAdmission(
	projectRoot: string,
	sourcePath: string,
	expectedSourceDigest: string,
	admit: () => Promise<unknown>,
): Promise<ParsedHostPlanForgeAdmission> {
	// PlanForge admission also receives `projectRoot` through a legacy callback.
	// Do not invoke it until a native capability-bound contract exists.
	requireNativeGovernedHostContract();
	const before = captureGovernedRootSnapshot(projectRoot);
	if (!before) {
		throw new Error(
			"governed root integrity snapshot is unavailable; the host PlanForge admission was not opened.",
		);
	}

	let admission: ParsedHostPlanForgeAdmission | undefined;
	let admissionFailure: unknown;
	try {
		admission = parseHostPlanForgeAdmission(await admit());
	} catch (error) {
		admissionFailure = error;
	}
	if (!rootSnapshotMatches(before, projectRoot)) {
		throw new GovernedPlanForgeAdmissionRootIntegrityViolation();
	}
	let sourceMatches = false;
	try {
		sourceMatches =
			contentDigest(new Uint8Array(readFileSync(sourcePath))) ===
			expectedSourceDigest;
	} catch {
		// A removed or unreadable input is just as unsafe as a changed input.
	}
	if (!sourceMatches) {
		throw new GovernedPlanForgeAdmissionSourceIntegrityViolation();
	}
	if (admissionFailure !== undefined) {
		throw admissionFailure;
	}
	if (admission === undefined) {
		throw new Error(
			"host PlanForge admission completed without an admission result.",
		);
	}
	if (admission.planSourceDigest !== expectedSourceDigest) {
		throw new GovernedPlanForgeAdmissionSourceBindingViolation();
	}
	return admission;
}

function governedHostRecoveryReason(
	error: unknown,
): GovernedHostRecoveryReason | undefined {
	return error instanceof GovernedRootIntegrityViolation
		? "root-integrity-violation"
		: error instanceof GovernedCandidatePacketBindingViolation
			? "packet-binding-violation"
			: undefined;
}

/**
 * A caller-provided envelope is never authority in this process. Before its
 * exact bytes cross to the privileged host, reject cheap deterministic
 * mismatches so an unrelated or stale proposal cannot even open a broker
 * session. Detached-signature, signed-tape, realm, and final policy checks
 * remain mandatory host-owned work.
 */
async function preauthorizedEnvelopeBlocker(
	projectRoot: string,
	sourcePacket: unknown,
	envelope: DispatchEnvelopePreview | undefined,
): Promise<string | undefined> {
	if (!envelope) {
		return "Preauthorized governed admission requires --envelope <path>.";
	}
	if (
		envelope.schemaVersion !== 3 ||
		envelope.actionEvidenceVersion !== "sealed_v3"
	) {
		return "Preauthorized governed admission requires a sealed DispatchEnvelopeV3 with actionEvidenceVersion sealed_v3.";
	}
	if (envelope.trustTier !== "governed" || envelope.commitMode !== "atomic") {
		return "Preauthorized governed admission requires a governed, atomic dispatch envelope.";
	}
	if (envelope.executionRole !== "implementer") {
		return "Preauthorized governed admission requires an implementer dispatch envelope; reviewer, adversary, and judge roles are read-only.";
	}
	let expectedGovernedPacketDigest: string;
	try {
		expectedGovernedPacketDigest =
			strictGovernedSourcePacketDigest(sourcePacket);
	} catch {
		return "Preauthorized dispatch envelope packet binding could not be verified.";
	}
	const expiresAt = Date.parse(envelope.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
		return "Preauthorized dispatch envelope is expired or has an invalid expiry.";
	}
	const source = asPreviewRecord(sourcePacket);
	const unit = asPreviewRecord(source?.unit);
	const unitId = previewString(unit, "id");
	const executionRole = previewString(source, "execution_role");
	const provenanceRef = previewString(source, "provenance_ref");
	const capabilityDigest = previewString(source, "capability_bundle_digest");
	if (
		unitId === null ||
		executionRole === null ||
		provenanceRef === null ||
		capabilityDigest === null ||
		source?.capability_bundle === undefined ||
		source.acceptance_contract === undefined ||
		source.trust_scope === undefined
	) {
		return "Preauthorized governed admission requires an explicit governed packet identity and contracts.";
	}
	if (
		envelope.unitId !== unitId ||
		envelope.executionRole !== executionRole ||
		envelope.provenanceRef !== provenanceRef
	) {
		return "Preauthorized dispatch envelope does not match the original packet identity.";
	}
	const root = captureGovernedRootSnapshot(projectRoot);
	if (!root || envelope.baseCommitSha !== root.head) {
		return "Preauthorized dispatch envelope is stale or not bound to the checked-out target base.";
	}
	if (envelope.governedPacketDigest === undefined) {
		return "Preauthorized sealed DispatchEnvelopeV3 is missing governedPacketDigest.";
	}
	if (envelope.governedPacketDigest !== expectedGovernedPacketDigest) {
		return "Preauthorized dispatch envelope does not bind the original packet digest.";
	}
	return undefined;
}

function withGovernedPreviewBlocker(
	preview: GovernedRunPreview,
	blocker: string,
): GovernedRunPreview {
	return Object.freeze({
		...preview,
		blockers: Object.freeze([...preview.blockers, blocker]),
	});
}

/**
 * Handle the governed front door before the generic legacy orchestrator is
 * constructed. The host sees the original packet bytes and is solely
 * responsible for strict parsing, CAS publication, signed admission, replay
 * resolution, and OCI initialization. This CLI never creates a signer,
 * resolver, raw worker, or promotion capability as a fallback.
 */
async function runGovernedRunCommand(
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly stdout: (line: string) => void;
		readonly dependencies?: RunCliDependencies;
	},
): Promise<number> {
	if (args.includes("--help")) {
		for (const line of formatRunHelp()) {
			options.stdout(line);
		}
		return 0;
	}

	const runArguments = parseRunCommandArguments(args);
	if (runArguments.raw) {
		throw new Error(
			"The governed run front door cannot execute --raw packets.",
		);
	}

	assertGovernedProjectInitialized(options.cwd);
	const projectRoot = resolve(options.cwd);
	if (runArguments.kind === "recovery-resume") {
		const broker = await resolveHostOwnedGovernedBroker();
		if (!broker) {
			return emitGovernedHostRecovery(runArguments.json, options.stdout);
		}
		try {
			await executeHostCandidateSession(projectRoot, () =>
				broker.openRecoverySession({
					projectRoot,
					recoveryReference: runArguments.recoveryReference,
					approval: "operator-requested",
				}),
			);
		} catch (error) {
			return emitGovernedHostRecovery(
				runArguments.json,
				options.stdout,
				governedHostRecoveryReason(error),
			);
		}

		const output = buildGovernedCandidateRunOutput();
		if (runArguments.json) {
			options.stdout(formatJson(output));
		} else {
			for (const line of formatGovernedCandidateRun(output)) {
				options.stdout(line);
			}
		}
		return 0;
	}

	const packetPath = resolve(options.cwd, runArguments.packetPath);
	const packetSource = readFileSync(packetPath, "utf8");
	const sourcePacket = JSON.parse(packetSource);
	const packet = options.dependencies?.parsePacket
		? options.dependencies.parsePacket(packetPath)
		: await loadPacket(packetPath);
	const loadedEnvelope = runArguments.envelopePath
		? await loadDispatchEnvelopePreview(
				resolve(options.cwd, runArguments.envelopePath),
			)
		: undefined;
	const envelope = loadedEnvelope?.preview;
	const sandbox = await probeGovernedSandboxForPreview();
	const preview = buildGovernedRunPreview(packet, {
		approvalRequested: runArguments.approve,
		sandbox,
		sourcePacket,
		...(envelope === undefined ? {} : { envelope }),
	});
	const sourceAdmissionBlocker =
		governedSourcePacketAdmissionBlocker(sourcePacket);
	if (sourceAdmissionBlocker !== undefined) {
		return emitGovernedRunPreview(
			withGovernedPreviewBlocker(preview, sourceAdmissionBlocker),
			runArguments.json,
			options.stdout,
		);
	}

	if (loadedEnvelope !== undefined) {
		const blocker = await preauthorizedEnvelopeBlocker(
			projectRoot,
			sourcePacket,
			envelope,
		);
		if (blocker !== undefined) {
			return emitGovernedRunPreview(
				withGovernedPreviewBlocker(preview, blocker),
				runArguments.json,
				options.stdout,
			);
		}
	}

	// An operator request asks the host to establish fresh authority. Without
	// one, the exact structural V3 envelope bytes are the sole preauthorization
	// input; the host must still verify their detached signature and tape
	// binding before it may open an activity session.
	if (!runArguments.approve && loadedEnvelope === undefined) {
		return emitGovernedRunPreview(preview, runArguments.json, options.stdout);
	}

	const broker = await resolveHostOwnedGovernedBroker();
	if (!broker) {
		return emitGovernedRunPreview(preview, runArguments.json, options.stdout);
	}

	try {
		let approval: HostOwnedCandidateApprovalV1;
		if (runArguments.approve) {
			approval = "operator-requested";
		} else {
			const preauthorizedEnvelope = loadedEnvelope;
			if (preauthorizedEnvelope === undefined) {
				return emitGovernedRunPreview(
					preview,
					runArguments.json,
					options.stdout,
				);
			}
			approval = {
				preauthorizedEnvelopeSource: preauthorizedEnvelope.source,
			};
		}
		await executeHostCandidateSession(
			projectRoot,
			() =>
				broker.openCandidateSession({
					kind: "new-candidate",
					packetSource,
					projectRoot,
					approval,
				}),
			sourcePacket,
			runArguments.approve ? undefined : loadedEnvelope?.preview.envelopeDigest,
		);
	} catch (error) {
		return emitGovernedHostRecovery(
			runArguments.json,
			options.stdout,
			governedHostRecoveryReason(error),
		);
	}

	const output = buildGovernedCandidateRunOutput();
	if (runArguments.json) {
		options.stdout(formatJson(output));
	} else {
		for (const line of formatGovernedCandidateRun(output)) {
			options.stdout(line);
		}
	}
	return 0;
}

function withUnsafeRunGovernance(
	result: Record<string, unknown>,
): Record<string, unknown> {
	const { receipt: _legacyReceipt, ...unsafeResult } = result;
	return {
		...unsafeResult,
		governance: "unsafe",
		trustedReceipt: false,
	};
}

function formatReplayHelp(): string[] {
	return [
		"buildplane replay <run-id> --raw [options]",
		"",
		"  Re-executes the stored packet snapshot from a prior run and records a new run.",
		"  This is an unsafe legacy execution lane: it is not a governed replay and",
		"  cannot produce a trusted receipt. Pass --raw to acknowledge that boundary.",
		"  Use this when you want to try the same unit again with a changed policy or",
		"  runtime setting. For read-only event-tape reconstruction, use:",
		"",
		"    buildplane ledger replay --run-id <run-id> --workspace <path>",
		"",
		"  Options:",
		"    --raw               Required acknowledgement for unsafe legacy execution",
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
		"buildplane planforge admit --input <file> --approve [--json]",
		"",
		"  Sends the original untrusted plan bytes to a privileged host authority",
		"  broker. The host owns operator identity, task binding, signed-tape and",
		"  repository verification, expiry, and all admission authority. The CLI",
		"  returns only opaque admission/task references and digests.",
		"",
		"  Options:",
		"    --input <file>   Untrusted PlanForge source to hand to the host unchanged",
		"    --approve        Required; requests host-authenticated admission",
		"    --json           Prints opaque references and host-returned digests as JSON",
		"",
		"buildplane planforge dispatch --admission-ref <opaque-host-ref> --task-ref <opaque-host-ref> [--json]",
		"",
		"  Opens one immutable candidate for a task already admitted by the",
		"  privileged host. The CLI forwards only opaque host-issued references;",
		"  it never compiles a PlanForge packet, runs an ambient model worker, or",
		"  exposes promotion authority.",
		"",
		"  Options:",
		"    --admission-ref <ref>  Opaque host-issued PlanForge admission reference",
		"    --task-ref <ref>       Opaque host-issued task reference from that admission",
		"    --json                 Machine-readable candidate status",
		"",
		"  Legacy `planforge dispatch --input ...` remains blocked because it launches",
		"  ambient model workers. There is deliberately no PlanForge --raw fallback.",
		"",
		"buildplane planforge resume --input <file> [--no-enforce-acceptance] [--json]",
		"",
		"  Currently blocked with dispatch. The legacy recovery path can resume an",
		"  ambient worker and write a signed plan_receipt without a candidate-bound",
		"  promotion transaction.",
		"",
		"  Options:",
		"    --input <file>           Markdown PlanForge goal fixture to resume",
		"    --no-enforce-acceptance  Skip the acceptance gate + recorded-prefix evidence",
		"                             check (default = enforce). Opt out only when the",
		"                             original dispatch also ran without acceptance.",
		"    --json                   Prints the resume result (recorded/executed) as JSON",
		"",
		"buildplane planforge recover [--no-enforce-acceptance] [--json]",
		"",
		"  Currently blocked with dispatch/resume until PlanForge recovery is driven",
		"  by the candidate/promotion reducer rather than legacy activity records.",
		"",
		"  Options:",
		"    --no-enforce-acceptance  Resume every orphan without the acceptance gate",
		"    --json                   Prints the recovery result (per-plan status) as JSON",
		"",
		"buildplane planforge plan --roadmap <file> --out <plan.md> --trusted-base <sha> [--remote <url>] [--json]",
		"",
		"  Selects the next eligible slice from the governed workflow projection and",
		"  deterministically emits its plan.md in the PlanForge ## Tasks grammar.",
		"  Legacy plan_receipt rows are ignored because they do not bind a candidate",
		"  promotion. Until PlanForge is migrated, this conservatively treats prior",
		"  legacy executions as unfinished.",
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
		"  Currently blocked. This CLI cannot mint a local signed envelope or append",
		"  authority-looking PlanForge tape records. A verifier-backed V3 authority",
		"  broker must establish admission before this command can be enabled.",
		"",
		"buildplane planforge loop [--once | --max-iterations=N] [--max-turns=N] [--max-tokens=N] [--wall-clock-ms=N] [--model <id>] [--reset] [--json]",
		"",
		"  The normal CLI loop is currently blocked before admission or dispatch: its",
		"  legacy worker step auto-merges before structured review. `--reset` remains",
		"  available because it only removes local loop state. Internally injected",
		"  dispatch implementations may still exercise the deterministic supervisor.",
		"",
		"  Options:",
		"    --once                  Run exactly one slice (equivalent to --max-iterations=1)",
		"    --max-iterations=N      Cap the number of slices the loop builds",
		"    --max-turns=N           Lowered worker --max-turns (runaway guard; default 12)",
		"    --max-tokens=N          Per-iteration token budget for the abort guard",
		"    --wall-clock-ms=N       Per-iteration wall-clock cap for the abort guard",
		"    --worker-timeout-ms=N   Hard per-dispatch worker timeout (default: --wall-clock-ms; min 60000)",
		"    --worker-allowed-tools  Comma-separated worker tool grant (default Edit,Write,Read,Glob,Grep,Bash)",
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
		"  Exports an unsafe local OpenTelemetry-shaped trace artifact from stored",
		"  run evidence. It is not a signed-tape projection or governed receipt,",
		"  and this command never sends telemetry to a vendor.",
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
			trustLane?: "legacy" | "unsafe" | "governed";
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
			trustLane?: "legacy" | "unsafe" | "governed";
		},
	): Promise<{
		run: { id: string; status: string };
		receipt: unknown;
		decision: unknown;
	}>;
	runGraphAsync(
		graph: unknown,
		eventBus?: unknown,
		options?: { lane?: "raw-legacy" },
	): Promise<{
		outcome: "passed" | "failed";
		nodes: Array<{ unitId: string; status: string; runId?: string }>;
	}>;
	runStrategy(
		strategy: unknown,
		eventBus?: unknown,
		options?: { lane?: "raw-legacy" | "governed-candidate" },
	): Promise<{
		strategyId: string;
		mode: string;
		outcome: "passed" | "failed" | "mixed" | "awaiting-promotion";
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
	/**
	 * Scope a command execution gateway to one asynchronous run. The router sees
	 * only the immutable gateway captured for that run; no shared executor slot
	 * is ever replaced while another run may be in flight.
	 */
	runWithCommandGateway: <T>(
		gateway: RouterCommandExecutor,
		operation: () => T,
	) => T;
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
	readonly executePacket: (packet: unknown, root: string) => unknown;
}

interface ScopedCommandExecutor {
	readonly commandExecutor: RouterCommandExecutor;
	runWithGateway<T>(gateway: RouterCommandExecutor, operation: () => T): T;
}

/**
 * Builds the command-executor seam used by the legacy raw lane.  It is
 * intentionally scoped with AsyncLocalStorage rather than mutating a router
 * dependency: a ledger/tool gateway belongs to exactly one run and is never
 * observable by a concurrent run. Governed runs do not use this legacy seam.
 */
export function createScopedCommandExecutor(
	defaultExecutor: RouterCommandExecutor,
): ScopedCommandExecutor {
	const context = new AsyncLocalStorage<RouterCommandExecutor>();
	const immutableDefault = Object.freeze({
		executePacket: defaultExecutor.executePacket,
	});
	const commandExecutor: RouterCommandExecutor = Object.freeze({
		executePacket(packet: unknown, root: string): unknown {
			return (context.getStore() ?? immutableDefault).executePacket(
				packet,
				root,
			);
		},
	});

	return Object.freeze({
		commandExecutor,
		runWithGateway<T>(gateway: RouterCommandExecutor, operation: () => T): T {
			const immutableGateway: RouterCommandExecutor = Object.freeze({
				executePacket: gateway.executePacket,
			});
			return context.run(immutableGateway, operation);
		},
	});
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
		readonly resultReadyPort?: ResultReadyPort;
		readonly runCompletionPort?: RunCompletionPort;
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
		/**
		 * Claude Code tool-permission grant threaded into the Claude executor
		 * (`--allowedTools <tool...>`, R7 FIX 1). Without it a headless dogfood
		 * worker's Edit/Write/Bash calls are all denied and it makes zero edits.
		 */
		readonly claudeAllowedTools?: readonly string[];
		/**
		 * Hard per-dispatch worker timeout in ms threaded into the Claude executor
		 * (R7 FIX 2). Defaults inside the executor to 300000ms — too short for a real
		 * multi-file derivation, so the loop threads its wall-clock budget here.
		 */
		readonly claudeTimeoutMs?: number;
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
			resultReadyPort?: ResultReadyPort;
			runCompletionPort?: RunCompletionPort;
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

	// The router keeps this stable forever. Individual legacy/raw runs receive a
	// scoped immutable command gateway through `runWithCommandGateway` below;
	// governed runs never inherit this ambient legacy route.
	const scopedCommandExecutor = createScopedCommandExecutor({
		executePacket: runtime.executePacket,
	});
	const commandExecutor = scopedCommandExecutor.commandExecutor;
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
					allowedTools?: readonly string[];
					timeoutMs?: number;
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
					allowedTools?: readonly string[];
					timeoutMs?: number;
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
			const claudeAllowedTools = opts?.claudeAllowedTools;
			const claudeTimeoutMs = opts?.claudeTimeoutMs;
			const executorOptions =
				claudeMaxTurns !== undefined ||
				onClaudeToolEvent !== undefined ||
				claudeAllowedTools !== undefined ||
				claudeTimeoutMs !== undefined
					? {
							...(claudeMaxTurns !== undefined
								? { maxTurns: claudeMaxTurns }
								: {}),
							...(onClaudeToolEvent !== undefined
								? { onToolEvent: onClaudeToolEvent }
								: {}),
							...(claudeAllowedTools !== undefined
								? { allowedTools: claudeAllowedTools }
								: {}),
							...(claudeTimeoutMs !== undefined
								? { timeoutMs: claudeTimeoutMs }
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
		// M6-S7 — signed `result_ready` (write-ahead at terminal `passed`) rides the
		// dispatch's shared signed emitter, injected by the dispatch caller; absent
		// for non-dispatch callers. `run_completed` fires from the operator-decision
		// path (a separate invocation), so it owns a subprocess like the decision port.
		resultReadyPort: opts?.resultReadyPort,
		runCompletionPort:
			opts?.runCompletionPort ?? createRunCompletionPort(projectRoot),
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
		runWithCommandGateway: scopedCommandExecutor.runWithGateway,
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
	if (receipt.verdict !== "PASSED" || receipt.trustedReceipt !== true) {
		return {
			ok: false,
			report: {
				...formatJsonError(
					"RECEIPT_NOT_ACCEPTED",
					receipt.trustedReceipt === false
						? `Receipt ${receiptId} does not contain a signed, verified governed tape; only trusted PASSED receipts can promote memory.`
						: receipt.verdict !== "PASSED"
							? `Receipt ${receiptId} has verdict ${receipt.verdict}; only trusted PASSED receipts can promote memory.`
							: `Receipt ${receiptId} is missing signed-tape verification; only trusted PASSED receipts can promote memory.`,
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
	raw: boolean;
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
	let raw = false;
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
			case "--raw":
				raw = true;
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
	return {
		ok: true,
		value: { runId, at, workspace, packet, vcr, vcrMiss, raw },
	};
}

function forkUsageText(): string {
	return `usage: buildplane fork <parent-run-id> --at <event-id> --packet <file> --raw [--workspace <path>] [--vcr] [--vcr-miss <fail|reexecute>]

  Fork resumes from a unit boundary in a prior run with a replacement packet.
  It is an unsafe legacy execution lane and cannot produce a trusted receipt.
  The workspace git state must be clean before fork execution.
  Target event must be a unit_started event.

  --run-id       parent run id (or positional first arg)
  --at           parent unit_started event id to fork at
  --packet       path to the new packet json
	  --raw          required acknowledgement for unsafe legacy execution
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
			// M6-S7 (A3): counts are strings on the wire (the U64 → TS-number hazard).
			outcome,
			duration_ms: String(durationMs),
			event_count: "0",
			unit_count: "1",
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
			runWithCommandGateway: runForkWithCommandGateway,
		} = bundle;

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

		// Build one immutable fork command gateway so tool calls are instrumented
		// through this fork's ledger without mutating a shared runtime router.
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
		const forkCommandGateway: RouterCommandExecutor = Object.freeze({
			executePacket: (
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
			},
		});

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
		const orchResult = await runForkWithCommandGateway(forkCommandGateway, () =>
			forkOrchestrator.runPacketAsync(forkPacket as never, forkEventBus, {
				runId: plan.new_run_id,
				parentRunId: plan.parent_run_id,
				trustLane: "unsafe",
			}),
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
	if (!args.value.raw) {
		opts.stderr(
			"buildplane fork: fork re-executes a legacy ambient-worker packet. Pass --raw to acknowledge unsafe execution; use buildplane ledger replay for read-only tape reconstruction.\n",
		);
		return 1;
	}
	opts.stdout("governance: unsafe\n");
	opts.stdout("trusted-receipt: false\n");

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

/**
 * A signed `acceptance_recorded` finalization verdict read back from the tape.
 * The M6-F1 fail-closed resume correlates recorded-prefix activities to these by
 * `(planId, admissionEventId, contractDigest, outcome)` — a recorded activity is
 * only counted `passed` toward a `completed` receipt when a matching `passed`
 * verdict exists, closing the fail-open where a crash before the acceptance gate
 * was minted as `completed` on resume.
 */
interface RecordedPlanAcceptance {
	eventId: string;
	planId: string;
	admissionEventId: string;
	contractDigest: string;
	outcome: string;
}

interface PlanForgeReplayState {
	completedActivities: RecordedPlanActivity[];
	acceptances: RecordedPlanAcceptance[];
	receipt?: RecordedPlanReceipt;
}

function assertKernelSignature(
	signature: KernelSignatureRow | undefined,
	eventId: string,
): void {
	void signature;
	throw new Error(
		`plan-not-admitted: plan_admitted event ${eventId} cannot be trusted without a reducer-verified detached signature.`,
	);
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
		return { completedActivities: [], acceptances: [] };
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				"SELECT id, kind, payload FROM events WHERE run_id = ? AND kind IN ('activity_completed', 'acceptance_recorded', 'plan_receipt') ORDER BY id ASC",
			)
			.all(runId) as unknown as PlanForgeEventRow[];
		const completedActivities: RecordedPlanActivity[] = [];
		const acceptances: RecordedPlanAcceptance[] = [];
		let receipt: RecordedPlanReceipt | undefined;
		for (const row of rows) {
			const payload = JSON.parse(row.payload) as {
				ActivityCompletedV1?: {
					activity_id?: string;
					run_id?: string;
					result_digest?: string;
					result?: unknown;
				};
				AcceptanceRecordedV1?: {
					plan_id?: string;
					admission_event_id?: string;
					contract_digest?: string;
					outcome?: string;
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
			if (row.kind === "acceptance_recorded") {
				const accepted = payload.AcceptanceRecordedV1;
				if (!accepted) {
					continue;
				}
				acceptances.push({
					eventId: row.id,
					planId: accepted.plan_id ?? "",
					admissionEventId: accepted.admission_event_id ?? "",
					contractDigest: accepted.contract_digest ?? "",
					outcome: accepted.outcome ?? "unknown",
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
		return { completedActivities, acceptances, receipt };
	} finally {
		db.close();
	}
}

const PLANFORGE_GOVERNED_BROKER_REQUIRED =
	"PlanForge governed broker is unavailable; no admission was recorded. Connect a privileged host authority broker and retry this broker-owned admission view.";

const PLANFORGE_GOVERNED_DISPATCH_BROKER_REQUIRED =
	"PlanForge governed broker is unavailable; no candidate was started. Connect a privileged host authority broker and retry this broker-owned dispatch view.";

interface PlanForgeBrokerAdmitArguments {
	readonly inputPath: string;
	readonly json: boolean;
}

/**
 * Keep this command's surface closed so legacy operator identities, envelopes,
 * packet fields, and worker controls cannot be smuggled into a host admission.
 * The authenticated host supplies the operator identity and validates all
 * authority state itself.
 */
function parsePlanForgeBrokerAdmitArguments(
	args: readonly string[],
): PlanForgeBrokerAdmitArguments {
	let inputPath: string | undefined;
	let approved = false;
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		switch (argument) {
			case "--input": {
				if (inputPath !== undefined) {
					throw new Error(
						"PlanForge governed admit accepts --input exactly once.",
					);
				}
				const value = args[index + 1];
				if (!value || value.startsWith("--")) {
					throw new Error(
						"Missing required --input <file> argument for PlanForge governed admit.",
					);
				}
				inputPath = value;
				index += 1;
				break;
			}
			case "--approve":
				if (approved) {
					throw new Error(
						"PlanForge governed admit accepts --approve exactly once.",
					);
				}
				approved = true;
				break;
			case "--json":
				if (json) {
					throw new Error(
						"PlanForge governed admit accepts --json at most once.",
					);
				}
				json = true;
				break;
			default:
				throw new Error(
					`Unsupported PlanForge governed admit argument: ${argument}. Use only --input <file>, --approve, and --json.`,
				);
		}
	}
	if (!approved) {
		throw new Error(
			"PlanForge governed admit requires explicit --approve for host-authenticated admission.",
		);
	}
	if (inputPath === undefined) {
		throw new Error(
			"Missing required --input <file> argument for PlanForge governed admit.",
		);
	}
	return Object.freeze({ inputPath, json });
}

/**
 * `buildplane planforge admit --input <file> --approve [--json]` is a thin
 * broker-owned view. It reads and forwards the original bytes only; it never
 * compiles a plan, derives an authority reference, opens a ledger, or mints a
 * local `plan_admitted` record.
 */
async function runPlanForgeAdmitCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	const parsed = parsePlanForgeBrokerAdmitArguments(args);
	const broker = await resolveHostOwnedGovernedBroker();
	if (!broker) {
		throw new Error(PLANFORGE_GOVERNED_BROKER_REQUIRED);
	}

	const projectRoot = resolve(cwd);
	const sourcePath = resolve(cwd, parsed.inputPath);
	// Copy the exact file bytes rather than decoding or compiling untrusted source
	// in the CLI. The host must reject unsupported encodings or malformed plans.
	const planSource = new Uint8Array(readFileSync(sourcePath));
	const admission = await executeHostPlanForgeAdmission(
		projectRoot,
		sourcePath,
		contentDigest(planSource),
		() =>
			broker.admitPlanForge({
				kind: "planforge-admission",
				planSource,
				projectRoot,
				approval: "operator-requested",
			}),
	);
	const output = Object.freeze({
		governance: "governed" as const,
		status: "admitted" as const,
		admission_ref: admission.admissionRef,
		task_refs: admission.taskRefs,
		plan_source_digest: admission.planSourceDigest,
		admission_digest: admission.admissionDigest,
	});
	if (parsed.json) {
		stdout(formatJson(output));
	} else {
		stdout("PlanForge admission accepted by the privileged host.");
		stdout(`admission-ref: ${output.admission_ref}`);
		for (const taskRef of output.task_refs) {
			stdout(`task-ref: ${taskRef}`);
		}
		stdout(`plan-source-digest: ${output.plan_source_digest}`);
		stdout(`admission-digest: ${output.admission_digest}`);
	}
	return 0;
}

interface PlanForgeBrokerDispatchArguments {
	readonly admissionRef: string;
	readonly taskRef: string;
	readonly json: boolean;
}

/**
 * This parser is deliberately separate from the legacy `--input` dispatch
 * parser. The CLI never turns PlanForge source into a packet: it can only ask
 * the privileged host to recover one task it already admitted.
 */
function parsePlanForgeBrokerDispatchArguments(
	args: readonly string[],
): PlanForgeBrokerDispatchArguments {
	let admissionRef: string | undefined;
	let taskRef: string | undefined;
	let json = false;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		switch (argument) {
			case "--admission-ref": {
				if (admissionRef !== undefined) {
					throw new Error(
						"PlanForge governed dispatch accepts --admission-ref exactly once.",
					);
				}
				const value = args[index + 1];
				if (!value || value.startsWith("--")) {
					throw new Error(
						"Missing required --admission-ref <opaque-host-ref> argument for PlanForge governed dispatch.",
					);
				}
				admissionRef = readHostOpaqueReference(
					value,
					"PlanForge governed dispatch admissionRef",
				);
				index += 1;
				break;
			}
			case "--task-ref": {
				if (taskRef !== undefined) {
					throw new Error(
						"PlanForge governed dispatch accepts --task-ref exactly once.",
					);
				}
				const value = args[index + 1];
				if (!value || value.startsWith("--")) {
					throw new Error(
						"Missing required --task-ref <opaque-host-ref> argument for PlanForge governed dispatch.",
					);
				}
				taskRef = readHostOpaqueReference(
					value,
					"PlanForge governed dispatch taskRef",
				);
				index += 1;
				break;
			}
			case "--json":
				if (json) {
					throw new Error(
						"PlanForge governed dispatch accepts --json at most once.",
					);
				}
				json = true;
				break;
			default:
				throw new Error(
					`Unsupported PlanForge governed dispatch argument: ${argument}. Use only --admission-ref <opaque-host-ref>, --task-ref <opaque-host-ref>, and --json.`,
				);
		}
	}
	if (admissionRef === undefined || taskRef === undefined) {
		throw new Error(
			"PlanForge governed dispatch requires both --admission-ref <opaque-host-ref> and --task-ref <opaque-host-ref>.",
		);
	}
	return Object.freeze({ admissionRef, taskRef, json });
}

async function runPlanForgeBrokerDispatchCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	const parsed = parsePlanForgeBrokerDispatchArguments(args);
	const broker = await resolveHostOwnedGovernedBroker();
	if (!broker) {
		throw new Error(PLANFORGE_GOVERNED_DISPATCH_BROKER_REQUIRED);
	}

	const projectRoot = resolve(cwd);
	try {
		await executeHostPlanForgeCandidateSession(
			projectRoot,
			parsed.admissionRef,
			parsed.taskRef,
			() =>
				broker.openPlanForgeCandidateSession({
					kind: "planforge-candidate-session-open-v1",
					schemaVersion: 1,
					projectRoot,
					admissionRef: parsed.admissionRef,
					taskRef: parsed.taskRef,
				}),
		);
	} catch (error) {
		return emitGovernedHostRecovery(
			parsed.json,
			stdout,
			governedHostRecoveryReason(error),
		);
	}

	const output = buildGovernedCandidateRunOutput();
	if (parsed.json) {
		stdout(formatJson(output));
	} else {
		for (const line of formatGovernedCandidateRun(output)) {
			stdout(line);
		}
	}
	return 0;
}

const DEFAULT_DISPATCH_POLICY_PROFILE = "default";

export interface ProvisionCommand {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * Lockfile-aware dependency-provisioning command for a worktree:
 * `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`; `package-lock.json` →
 * `npm ci`; a bare `package.json` (the M6 demo-repo shape) → `npm install`;
 * no `package.json` → `undefined` (nothing to provision — e.g. a non-Node
 * target repo).
 */
export function resolveProvisionCommand(
	workspacePath: string,
): ProvisionCommand | undefined {
	if (!existsSync(join(workspacePath, "package.json"))) {
		return undefined;
	}
	if (existsSync(join(workspacePath, "pnpm-lock.yaml"))) {
		return { command: "pnpm", args: ["install", "--frozen-lockfile"] };
	}
	if (existsSync(join(workspacePath, "package-lock.json"))) {
		return { command: "npm", args: ["ci"] };
	}
	// --no-package-lock: a generated lockfile would dirty the worktree and
	// retrip the run-admission worktree_clean gate.
	return {
		command: "npm",
		args: ["install", "--no-audit", "--no-fund", "--no-package-lock"],
	};
}

/**
 * Provisions dependencies inside an isolated git worktree so the acceptance
 * gate's `verificationCommands` (which invoke workspace tooling) have their
 * binaries and packages available. Synchronous to match the existing sync
 * git operations in `prepareRun`. Throws on a non-zero exit (or a spawn error)
 * with captured stderr so the orchestrator can surface a
 * `workspace-provision-failed` infrastructure failure and retain the worktree.
 */
export function provisionWorktreeDeps(workspacePath: string): void {
	if (!existsSync(workspacePath)) {
		throw new Error(
			`worktree dependency provisioning failed: worktree ${workspacePath} does not exist`,
		);
	}
	const resolved = resolveProvisionCommand(workspacePath);
	if (!resolved) {
		return;
	}
	const label = `${resolved.command} ${resolved.args.join(" ")}`;
	const result = spawnSync(resolved.command, [...resolved.args], {
		cwd: workspacePath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) {
		throw new Error(
			`${label} failed in worktree ${workspacePath}: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		const detail = (result.stderr ?? result.stdout ?? "").trim();
		throw new Error(
			`${label} failed in worktree ${workspacePath} (exit ${
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

interface DispatchAcceptanceProfile {
	readonly profileName: string;
	readonly contractDigest: string;
	readonly profile: PolicyProfile;
}

/**
 * M4 acceptance contract per-task profiles (D1): derive one fail-closed contract
 * per task (diff-scope = the task's capability bundle fsWrite; checks = its
 * verificationCommands), keyed by the packet unit id, plus a `profileRegistry` the
 * kernel resolves at the finalization gate. `plan.tasks[i]` maps 1:1 (in order) to
 * `packets[i]`. A pure extraction of the dispatch block — byte-equivalent — so
 * dispatch AND fail-closed resume wire the IDENTICAL acceptance gate.
 */
function deriveDispatchAcceptanceProfiles(
	plan: PlanForgePlan,
	packets: ReturnType<typeof dispatchAdmittedPlan>,
	enforceAcceptance: boolean,
): {
	acceptanceProfiles: Map<string, DispatchAcceptanceProfile>;
	profileRegistry: BuildplaneProfileRegistryPort;
} {
	const acceptanceProfiles = new Map<string, DispatchAcceptanceProfile>();
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
	return { acceptanceProfiles, profileRegistry };
}

interface PlanForgeResumeRunResult {
	task: string;
	run_id: string;
	status: string;
	source: "recorded" | "executed";
	activity_id?: string;
	completed_event_id?: string;
	/**
	 * Machine-readable per-task failure reason. `acceptance-not-evaluated` marks a
	 * recorded-prefix activity that carries NO matching signed `acceptance_recorded`
	 * verdict on the tape (M6-F1 fail-closed): the crash happened before the
	 * acceptance gate ran, so the work was never verified and must not be minted
	 * `completed` on resume.
	 */
	reason?: string;
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

export interface DispatchWorkerFlags {
	readonly model?: string;
	readonly claudeMaxTurns?: number;
	readonly claudeAllowedTools: readonly string[];
	readonly claudeTimeoutMs?: number;
}

const PLANFORGE_LEGACY_EXECUTION_BLOCKED =
	"PlanForge legacy execution is blocked: dispatch, resume, recover, and the default loop launch ambient workers that can auto-merge before an immutable candidate receives deterministic checks, structured review, and a candidate-bound promotion decision. Migrate this operation to the governed workflow path.";

/**
 * This is deliberately a hard stop rather than a `--raw` compatibility flag.
 * The legacy PlanForge lane writes signed activity and plan-receipt events, so
 * merely labelling its console output unsafe would still let an ambient merge
 * look governed to recovery and planner consumers.
 */
function blockPlanForgeLegacyExecution(): void {
	throw new Error(PLANFORGE_LEGACY_EXECUTION_BLOCKED);
}

/**
 * Worker flags for standalone `planforge dispatch` — `--model`, `--max-turns`,
 * `--worker-allowed-tools`, `--worker-timeout-ms` — the same worker contract
 * the loop threads (R7). Without the tool grant a dispatched worker is
 * default-denied and makes zero edits, so the grant defaults to the loop's
 * spike-proven set. Loop-provided opts take precedence over these flags, so
 * the supervisor path is unchanged.
 */
export function parseDispatchWorkerFlags(
	args: readonly string[],
): DispatchWorkerFlags {
	const allowedToolsFlag = readFlag(args, "--worker-allowed-tools");
	const claudeAllowedTools =
		allowedToolsFlag !== undefined
			? allowedToolsFlag
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t.length > 0)
			: PLANFORGE_LOOP_DEFAULT_ALLOWED_TOOLS;
	const timeoutFlag = parseIntFlag(args, "--worker-timeout-ms", null);
	return {
		model: readFlag(args, "--model"),
		claudeMaxTurns: parseIntFlag(args, "--max-turns", null) ?? undefined,
		claudeAllowedTools,
		claudeTimeoutMs:
			timeoutFlag !== null
				? Math.max(timeoutFlag, MIN_WORKER_TIMEOUT_MS)
				: undefined,
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
		/** Claude Code tool-permission grant threaded to the executor so the worker
		 * can Edit/Write/Read/Glob/Grep/Bash (R7 FIX 1). Omitted → default-deny. */
		readonly claudeAllowedTools?: readonly string[];
		/** Hard per-dispatch worker timeout in ms threaded to the executor (R7 FIX 2).
		 * Omitted → the executor's 300000ms default. */
		readonly claudeTimeoutMs?: number;
	},
): Promise<number> {
	if (args.includes("--admission-ref") || args.includes("--task-ref")) {
		return runPlanForgeBrokerDispatchCommand(args, cwd, stdout);
	}
	blockPlanForgeLegacyExecution();

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

	// Loop-provided opts win; CLI flags cover the standalone dispatch path.
	const workerFlags = parseDispatchWorkerFlags(args);
	const workerModel = opts?.model ?? workerFlags.model;
	const workerMaxTurns = opts?.claudeMaxTurns ?? workerFlags.claudeMaxTurns;
	const workerAllowedTools =
		opts?.claudeAllowedTools ?? workerFlags.claudeAllowedTools;
	const workerTimeoutMs = opts?.claudeTimeoutMs ?? workerFlags.claudeTimeoutMs;

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
		model: workerModel,
	});

	const packets = dispatchAdmittedPlan({
		plan,
		admittedEventId: String(admittedEventId),
		policyProfile: DEFAULT_DISPATCH_POLICY_PROFILE,
		model: workerModel,
	});

	// M4 acceptance contract: per-task fail-closed profiles the kernel resolves at
	// the finalization gate (D1 shared helper — identical wiring to resume).
	const { acceptanceProfiles, profileRegistry } =
		deriveDispatchAcceptanceProfiles(plan, packets, enforceAcceptance);

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
		// M6-F2: per-tool-call tape events on the dispatch path. The Claude worker's
		// tool_use/tool_result stream must land on THIS signed dispatch tape, stamped
		// with the in-flight packet's unit id + the `activity_started` event id as the
		// tool_request parent. The tracker observes the emitter feeding the activity
		// port to capture that auto-assigned id; the dispatch loop feeds it each
		// packet's unit id via `beginUnit` before `runPacketAsync`.
		const dispatchToolUnitTracker = createDispatchToolUnitTracker();
		const ledgerActivityPort = withCrashAfterActivityGuard(
			createLedgerActivityPort(dispatchToolUnitTracker.observe(emitter)),
			emitter,
		);
		// The tool sink writes onto the SAME serialized signed writer as the activity
		// and acceptance events (the raw `emitter`), so its ordering is preserved.
		const dispatchClaudeToolSink = createClaudeToolLedgerEmitter(
			emitter,
			dispatchToolUnitTracker.getUnitCtx,
			workspace,
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
						// M6-S7 — `result_ready` rides the same signed dispatch emitter
						// as acceptance/activity events (one serialized writer).
						resultReadyPort: createResultReadyPort(emitter),
						// M6-F2 — per-tool-call events from the Claude worker stream ride
						// the same signed dispatch tape as activity/acceptance events.
						onClaudeToolEvent: dispatchClaudeToolSink,
						provisionDeps: provisionWorktreeDeps,
						claudeMaxTurns: workerMaxTurns,
						budgets: opts?.budgets,
						claudeAllowedTools: workerAllowedTools,
						claudeTimeoutMs: workerTimeoutMs,
					}
				: {
						ledgerActivityPort,
						// M6-F2 — per-tool-call events also captured on the no-enforce path.
						onClaudeToolEvent: dispatchClaudeToolSink,
						claudeMaxTurns: workerMaxTurns,
						budgets: opts?.budgets,
						claudeAllowedTools: workerAllowedTools,
						claudeTimeoutMs: workerTimeoutMs,
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
			// M6-F2: scope the tool sink's unit ctx to the packet in flight BEFORE
			// dispatch, so its `activity_started` (emitted inside runPacketAsync) is
			// recorded against this unit id. Packets dispatch sequentially.
			dispatchToolUnitTracker.beginUnit(packet.unit.id);
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
					// The effective worker contract, so the operator sees what the
					// dispatched worker was actually granted (printed-output only —
					// deliberately NOT part of the signed receipt's result digest).
					worker: {
						model: workerModel ?? DISPATCH_WORKER_MODEL,
						allowed_tools: workerAllowedTools,
						timeout_ms: workerTimeoutMs ?? null,
					},
					runs,
				})
			: `Dispatched PlanForge plan ${plan.id}: ${runs.length}/${packets.length} task(s) [worker ${workerModel ?? DISPATCH_WORKER_MODEL}; tools ${workerAllowedTools.join(",")}].`,
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

/**
 * Default Claude Code tool-permission grant for a `planforge loop` dogfood
 * worker (R7 FIX 1). Live-spike-proven: a headless `claude -p` with exactly this
 * `--allowedTools` set writes files AND runs bash with zero permission denials;
 * without it every Edit/Write is denied (`haven't granted it yet`). Overridable
 * per-run via `--worker-allowed-tools`. NOT `--dangerously-skip-permissions`
 * (denied by the GAP-10 guard) — this names the exact tools instead.
 */
const PLANFORGE_LOOP_DEFAULT_ALLOWED_TOOLS: readonly string[] = [
	"Edit",
	"Write",
	"Read",
	"Glob",
	"Grep",
	"Bash",
];

/** Floor for the per-dispatch worker timeout (R7 FIX 2) so a mistakenly tiny
 * `--worker-timeout-ms` can't kill a worker before it starts. */
const MIN_WORKER_TIMEOUT_MS = 60_000;

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
	allowedTools?: readonly string[],
	timeoutMs?: number,
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
			// Tool-permission grant + hard timeout for the worker (R7 FIX 1/2).
			claudeAllowedTools: allowedTools,
			claudeTimeoutMs: timeoutMs,
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
	// The legacy loop can inject an arbitrary dispatcher through the exported
	// library dependencies. That was a production bypass around the CLI's normal
	// containment gate. Until the loop is an explicit reducer view over governed
	// candidates, block it regardless of dependency injection.
	blockPlanForgeLegacyExecution();

	const once = args.includes("--once");
	const maxIterations = once ? 1 : parseIntFlag(args, "--max-iterations", null);
	const maxTurns = parseIntFlag(args, "--max-turns", 12) ?? 12;
	const maxTokens = parseIntFlag(args, "--max-tokens", 200_000) ?? 200_000;
	const wallClockMs =
		parseIntFlag(args, "--wall-clock-ms", 30 * 60_000) ?? 30 * 60_000;
	// Optional worker-model override threaded to every dispatched packet; omitted
	// leaves the dispatch default (`DISPATCH_WORKER_MODEL`) untouched.
	const model = readFlag(args, "--model");
	// Worker tool-permission grant (R7 FIX 1). The default lets the dogfood worker
	// Edit/Write/Read/Glob/Grep/Bash — the spike-proven headless grant, without
	// which every Write is denied and the worker makes zero edits. Override with
	// `--worker-allowed-tools Edit,Write,...` (a value that resolves to no tool
	// names falls through to Claude's default-deny). Scope stays bounded post-hoc by
	// the M4 diff-scope + acceptance contract, NOT by withholding the grant.
	const allowedToolsFlag = readFlag(args, "--worker-allowed-tools");
	const workerAllowedTools =
		allowedToolsFlag !== undefined
			? allowedToolsFlag
					.split(",")
					.map((t) => t.trim())
					.filter((t) => t.length > 0)
			: PLANFORGE_LOOP_DEFAULT_ALLOWED_TOOLS;
	// Hard per-dispatch worker timeout (R7 FIX 2). A real multi-file derivation
	// needs >> the executor's 300000ms default, so default to the wall-clock budget;
	// `--worker-timeout-ms` overrides, min-capped so a tiny value can't insta-kill.
	const workerTimeoutMs = Math.max(
		parseIntFlag(args, "--worker-timeout-ms", null) ?? wallClockMs,
		MIN_WORKER_TIMEOUT_MS,
	);

	const planner = deps?.loopPlanner ?? defaultLoopPlanner;
	const envelope = deps?.loopEnvelope ?? defaultLoopEnvelope;
	const dryRun = deps?.loopDryRun ?? defaultLoopDryRun;
	const admit = deps?.loopAdmit ?? defaultLoopAdmit;
	const dispatch =
		deps?.loopDispatch ??
		makeDefaultLoopDispatch(
			maxTurns,
			runPlanForgeDispatchCommand,
			model,
			workerAllowedTools,
			workerTimeoutMs,
		);

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
			// Seed the pinned base from the workspace HEAD (R7 FIX 3) so a bare
			// `--reset` then re-fire has a trusted base — otherwise the planner reports
			// INSUFFICIENT_EVIDENCE and the loop dies before dispatch. Mirrors `bp goal`.
			trustedBase: seedTrustedBaseFromHead(() =>
				tryGitInWorkspace(workspace, ["rev-parse", "HEAD"]),
			),
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
 * D4 storage reconcile: flip the `running` rows this dispatch orphaned (the exact
 * set `findOrphanedPlanForgeDispatches` keys on — `unit_id` prefixed `${planId}:`)
 * to a terminal status consistent with the recovered receipt outcome, closing the
 * M2 "receipt on tape but running in storage → reconcile" line and making a second
 * `recover` pass report `no_orphans`. Best-effort and guarded on an initialized
 * `state.db` — the signed `plan_receipt` is already flushed, so a storage-only
 * failure must never shadow the terminal outcome.
 */
async function reconcilePlanForgeRunningRuns(
	workspace: string,
	planId: string,
	status: "passed" | "failed",
): Promise<void> {
	if (!existsSync(resolve(workspace, ".buildplane", "state.db"))) {
		return;
	}
	try {
		const { createBuildplaneStorage } = (await cliImport(
			"@buildplane/storage",
		)) as {
			createBuildplaneStorage: (root: string) => {
				reconcilePlanForgeDispatchRuns: (
					planId: string,
					status: "passed" | "failed",
				) => readonly string[];
			};
		};
		createBuildplaneStorage(workspace).reconcilePlanForgeDispatchRuns(
			planId,
			status,
		);
	} catch {
		// Best-effort: the terminal receipt is already durable on the tape (the
		// authoritative record); a storage-reconcile failure is non-fatal.
	}
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
	// D3: enforcement is ON by default; `--no-enforce-acceptance` opts out. The
	// decision comes ONLY from this CLI flag — never from the unsigned dispatch
	// manifest sidecar (an attacker who can write the sidecar must not be able to
	// downgrade the trust gate).
	return resumePlanForgePlanFromInput(inputPath, cwd, stdout, {
		json: args.includes("--json"),
		enforceAcceptance: !args.includes("--no-enforce-acceptance"),
	});
}

/**
 * Shared replay-skip-resume body, extracted from `runPlanForgeResumeCommand` so
 * both `planforge resume --input` and `planforge recover` (S7 crash recovery)
 * drive the identical fail-closed path (M6-F1): reconstruct the plan from
 * `inputPath`, re-verify the signed `plan_admitted`, replay durable activity
 * completions from the tape, and — when enforcing (default) — count a recorded
 * activity toward a `completed` receipt ONLY if the tape carries a matching signed
 * `acceptance_recorded` verdict (D2). The remaining suffix executes under the same
 * M4 acceptance gate as dispatch (D1); missing/rejected recorded-prefix evidence
 * fail-closes (`failed` receipt, exit 1, reason `acceptance-not-evaluated`). After
 * the terminal receipt the orphaned `running` storage rows are reconciled (D4).
 */
export async function resumePlanForgePlanFromInput(
	inputPath: string,
	cwd: string,
	stdout: (line: string) => void,
	opts: { json: boolean; enforceAcceptance?: boolean },
): Promise<number> {
	blockPlanForgeLegacyExecution();

	const jsonOut = opts.json;
	// D3: enforcement defaults ON. The suffix runs under the same M4 acceptance gate
	// as dispatch, AND every recorded-prefix activity must carry tape evidence that
	// acceptance actually passed (D2) before it counts toward a `completed` receipt.
	const enforceAcceptance = opts.enforceAcceptance ?? true;

	const plan = createPlanForgeDryRunPlan(resolve(cwd, inputPath));
	const workspace = resolve(cwd);
	const runId = planAdmitRunId(plan.idempotencyKey);
	// R-001: recover the worker-model override the original dispatch ran with from
	// the crash-recovery manifest, so the re-dispatched suffix keeps the same model
	// (recover has no flags — the manifest is the only place it survives a crash).
	// The manifest is consulted ONLY for the non-security worker-model hint, never
	// for the enforcement decision (D3) — it is an unsigned sidecar.
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

	// D1/D2: the per-task acceptance profiles (shared verbatim with dispatch) also
	// give us each task's re-derived `contractDigest`. Contracts re-derive
	// deterministically from the admitted plan, so this digest is byte-stable and
	// can correlate a recorded activity to its signed `acceptance_recorded` verdict.
	const { acceptanceProfiles, profileRegistry } =
		deriveDispatchAcceptanceProfiles(plan, packets, enforceAcceptance);
	// D2: how many signed `acceptance_recorded` verdicts on THIS run marked
	// `passed` for THIS plan/admission, counted PER contract digest. A
	// recorded-prefix activity only counts toward a `completed` receipt when it
	// can CONSUME one such verdict for its task's contract digest — a strict
	// consume-once multiset, not set membership. `acceptanceContractDigest`
	// intentionally excludes the task id, so two tasks with identical
	// allowed-side-effects + verification-commands share a digest D; N
	// recorded-passed tasks with digest D therefore require N distinct `passed`
	// verdicts for D. Counting (rather than `Set.has`) stops one verdict from
	// satisfying multiple tasks — the fail-open where a single acceptance minted
	// `completed` for sibling tasks whose acceptance never ran.
	const acceptedContractDigestCounts = new Map<string, number>();
	for (const a of replay.acceptances) {
		if (
			a.planId === plan.id &&
			a.admissionEventId === admittedEventId &&
			a.outcome === "passed"
		) {
			acceptedContractDigestCounts.set(
				a.contractDigest,
				(acceptedContractDigestCounts.get(a.contractDigest) ?? 0) + 1,
			);
		}
	}

	const runs: PlanForgeResumeRunResult[] = [];
	for (let i = 0; i < replay.completedActivities.length; i += 1) {
		const recorded = replay.completedActivities[i];
		const recordedStatus = recordedActivityStatus(recorded.result);
		// A recorded activity that itself did not pass is a genuine activity failure —
		// no acceptance question arises. Only a recorded *passed* activity must, when
		// enforcing, prove its acceptance verdict from the tape (D2). `acceptanceProfiles`
		// is empty when not enforcing, so `expectedDigest` is undefined and the
		// evidence gate is skipped (opt-out path).
		const expectedDigest = acceptanceProfiles.get(
			packets[i].unit.id,
		)?.contractDigest;
		let acceptanceMissing = false;
		if (enforceAcceptance && isPassedPlanForgeRun(recordedStatus)) {
			const available =
				expectedDigest !== undefined
					? (acceptedContractDigestCounts.get(expectedDigest) ?? 0)
					: 0;
			if (available > 0) {
				// Consume-once: this task's passed verdict is now spent and cannot
				// clear a sibling task that shares the same contract digest.
				acceptedContractDigestCounts.set(
					expectedDigest as string,
					available - 1,
				);
			} else {
				acceptanceMissing = true;
			}
		}
		runs.push({
			task: packets[i].unit.id,
			run_id: recorded.runId,
			// D2 fail-closed: a recorded-passed activity with no matching acceptance
			// verdict is NOT counted passed — it becomes a non-passed status carrying a
			// machine-readable reason so the terminal receipt fails.
			status: acceptanceMissing ? "acceptance-not-evaluated" : recordedStatus,
			source: "recorded",
			activity_id: recorded.activityId,
			completed_event_id: recorded.eventId,
			...(acceptanceMissing ? { reason: "acceptance-not-evaluated" } : {}),
		});
	}

	if (replay.receipt) {
		const terminalOk = replay.receipt.outcome === "completed";
		// D4: reconcile the orphaned `running` storage rows even on the
		// already-receipted short-circuit, so the storage status stops lying about a
		// run the tape already terminated.
		await reconcilePlanForgeRunningRuns(
			workspace,
			plan.id,
			terminalOk ? "passed" : "failed",
		);
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
			// Per-tool-call tape capture for the executed suffix (mirrors the M6-F2
			// dispatch wiring). The tracker observes the emitter feeding the activity
			// port to capture each suffix packet's auto-assigned `activity_started`
			// event id, and the sink stamps every worker tool_use/tool_result with the
			// in-flight packet's unit id + that parent id on THIS signed resume tape.
			// Recorded-prefix activities replay from the tape without a worker run, so
			// they get no re-emitted tool events — their tool evidence is already on the
			// tape from the original dispatch (the resultReadyPort scoping precedent).
			const resumeToolUnitTracker = createDispatchToolUnitTracker();
			// No `withCrashAfterActivityGuard` here (unlike dispatch): the crash
			// injection is a dispatch-only demo property, not part of the resume
			// contract — the omission is deliberate, not a missing mirror piece.
			const ledgerActivityPort = createLedgerActivityPort(
				resumeToolUnitTracker.observe(emitter),
			);
			const resumeClaudeToolSink = createClaudeToolLedgerEmitter(
				emitter,
				resumeToolUnitTracker.getUnitCtx,
				workspace,
			);
			// AC1/D1: the suffix executes under acceptance enforcement equivalent to
			// dispatch — per-task profileRegistry + a per-task-identity acceptancePort,
			// resultReadyPort (AC5), and provisioned worktree deps. When not enforcing,
			// wire only the activity port (the legacy opt-out behavior).
			// AC5/D5: only these executed-suffix packets emit `result_ready` /
			// `run_completed` (via the threaded ports, exactly as dispatch does).
			// Recorded-prefix activities are replayed from the tape without an
			// orchestrator run, and deliberately get NO synthetic `result_ready`:
			// fabricating one would assert a terminal outcome the kernel never
			// produced in this process — their evidence is the recorded
			// `activity_completed` + the consumed `acceptance_recorded` verdict.
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
							resultReadyPort: createResultReadyPort(emitter),
							onClaudeToolEvent: resumeClaudeToolSink,
							provisionDeps: provisionWorktreeDeps,
						}
					: { ledgerActivityPort, onClaudeToolEvent: resumeClaudeToolSink },
			);
			for (
				let i = replay.completedActivities.length;
				i < packets.length;
				i += 1
			) {
				const packet = packets[i];
				const acceptance = acceptanceProfiles.get(packet.unit.id);
				acceptanceIdentity.contractDigest = acceptance?.contractDigest ?? "";
				// Route the packet through its per-task acceptance profile so the kernel
				// resolves the contract at the finalization gate (mirrors dispatch).
				const dispatchedPacket = acceptance
					? {
							...packet,
							unit: { ...packet.unit, policyProfile: acceptance.profileName },
						}
					: packet;
				// Feed the tracker the in-flight suffix packet's unit id immediately
				// before the run, so the tool sink stamps its tool events with this
				// unit (matches the dispatch loop's beginUnit placement).
				resumeToolUnitTracker.beginUnit(packet.unit.id);
				const result = await orchestrator.runPacketAsync(
					parseUnitPacket(JSON.stringify(dispatchedPacket)),
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

	// D4: after the terminal receipt is durable, reconcile the orphaned `running`
	// storage rows to a terminal status consistent with the outcome, so a second
	// `recover` pass reports `no_orphans`.
	await reconcilePlanForgeRunningRuns(
		workspace,
		plan.id,
		allPassed ? "passed" : "failed",
	);

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
 * tape is authoritative over the storage status field; recover re-runs the suffix,
 * emits the receipt on the TAPE, and (D4) reconciles the orphaned `running` storage
 * row to a terminal status consistent with that receipt. Exit 0 iff every orphan
 * resumes to completion (or there are no orphans).
 */
async function runPlanForgeRecoverCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	blockPlanForgeLegacyExecution();

	const jsonOut = args.includes("--json");
	// D3: enforcement is ON by default; `--no-enforce-acceptance` opts every orphan
	// out. Never sourced from the unsigned dispatch manifest.
	const enforceAcceptance = !args.includes("--no-enforce-acceptance");
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
			{ json: true, enforceAcceptance },
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
			if (!rest.includes("--raw")) {
				throw new Error(
					"demo uses an ambient local command lane. Pass --raw to acknowledge unsafe execution; it cannot produce a trusted receipt.",
				);
			}
			const modelFlag = rest.includes("--model");
			const { runDemo } = await import("./demo.js");
			await runDemo({ model: modelFlag, raw: true });
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
				) => {
					verdict: string;
					runId: string;
					trustedReceipt: boolean;
				} & Record<string, unknown>;
			};
			const report = storage.verifyRunFinalVerdict(cwd, { runId });
			if (json) {
				stdout(formatJson(report));
			} else {
				stdout(`verify: ${report.verdict}`);
				stdout(`run-id: ${report.runId}`);
				stdout(`trusted-receipt: ${report.trustedReceipt === true}`);
			}
			return report.verdict === "PASSED" && report.trustedReceipt === true
				? 0
				: 1;
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
					governance: exportResult.governance,
					authority: exportResult.authority,
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
				) => {
					verdict: string;
					runId: string;
					trustedReceipt: boolean;
				} & Record<string, unknown>;
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
				) => {
					verdict: string;
					runId: string;
					trustedReceipt: boolean;
				} & Record<string, unknown>;
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

		// Parse every non-help run before the generic legacy orchestrator is
		// constructed. Besides routing governed work early, this ensures a malformed
		// `--resume ... --raw` request cannot instantiate the ambient worker router
		// before its cross-lane authority conflict is rejected.
		if (command === "run") {
			if (rest.includes("--help")) {
				if (!rest.includes("--raw")) {
					return await runGovernedRunCommand(rest, {
						cwd,
						stdout,
						...(deps === undefined ? {} : { dependencies: deps }),
					});
				}
			} else {
				const parsedRunArguments = parseRunCommandArguments(rest);
				if (!parsedRunArguments.raw) {
					return await runGovernedRunCommand(rest, {
						cwd,
						stdout,
						...(deps === undefined ? {} : { dependencies: deps }),
					});
				}
			}
		}

		// Deferred activity-bracket port (M2-S5): the run orchestrator is constructed
		// here, BEFORE the run-block signed ledger emitter is spawned (~200 lines down,
		// gated on `useLedger`). The port reads the emitter lazily at activity time, by
		// which point the run block has bound it (or left it null for a non-ledger run,
		// in which case bracketing is skipped — byte-unchanged).
		//
		// SCOPE NOTE: the default `run` path now returns a governed preview before an
		// emitter can be bound. The only execution path below is explicit `--raw`,
		// which is marked unsafe and does not make governed guarantees. A future
		// governed dispatcher must establish its signed tape before constructing a
		// worker/action authority, rather than reusing this deferred raw-run emitter.
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
					runWithCommandGateway: (_gateway, operation) => operation(),
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
			runWithCommandGateway,
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

				const runArguments = parseRunCommandArguments(rest);
				if (runArguments.kind !== "packet" || !runArguments.raw) {
					throw new Error(
						"governed run arguments must be routed before constructing the legacy execution bundle.",
					);
				}

				// Pre-flight: raw execution retains the legacy project-state check. The
				// governed lane was handled above before this ambient bundle existed.
				orchestrator.getStatus();

				const packetPath = resolve(cwd, runArguments.packetPath);
				const packet = deps?.parsePacket
					? deps.parsePacket(packetPath)
					: await loadPacket(packetPath);

				const useRaw = runArguments.raw;
				const useJson = runArguments.json;

				if (!useRaw) {
					return await runGovernedRunCommand(rest, {
						cwd,
						stdout,
						...(deps === undefined ? {} : { dependencies: deps }),
					});
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
				const useTui = runArguments.tui;
				const isModelPacket = !!(enrichedPacket as { model?: unknown }).model;
				const useAsync = useTui || isModelPacket;

				// --- raw-lane evidence boundary ---
				// `--raw` is deliberately incompatible with the governed signed tape and
				// result-ready ports. Keeping a per-run ledger here made unsafe execution
				// indistinguishable from governed work to downstream readers. Raw still
				// records local diagnostic evidence, but it cannot create a signed tape
				// authority or a trusted receipt.
				const useLedger = false;
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
				const ledgerRunOptions = {
					...(ledgerEmitter ? { runId: ledgerRunId } : {}),
					trustLane: "unsafe" as const,
				};

				// Capture the current ledgerEmitter reference so the closure below
				// captures the per-run emitter (not a shared mutable variable that
				// could change between runs).
				const runLedgerEmitter = ledgerEmitter;
				const runGetUnitCtx = getUnitCtx;

				// Build one immutable command gateway for this raw run. The router reads
				// it only through AsyncLocalStorage while `withRawCommandGateway` is
				// active, so concurrent runs cannot cross-wire emitters or tool policies.
				// The registry is still created per call from executionRoot so sandbox
				// path validation uses the worktree rather than the project root.
				const { existsSync: fsExistsSync, realpathSync: fsRealpathSync } =
					await import("node:fs");
				const { resolve: pathResolve } = await import("node:path");
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
				const rawCommandGateway: RouterCommandExecutor | undefined =
					runLedgerEmitter === null
						? undefined
						: Object.freeze({
								executePacket: (
									packetUnknown: unknown,
									root: string,
								): unknown =>
									makeReceipt(packetUnknown, root, runLedgerEmitter),
							});
				const withRawCommandGateway = <T>(operation: () => T): T =>
					rawCommandGateway
						? runWithCommandGateway(rawCommandGateway, operation)
						: operation();
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
						asyncOrchestratorResult = await withRawCommandGateway(() =>
							orchestrator.runPacketAsync(
								enrichedPacket,
								cliEventBus,
								ledgerRunOptions,
							),
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
						stdout(formatJson(withUnsafeRunGovernance(resultRecord)));
					} else {
						stdout("governance: unsafe");
						stdout("trusted-receipt: false");
						for (const line of formatRunResult(asyncResult)) {
							stdout(line);
						}
					}

					return asyncResult.run.status === "passed" ? 0 : 1;
				}

				if (useTui) {
					// Lazy-load TUI — only imported when --tui is requested
					stdout("governance: unsafe");
					stdout("trusted-receipt: false");
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
						tuiResult = await withRawCommandGateway(() =>
							orchestrator.runPacketAsync(
								enrichedPacket,
								tuiBus,
								ledgerRunOptions,
							),
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
							? await withRawCommandGateway(() =>
									orchestrator.runPacketAsync(
										enrichedPacket,
										cliEventBus,
										ledgerRunOptions,
									),
								)
							: withRawCommandGateway(() =>
									orchestrator.runPacket(
										enrichedPacket,
										cliEventBus,
										ledgerRunOptions,
									),
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
					stdout(formatJson(withUnsafeRunGovernance(resultRecord)));
				} else {
					stdout("governance: unsafe");
					stdout("trusted-receipt: false");
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
				const replayArguments = parseUnsafeReplayArguments(rest);
				const { runId, json } = replayArguments;

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
					replayArguments,
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
					{ trustLane: "unsafe" },
				);

				if (json) {
					stdout(
						formatJson({
							originalRunId: runId,
							governance: "unsafe",
							trustedReceipt: false,
							replay: {
								runId: result.run.id,
								status: result.run.status,
							},
						}),
					);
				} else {
					stdout(`replay of: ${runId}`);
					stdout("governance: unsafe");
					stdout("trusted-receipt: false");
					for (const line of formatRunResult(
						result as { run: { id: string; status: string } },
					)) {
						stdout(line);
					}
				}

				return result.run.status === "passed" ? 0 : 1;
			}
			case "run-graph": {
				const graphArguments = parseRawLegacyPathCommandArguments(rest, {
					command: "run-graph",
					pathFlag: "--graph",
					supportsJson: false,
				});
				const graphPath = resolve(cwd, graphArguments.path);
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
					{ lane: "raw-legacy" },
				);
				persistInjectedMemoriesForTargets(
					structuredMemoryPort,
					graphResult.nodes.map((node) => ({
						unitId: node.unitId,
						runId: node.runId,
					})),
					preparedGraph.injectedMemoriesByUnitId,
				);

				stdout("governance: unsafe");
				stdout("trusted-receipt: false");
				stdout(`Graph Outcome: ${graphResult.outcome}`);
				for (const node of graphResult.nodes) {
					stdout(` - ${node.unitId}: ${node.status}`);
				}
				return graphResult.outcome === "passed" ? 0 : 1;
			}
			case "run-strategy": {
				const strategyArguments = parseRawLegacyPathCommandArguments(rest, {
					command: "run-strategy",
					pathFlag: "--strategy",
					supportsJson: true,
				});
				const strategyPath = resolve(cwd, strategyArguments.path);

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
					{ lane: "raw-legacy" },
				);
				const strategyTargets = collectStrategyRunTargets(strategyResult);
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
				const unsafeStrategyOutput = {
					...strategyOutput,
					governance: "unsafe" as const,
					trustedReceipt: false,
				};

				const json = strategyArguments.json;
				if (json) {
					stdout(formatJson(unsafeStrategyOutput as Record<string, unknown>));
				} else {
					stdout("governance: unsafe");
					stdout("trusted-receipt: false");
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
	arguments_: UnsafeReplayArguments,
): unknown {
	const result = { ...packet };

	if (arguments_.model !== undefined) {
		const slashIndex = arguments_.model.indexOf("/");
		if (slashIndex > 0) {
			// provider/model-name
			const provider = arguments_.model.slice(0, slashIndex);
			const model = arguments_.model.slice(slashIndex + 1);
			const existing = (result.model as Record<string, unknown>) ?? {};
			result.model = { ...existing, provider, model };
			// If switching to model execution, remove command execution.
			delete result.execution;
		} else {
			// model-name (keep existing provider)
			const existing = (result.model as Record<string, unknown>) ?? {};
			result.model = { ...existing, model: arguments_.model };
			delete result.execution;
		}
	}
	if (arguments_.policyProfile !== undefined) {
		const unit = (result.unit as Record<string, unknown>) ?? {};
		result.unit = { ...unit, policyProfile: arguments_.policyProfile };
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
