import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type CreateRunAdmissionReceiptDryRunInput,
	createRunAdmissionReceiptLive,
	type JsonRecord,
	type RunAdmissionEvidenceInput,
	type RunAdmissionLocalEvidenceStore,
	type RunAdmissionReceiptAttemptRecord,
	recordRunAdmissionReceiptAttempt,
	recordRunAdmissionReceiptAttemptSync,
} from "./admission-receipts.js";
import {
	type AdmittedPlanReader,
	type AdmittedPlanRecord,
	createDefaultAdmittedPlanReader,
} from "./admitted-plan-reader.js";
import type { EventBus, EventContext } from "./events.js";
import {
	createGraphScheduler,
	type GraphResult,
	type UnitGraph,
} from "./graph.js";
import { extractLearnings } from "./outcome-extractor.js";
import type {
	AcceptanceCheckResult,
	AcceptanceContractV0,
	BudgetConstraints,
	PolicyProfile,
} from "./policy.js";
import type {
	AcceptanceRecordInput,
	BuildplaneAcceptanceEvidencePort,
	BuildplaneAcceptancePort,
	BuildplaneMemoryPort,
	BuildplanePolicyPort,
	BuildplaneProfileRegistryPort,
	BuildplaneRuntimePort,
	BuildplaneStoragePort,
	BuildplaneWorkspacePort,
	CreateRunOptions,
	LedgerActivityPort,
} from "./ports.js";
import {
	defaultOutcomeRoutingConfig,
	fillRoutingHints,
	type OutcomeRoutingConfig,
} from "./routing-producer.js";
import type {
	ExecutionReceipt,
	InspectSnapshot,
	PolicyDecision,
	RunInfrastructureFailure,
	RunPacketResult,
	StatusSnapshot,
	UnitPacket,
	WorkspaceSnapshot,
} from "./run-loop.js";
import { createRunScopedBus } from "./run-scoped-bus.js";
import { runStrategy } from "./strategy-executor.js";
import type { Run, StrategyPacket, StrategyResult } from "./types.js";
import { validatePacketForWorkspaceRoot } from "./workspace-paths.js";

/** A no-op event bus for the sync path when no bus is provided. */
const noopBus: EventBus = {
	subscribe: () => () => {},
	emit: () => {},
};

const DEFAULT_ADMISSION_STEM = "run_admission";
const MAX_ADMISSION_STEM_LENGTH = 120;

/**
 * Minimal deterministic descriptor of a packet's activity input, digested into
 * `ActivityStartedV1.input_digest`. Command packets describe the command line;
 * model packets describe the model block (or intent, when present).
 */
function activityInputDescriptor(p: UnitPacket): unknown {
	if (p.model) {
		return p.intent ? { intent: p.intent } : { model: p.model };
	}
	return {
		command: p.execution?.command ?? "",
		args: p.execution?.args ?? [],
	};
}

/**
 * Deterministic descriptor of an execution receipt, digested into
 * `ActivityCompletedV1.result_digest` and stored inline as the recorded result.
 */
function activityResultDescriptor(r: ExecutionReceipt): unknown {
	return {
		exitCode: r.exitCode,
		stdout: r.stdout,
		stderr: r.stderr,
	};
}

// Must equal @buildplane/planforge's PLANFORGE_AUTHORIZED_NEXT_STEP.
const PLAN_ADMITTED_AUTHORIZED_NEXT_STEP = "dispatch_admitted_plan";

export interface BuildplaneOrchestrator {
	initializeProject(): ReturnType<BuildplaneStoragePort["initializeProject"]>;
	runPacket(
		packet: UnitPacket,
		eventBus?: EventBus,
		createRunOptions?: CreateRunOptions,
	): RunPacketResult;
	runPacketAsync(
		packet: UnitPacket,
		eventBus?: EventBus,
		createRunOptions?: CreateRunOptions,
	): Promise<RunPacketResult>;
	getStatus(): StatusSnapshot;
	inspect(id: string): InspectSnapshot;
	approveRun(runId: string): Run;
	rejectSuspendedRun(runId: string): Run;
	runGraphAsync(graph: UnitGraph, eventBus?: EventBus): Promise<GraphResult>;
	runStrategy(
		strategy: StrategyPacket,
		eventBus?: EventBus,
	): Promise<StrategyResult>;
}

export interface CreateBuildplaneOrchestratorOptions {
	readonly projectRoot: string;
	readonly storage: BuildplaneStoragePort;
	readonly runtime: BuildplaneRuntimePort;
	readonly policy: BuildplanePolicyPort;
	readonly workspace: BuildplaneWorkspacePort;
	readonly admissionStore?: RunAdmissionLocalEvidenceStore | null;
	readonly admittedPlanReader?: AdmittedPlanReader;
	readonly eventBus?: EventBus;
	readonly profileRegistry?: BuildplaneProfileRegistryPort;
	readonly budgets?: BudgetConstraints;
	readonly memoryPort?: BuildplaneMemoryPort;
	readonly outcomeRouting?: OutcomeRoutingConfig;
	readonly ledgerActivityPort?: LedgerActivityPort;
	readonly acceptanceEvidencePort?: BuildplaneAcceptanceEvidencePort;
	readonly acceptancePort?: BuildplaneAcceptancePort;
	/**
	 * Optional hook invoked after the isolated worktree is created and before
	 * the workspace row is recorded / admission proceeds. Intended for dependency
	 * provisioning (e.g. `pnpm install --frozen-lockfile`) so acceptance-check
	 * commands that invoke workspace tooling have their binaries and packages
	 * available. Any thrown error surfaces as a `workspace-provision-failed`
	 * infrastructure failure; the worktree is retained for operator inspection.
	 */
	readonly provisionDeps?: (workspacePath: string) => void;
}

export function createBuildplaneOrchestrator(
	options: CreateBuildplaneOrchestratorOptions,
): BuildplaneOrchestrator {
	const { projectRoot, storage, runtime, policy, workspace } = options;
	const profileRegistry = options.profileRegistry;
	const topLevelBudgets = options.budgets;
	const defaultBus = options.eventBus ?? noopBus;
	const admissionStore =
		options.admissionStore === undefined
			? createDefaultRunAdmissionStore(projectRoot)
			: options.admissionStore;
	const admittedPlanReader =
		options.admittedPlanReader ?? createDefaultAdmittedPlanReader();
	const memoryPort = options.memoryPort;
	const ledgerActivityPort = options.ledgerActivityPort;
	const acceptanceEvidencePort =
		options.acceptanceEvidencePort ?? createDefaultAcceptanceEvidencePort();
	const acceptancePort = options.acceptancePort;
	const provisionDeps = options.provisionDeps;
	const outcomeRouting = options.outcomeRouting ?? defaultOutcomeRoutingConfig;
	const strategyWorkflowPromotionRule =
		"multi-round-strategy-workflow->procedure";

	function infrastructureFailure(
		kind: string,
		error: unknown,
	): RunInfrastructureFailure {
		return {
			kind,
			message: error instanceof Error ? error.message : String(error),
		};
	}

	function createDefaultRunAdmissionStore(
		root: string,
	): RunAdmissionLocalEvidenceStore {
		const admissionDir = resolve(
			resolveGitMetadataDir(root),
			"buildplane",
			"admission",
		);
		const receiptsDir = resolve(admissionDir, "receipts");
		const eventsPath = resolve(admissionDir, "events.jsonl");
		return {
			writeReceiptArtifact(input) {
				mkdirSync(receiptsDir, { recursive: true });
				const receiptId =
					typeof input.receipt.receipt_id === "string" &&
					input.receipt.receipt_id.length > 0
						? input.receipt.receipt_id
						: input.receiptDigest.replace(/^sha256:/, "");
				const path = resolve(
					receiptsDir,
					`${sanitizeAdmissionStoreStem(receiptId)}.json`,
				);
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
					ref: createDefaultRunAdmissionEventRef(input),
					path: eventsPath,
				};
			},
		};
	}

	function resolveGitMetadataDir(repositoryRoot: string): string {
		try {
			return execFileSync(
				"git",
				["-C", repositoryRoot, "rev-parse", "--absolute-git-dir"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim();
		} catch {
			return resolve(repositoryRoot, ".git");
		}
	}

	function sanitizeAdmissionStoreStem(value: string): string {
		const safe = value
			.replace(/[^A-Za-z0-9_-]/g, "_")
			.slice(0, MAX_ADMISSION_STEM_LENGTH);
		return safe.length > 0 ? safe : DEFAULT_ADMISSION_STEM;
	}

	function stableAdmissionJson(value: unknown): string {
		if (value === null || typeof value !== "object") {
			return JSON.stringify(value);
		}
		if (Array.isArray(value)) {
			return `[${value.map((item) => stableAdmissionJson(item)).join(",")}]`;
		}
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${stableAdmissionJson(record[key])}`,
			)
			.join(",")}}`;
	}

	function createDefaultRunAdmissionEventRef(input: {
		event: JsonRecord;
		receipt: JsonRecord;
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
		const payload =
			typeof input.event.payload === "object" &&
			input.event.payload !== null &&
			!Array.isArray(input.event.payload)
				? (input.event.payload as JsonRecord)
				: undefined;
		const receiptId =
			typeof payload?.receipt_id === "string"
				? payload.receipt_id
				: typeof input.receipt.receipt_id === "string"
					? input.receipt.receipt_id
					: DEFAULT_ADMISSION_STEM;
		const eventDigest = createHash("sha256")
			.update(
				stableAdmissionJson({
					eventKind,
					recordedAt,
					receiptId,
					payload,
					receipt: input.receipt,
				}),
			)
			.digest("hex");
		return `event://run-admission/${sanitizeAdmissionStoreStem(receiptId)}/${eventDigest}`;
	}

	function toWorkspaceSnapshot(
		run: Run,
		preparedWorkspace: {
			path: string;
			headSha: string;
		},
	): WorkspaceSnapshot {
		return {
			runId: run.id,
			path: preparedWorkspace.path,
			headSha: preparedWorkspace.headSha,
			status: "active",
		};
	}

	function collectWorkspaceChangedFiles(
		workspaceRoot: string,
	): readonly string[] {
		try {
			const tracked = execFileSync(
				"git",
				["-C", workspaceRoot, "diff", "--name-only", "HEAD", "--"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			const untracked = execFileSync(
				"git",
				["-C", workspaceRoot, "ls-files", "--others", "--exclude-standard"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			return Array.from(
				new Set(
					[...tracked.split(/\r?\n/), ...untracked.split(/\r?\n/)]
						.map((path) => path.trim())
						.filter(Boolean),
				),
			).sort();
		} catch {
			return ["../buildplane-diff-unavailable"];
		}
	}

	/**
	 * Current HEAD of the worktree, or null if it cannot be read. The acceptance
	 * gate diffs against `HEAD`, so a worker (or an unsandboxed check) that
	 * `git commit`s inside the detached worktree during execution advances HEAD and
	 * makes `git diff HEAD` report an empty diff — blinding the diff-scope arm to a
	 * committed, possibly out-of-scope delta the merge would still ship. The gate
	 * compares this against the immutable recorded base SHA and rejects fail-closed
	 * on any advance.
	 */
	function readWorkspaceHeadSha(workspaceRoot: string): string | null {
		try {
			return execFileSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return null;
		}
	}

	function createDefaultAcceptanceEvidencePort(): BuildplaneAcceptanceEvidencePort {
		return {
			collectCheckResults(input) {
				return collectAcceptanceCheckResults(
					input.contract,
					input.workspacePath,
				);
			},
		};
	}

	function collectAcceptanceCheckResults(
		contract: AcceptanceContractV0,
		workspacePath: string,
	): readonly AcceptanceCheckResult[] {
		return contract.checks.map((check) => {
			const result = spawnSync(check.command, {
				cwd: workspacePath,
				encoding: "utf8",
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			return {
				command: check.command,
				exitCode: result.status ?? 1,
			};
		});
	}

	function evaluateAcceptanceBeforeFinalization(input: {
		readonly resolvedProfile: PolicyProfile | undefined;
		readonly workspacePath: string;
		readonly currentPacket: UnitPacket;
		readonly currentReceipt: ExecutionReceipt;
		readonly attemptCount: number;
	}): PolicyDecision | null {
		const acceptanceContract =
			input.resolvedProfile?.trustGates?.acceptanceContract;
		if (!acceptanceContract) {
			return null;
		}

		if (!policy.evaluateAcceptanceContract) {
			return {
				kind: "acceptance.contract",
				outcome: "rejected",
				reasons: [
					"acceptance.contract configured but no evaluator is available.",
				],
			};
		}

		let checkResults: readonly AcceptanceCheckResult[];
		try {
			checkResults = acceptanceEvidencePort.collectCheckResults({
				contract: acceptanceContract,
				workspacePath: input.workspacePath,
				packet: input.currentPacket,
				receipt: input.currentReceipt,
				attemptCount: input.attemptCount,
			});
		} catch (error) {
			return {
				kind: "acceptance.contract",
				outcome: "rejected",
				reasons: [
					`acceptance.contract check collection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				],
			};
		}

		return policy.evaluateAcceptanceContract(acceptanceContract, {
			changedFiles: input.currentReceipt.changedFiles,
			checkResults,
		});
	}

	/**
	 * Finalization-time acceptance gate for the async run loop. When a contract is
	 * configured it (1) collects independent check evidence, (2) evaluates the
	 * pass/reject decision, (3) appends a signed `acceptance_recorded` verdict via
	 * the acceptance port **before** the workspace is merged or quarantined
	 * (write-ahead), and (4) returns the rejection decision (or `null` to proceed).
	 * Returns `{ decision: null }` with no side effects when no contract is set —
	 * the opt-in, fail-open-when-unconfigured contract.
	 */
	async function evaluateAndRecordAcceptanceAsync(input: {
		readonly resolvedProfile: PolicyProfile | undefined;
		readonly workspacePath: string;
		readonly baseSha: string;
		readonly currentPacket: UnitPacket;
		readonly currentReceipt: ExecutionReceipt;
		readonly attemptCount: number;
		readonly runId: string;
	}): Promise<PolicyDecision | null> {
		const acceptanceContract =
			input.resolvedProfile?.trustGates?.acceptanceContract;
		if (!acceptanceContract) {
			return null;
		}

		if (!policy.evaluateAcceptanceContract) {
			return {
				kind: "acceptance.contract",
				outcome: "rejected",
				reasons: [
					"acceptance.contract configured but no evaluator is available.",
				],
			};
		}

		let checkResults: readonly AcceptanceCheckResult[];
		try {
			checkResults = acceptanceEvidencePort.collectCheckResults({
				contract: acceptanceContract,
				workspacePath: input.workspacePath,
				packet: input.currentPacket,
				receipt: input.currentReceipt,
				attemptCount: input.attemptCount,
			});
		} catch (error) {
			return {
				kind: "acceptance.contract",
				outcome: "rejected",
				reasons: [
					`acceptance.contract check collection failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				],
			};
		}

		// Re-capture changed files AFTER the checks ran: a check (e.g. `lint --fix`
		// or a snapshot update) can mutate the worktree, and those files must be in
		// the diff-scope decision or out-of-scope writes could merge on a zero exit.
		const changedFiles = collectWorkspaceChangedFiles(input.workspacePath);

		// Fail closed if the worktree HEAD advanced from the recorded base SHA. A
		// worker (or an unsandboxed check) that committed inside the detached
		// worktree moves HEAD, so the `git diff HEAD` above reports an empty diff and
		// the diff-scope arm would let a committed — possibly out-of-scope — delta
		// merge on a zero exit. The recorded base SHA is the only trustworthy anchor;
		// any advance is rejected rather than trusted.
		// A null HEAD (worktree not a readable git repo) is already fail-closed by
		// collectWorkspaceChangedFiles, which returns an out-of-scope
		// "diff-unavailable" sentinel in that case; this guard closes the distinct
		// bypass where HEAD is readable but has moved off the recorded base.
		const currentHeadSha = readWorkspaceHeadSha(input.workspacePath);
		const headAdvanced =
			currentHeadSha !== null && currentHeadSha !== input.baseSha;

		const decision: PolicyDecision | null = headAdvanced
			? {
					kind: "acceptance.contract",
					outcome: "rejected",
					reasons: [
						`acceptance.contract: worktree HEAD advanced from ${input.baseSha} to ${
							currentHeadSha ?? "unreadable"
						} during execution — a committed in-worktree change escapes the diff-scope gate; rejecting fail-closed.`,
					],
				}
			: policy.evaluateAcceptanceContract(acceptanceContract, {
					changedFiles,
					checkResults,
				});

		if (acceptancePort) {
			const diffScope = headAdvanced
				? { status: "blocked" as const, outOfScopeFiles: [] }
				: (policy.evaluateAcceptanceDiffScope?.(
						changedFiles,
						acceptanceContract,
					) ?? { status: "passed" as const, outOfScopeFiles: [] });
			const record: AcceptanceRecordInput = {
				runId: input.runId,
				admissionEventId: input.currentPacket.provenance_ref,
				outcome: decision ? "rejected" : "passed",
				diffScopeStatus: diffScope.status,
				outOfScopeFiles: diffScope.outOfScopeFiles,
				checkResults,
				evaluatedAt: new Date().toISOString(),
			};
			await acceptancePort.recordAcceptance(record);
		}

		storage.recordAcceptanceShadow(
			input.runId,
			decision ? "rejected" : "passed",
		);

		return decision;
	}

	function createRunAdmissionDigest(
		value: JsonRecord | readonly JsonRecord[],
	): string {
		return `sha256:${createHash("sha256")
			.update(JSON.stringify(value))
			.digest("hex")}`;
	}

	function uniqueStrings(values: readonly string[]): readonly string[] {
		return Array.from(new Set(values));
	}

	function collectDeclaredScopeAllowedPaths(
		validatedPacket: UnitPacket,
	): readonly string[] {
		return uniqueStrings([
			...validatedPacket.unit.expectedOutputs,
			...validatedPacket.verification.requiredOutputs,
		]);
	}

	function deriveRunAdmissionRequestedSideEffects(
		validatedPacket: UnitPacket,
	): readonly string[] {
		const requestedSideEffects = ["fs.read:repo"];
		if (collectDeclaredScopeAllowedPaths(validatedPacket).length > 0) {
			requestedSideEffects.push("fs.write:declared_scope");
		}
		if (validatedPacket.execution !== undefined) {
			requestedSideEffects.push("command.execute:verification");
		}
		return uniqueStrings(requestedSideEffects);
	}

	function createRunAdmissionEvidenceInputs(ctx: {
		run: Run;
		validatedPacket: UnitPacket;
		workspace: WorkspaceSnapshot;
		worktreeClean: boolean;
	}): readonly RunAdmissionEvidenceInput[] {
		const scope = {
			allowed_paths: collectDeclaredScopeAllowedPaths(ctx.validatedPacket),
			network_allowed: false,
		};
		return [
			{
				kind: "git.status",
				ref: `workspace://${ctx.run.id}/git-status-preflight`,
				digest: createRunAdmissionDigest({
					run_id: ctx.run.id,
					worktree_path: ctx.workspace.path,
					status: ctx.worktreeClean ? "clean" : "dirty",
				}),
				required: true,
				status: "present",
			},
			{
				kind: "git.rev-parse",
				ref: `workspace://${ctx.run.id}/rev-parse-head`,
				digest: createRunAdmissionDigest({
					run_id: ctx.run.id,
					head_commit: ctx.workspace.headSha,
				}),
				required: true,
				status: "present",
			},
			{
				kind: "declared_scope",
				ref: `workspace://${ctx.run.id}/declared-scope`,
				digest: createRunAdmissionDigest(scope),
				required: true,
				status: "present",
			},
		];
	}

	function createRunAdmissionReceiptInput(ctx: {
		run: Run;
		validatedPacket: UnitPacket;
		workspace: WorkspaceSnapshot;
		projectRoot: string;
	}): CreateRunAdmissionReceiptDryRunInput {
		const { run, validatedPacket, workspace: preparedWorkspace } = ctx;
		const worktreeClean = workspace.checkWorktreeClean(preparedWorkspace.path);
		const declaredScope = {
			allowed_paths: collectDeclaredScopeAllowedPaths(validatedPacket),
			network_allowed: false,
		};
		const requestedSideEffects =
			deriveRunAdmissionRequestedSideEffects(validatedPacket);
		return {
			receiptId: `run_admission_${run.id}`,
			decidedAt: new Date().toISOString(),
			run: {
				run_id: run.id,
				unit_id: validatedPacket.unit.id,
				unit_kind: validatedPacket.unit.kind,
				unit_scope: validatedPacket.unit.scope,
				policy_profile: validatedPacket.unit.policyProfile,
				verification_contract: validatedPacket.unit.verificationContract,
				provenance_ref: validatedPacket.provenance_ref,
			} satisfies JsonRecord,
			repo: {
				path: ctx.projectRoot,
				worktree_path: preparedWorkspace.path,
				expected_remote: "local-first",
				base_ref: "HEAD",
				base_commit: preparedWorkspace.headSha,
				head_commit: preparedWorkspace.headSha,
				worktree_clean: worktreeClean,
			},
			request: {
				requested_capabilities: requestedSideEffects,
				requested_side_effects: requestedSideEffects,
				declared_scope: declaredScope,
			},
			policyProfileId: validatedPacket.unit.policyProfile,
			evidenceInputs: createRunAdmissionEvidenceInputs({
				run,
				validatedPacket,
				workspace: preparedWorkspace,
				worktreeClean,
			}),
			actor: "kernel.orchestrator",
			source: "run-loop",
			host: "kernel",
		};
	}

	function admissionDeniedFailure(
		record: RunAdmissionReceiptAttemptRecord,
	): RunInfrastructureFailure {
		return {
			kind: "run-admission-denied",
			message: `Run admission ${record.payload.decision}: ${[
				...record.payload.missing_evidence,
				...record.payload.unsafe_requests,
			].join(" ")}`,
		};
	}

	function finalizeAdmissionRecordingFailure(
		ctx: {
			run: Run;
			workspace: WorkspaceSnapshot;
		},
		error: unknown,
	): RunPacketResult {
		return finalizeInfrastructureFailure(
			ctx.run,
			infrastructureFailure("run-admission-record-failed", error),
			{
				workspace: ctx.workspace,
				workspaceStatus: "retained",
			},
		);
	}

	function finalizeAdmissionStoreUnavailable(ctx: {
		run: Run;
		workspace: WorkspaceSnapshot;
	}): RunPacketResult {
		return finalizeInfrastructureFailure(
			ctx.run,
			infrastructureFailure(
				"run-admission-store-unavailable",
				"Run admission evidence store is required before live worker execution.",
			),
			{
				workspace: ctx.workspace,
				workspaceStatus: "retained",
			},
		);
	}

	function admitPreparedRunSync(ctx: {
		run: Run;
		validatedPacket: UnitPacket;
		workspace: WorkspaceSnapshot;
		projectRoot: string;
	}): { ok: true } | { ok: false; result: RunPacketResult } {
		if (!admissionStore) {
			return {
				ok: false,
				result: finalizeAdmissionStoreUnavailable(ctx),
			};
		}
		try {
			const receipt = createRunAdmissionReceiptLive(
				createRunAdmissionReceiptInput(ctx),
			);
			const record = recordRunAdmissionReceiptAttemptSync({
				receipt,
				store: admissionStore,
			});
			if (
				record.payload.decision !== "PASS" ||
				record.payload.will_execute_worker !== true
			) {
				return {
					ok: false,
					result: finalizeInfrastructureFailure(
						ctx.run,
						admissionDeniedFailure(record),
						{
							workspace: ctx.workspace,
							workspaceStatus: "retained",
						},
					),
				};
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				result: finalizeAdmissionRecordingFailure(ctx, error),
			};
		}
	}

	async function admitPreparedRunAsync(ctx: {
		run: Run;
		validatedPacket: UnitPacket;
		workspace: WorkspaceSnapshot;
		projectRoot: string;
	}): Promise<{ ok: true } | { ok: false; result: RunPacketResult }> {
		if (!admissionStore) {
			return {
				ok: false,
				result: finalizeAdmissionStoreUnavailable(ctx),
			};
		}
		try {
			const provenanceRef = ctx.validatedPacket.provenance_ref;
			if (provenanceRef) {
				const eventsDbPath = resolve(
					ctx.projectRoot,
					".buildplane",
					"ledger",
					"events.db",
				);
				let admitted: AdmittedPlanRecord | undefined;
				try {
					admitted = await admittedPlanReader.read(eventsDbPath, provenanceRef);
				} catch (err) {
					return {
						ok: false,
						result: finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure(
								"plan-not-admitted",
								`plan_admitted tape read failed for provenance_ref "${provenanceRef}": ${String(err)}`,
							),
							{ workspace: ctx.workspace, workspaceStatus: "retained" },
						),
					};
				}
				if (
					!admitted?.signedByKernel ||
					admitted.authorizedNextStep !== PLAN_ADMITTED_AUTHORIZED_NEXT_STEP
				) {
					return {
						ok: false,
						result: finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure(
								"plan-not-admitted",
								`No signed plan_admitted authorizing dispatch found on the tape for provenance_ref "${provenanceRef}".`,
							),
							{ workspace: ctx.workspace, workspaceStatus: "retained" },
						),
					};
				}
			}
			const receipt = createRunAdmissionReceiptLive(
				createRunAdmissionReceiptInput(ctx),
			);
			const record = await recordRunAdmissionReceiptAttempt({
				receipt,
				store: admissionStore,
			});
			if (
				record.payload.decision !== "PASS" ||
				record.payload.will_execute_worker !== true
			) {
				return {
					ok: false,
					result: finalizeInfrastructureFailure(
						ctx.run,
						admissionDeniedFailure(record),
						{
							workspace: ctx.workspace,
							workspaceStatus: "retained",
						},
					),
				};
			}
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				result: finalizeAdmissionRecordingFailure(ctx, error),
			};
		}
	}

	function buildStrategyProcedureCandidate(
		strategy: StrategyPacket,
		strategyResult: StrategyResult,
		workflowLearning: {
			readonly kind: string;
			readonly title: string;
			readonly body: string;
		},
	): Parameters<BuildplaneStoragePort["createProcedure"]>[0] | null {
		if (strategyResult.outcome !== "passed") {
			return null;
		}

		const implementer = strategy.children.find(
			(child) => child.role === "implementer",
		);
		const taskType = implementer?.packet.intent?.taskType;
		if (!implementer || !taskType) {
			return null;
		}

		return {
			name: `${strategy.mode} workflow for ${taskType} tasks`,
			taskType,
			bodyMarkdown: `Use an ${strategy.mode} workflow for ${taskType} tasks.\n\nObserved learning: ${workflowLearning.body}`,
			metadata: {
				promotionRule: strategyWorkflowPromotionRule,
				strategyMode: strategy.mode,
				sourceLearningTitle: workflowLearning.title,
				sourceLearningKind: workflowLearning.kind,
				sourceStrategyId: strategy.id,
			},
			createdBy: "worker",
			sourceRunId: strategyResult.winnerRunId,
			sourceTaskId: implementer.packet.unit.id,
		};
	}

	function promoteStrategyWorkflowProcedure(
		strategy: StrategyPacket,
		strategyResult: StrategyResult,
		learnings: readonly {
			readonly kind: string;
			readonly title: string;
			readonly body: string;
		}[],
	): void {
		const workflowLearning = learnings.find(
			(learning) => learning.kind === "workflow",
		);
		if (!workflowLearning) {
			return;
		}

		const candidate = buildStrategyProcedureCandidate(
			strategy,
			strategyResult,
			workflowLearning,
		);
		if (!candidate?.taskType) {
			return;
		}

		storage.upsertProcedure(candidate, {
			matchMetadata: {
				promotionRule: strategyWorkflowPromotionRule,
				strategyMode: strategy.mode,
			},
			skipIfConflictingActiveName: true,
		});
	}

	function finalizeInfrastructureFailure(
		run: Run,
		failure: RunInfrastructureFailure,
		options?: {
			receipt?: ExecutionReceipt;
			decision?: PolicyDecision;
			workspace?: WorkspaceSnapshot;
			workspaceStatus?: "retained";
		},
	): RunPacketResult {
		try {
			const failedRun = storage.commitRunFailureOutcome(
				run.id,
				options?.workspaceStatus === "retained"
					? {
							infrastructureFailure: failure,
							workspaceStatus: "retained",
						}
					: {
							infrastructureFailure: failure,
						},
			);

			return {
				run: failedRun,
				receipt: options?.receipt,
				decision: options?.decision,
				failure,
				workspace:
					options?.workspaceStatus === "retained" && options.workspace
						? {
								...options.workspace,
								status: "retained",
							}
						: undefined,
			};
		} catch (finalizationError) {
			return {
				run: {
					id: run.id,
					unitId: run.unitId,
					status: "failed",
				},
				receipt: options?.receipt,
				decision: options?.decision,
				failure: infrastructureFailure(
					"run-failure-finalization-failed",
					finalizationError,
				),
			};
		}
	}

	type PrepareRunResult =
		| {
				ok: true;
				ctx: {
					run: Run;
					validatedPacket: UnitPacket;
					workspace: WorkspaceSnapshot;
					projectRoot: string;
				};
		  }
		| { ok: false; result: RunPacketResult };

	function prepareRun(
		packet: UnitPacket,
		createRunOptions?: CreateRunOptions,
	): PrepareRunResult {
		storage.getStatusSnapshot();

		const validatedPacket = validatePacketForWorkspaceRoot(
			packet,
			join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
		);
		// Outcome-driven routing producer (opt-in, default OFF). Fills
		// routingHints.preferredWorker from run_outcomes scores. Must run before
		// createRun so the persisted unit_snapshot equals the executed route, and
		// the recorder reads the same routedPacket — recorded route == actual route.
		// V1 threads no per-run seed (exploreSeed undefined); cold-start rotation
		// guarantees coverage without ε.
		const routedPacket = fillRoutingHints(
			validatedPacket,
			storage,
			outcomeRouting,
			Date.now(),
		);
		const { headSha } = workspace.assertRunnableRepository(projectRoot);
		const run = storage.createRun(routedPacket, createRunOptions);

		let preparedWorkspace: WorkspaceSnapshot;

		try {
			const createdWorkspace = workspace.prepareWorkspace(
				projectRoot,
				run.id,
				headSha,
			);
			preparedWorkspace = toWorkspaceSnapshot(run, createdWorkspace);
		} catch (error) {
			const failure = infrastructureFailure("workspace-prepare-failed", error);
			return { ok: false, result: finalizeInfrastructureFailure(run, failure) };
		}

		if (provisionDeps) {
			try {
				provisionDeps(preparedWorkspace.path);
			} catch (error) {
				// The worktree exists but its dependencies could not be provisioned.
				// Retain it so the operator can inspect the failed state; do not
				// record the workspace row or proceed to admission/execution — a run
				// whose acceptance checks cannot execute must never reach the gate.
				const failure = infrastructureFailure(
					"workspace-provision-failed",
					error,
				);
				return {
					ok: false,
					result: finalizeInfrastructureFailure(run, failure, {
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					}),
				};
			}
		}

		try {
			storage.recordWorkspacePrepared(run.id, {
				path: preparedWorkspace.path,
				headSha: preparedWorkspace.headSha,
				sourceProjectRoot: projectRoot,
			});
		} catch (error) {
			let cleanupDetail: string | undefined;
			try {
				const cleanupResult = workspace.deleteWorkspace({
					path: preparedWorkspace.path,
					projectRoot,
				});
				if (!cleanupResult.deleted) {
					cleanupDetail =
						cleanupResult.cleanupError ?? "workspace cleanup failed";
				}
			} catch (cleanupError) {
				cleanupDetail =
					cleanupError instanceof Error
						? cleanupError.message
						: String(cleanupError);
			}

			const failure = infrastructureFailure(
				"workspace-persistence-failed",
				cleanupDetail
					? `${error instanceof Error ? error.message : String(error)}; cleanup also failed: ${cleanupDetail}`
					: error,
			);
			return { ok: false, result: finalizeInfrastructureFailure(run, failure) };
		}

		try {
			storage.markRunRunning(run.id);
		} catch (error) {
			const failure = infrastructureFailure("run-start-failed", error);
			return {
				ok: false,
				result: finalizeInfrastructureFailure(run, failure, {
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				}),
			};
		}

		return {
			ok: true,
			ctx: {
				run,
				validatedPacket: routedPacket,
				workspace: preparedWorkspace,
				projectRoot,
			},
		};
	}

	function recordModelOutcome(
		ctx: { run: Run; validatedPacket: UnitPacket },
		success: boolean,
	): void {
		const packet = ctx.validatedPacket;
		if (packet.model === undefined) {
			return;
		}
		try {
			storage.appendRunOutcome({
				taskType: packet.intent?.taskType ?? packet.unit.kind,
				worker: packet.routingHints?.preferredWorker ?? "sdk",
				success,
				sourceRunId: ctx.run.id,
			});
		} catch {
			// Silent — a write-only memory row must never break run finalization.
		}
	}

	function finalizeRun(
		ctx: {
			run: Run;
			validatedPacket: UnitPacket;
			workspace: WorkspaceSnapshot;
			attemptCount?: number;
		},
		receipt: ExecutionReceipt,
		preEvaluatedDecision?: PolicyDecision,
	): RunPacketResult {
		const {
			run,
			validatedPacket,
			workspace: preparedWorkspace,
			attemptCount,
		} = ctx;

		if (!preEvaluatedDecision) {
			try {
				storage.recordExecutionEvidence(run.id, receipt);
			} catch (error) {
				const failure = infrastructureFailure(
					"execution-evidence-persistence-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure, {
					receipt,
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}
		}

		let decision: PolicyDecision;
		if (preEvaluatedDecision) {
			decision = preEvaluatedDecision;
		} else {
			try {
				decision = policy.evaluateRun(validatedPacket, receipt);
			} catch (error) {
				const failure = infrastructureFailure(
					"policy-evaluation-failed",
					error,
				);
				return finalizeInfrastructureFailure(run, failure, {
					receipt,
					workspace: preparedWorkspace,
					workspaceStatus: "retained",
				});
			}
		}

		if (decision.outcome === "rejected" || decision.outcome === "retrying") {
			const rejectedDecision =
				decision.outcome === "rejected"
					? decision
					: {
							kind: "reject-run" as const,
							outcome: "rejected" as const,
							reasons: decision.reasons,
						};
			try {
				const failedRun = storage.commitRunFailureOutcome(run.id, {
					decision: rejectedDecision,
					workspaceStatus: "retained",
				});

				// Extract constraint learnings from rejection — silent (rejected outcome only, not retrying)
				if (memoryPort && decision.outcome === "rejected") {
					try {
						const learnings = extractLearnings({
							run: failedRun,
							receipt,
							decision: rejectedDecision,
							packet: validatedPacket,
							attemptCount,
						});
						if (learnings.length > 0) {
							memoryPort.writeLearnings(failedRun.id, learnings);
						}
						memoryPort.promoteLearnings(failedRun.id);
					} catch {
						// Silent
					}
				}

				// retrying is not a terminal quality signal — record only a true
				// rejection (mirrors the rejected-only learnings guard above).
				if (decision.outcome === "rejected") {
					recordModelOutcome(ctx, false);
				}

				return {
					run: failedRun,
					receipt,
					decision: rejectedDecision,
					workspace: {
						...preparedWorkspace,
						status: "retained",
					},
				};
			} catch (error) {
				return {
					run: {
						id: run.id,
						unitId: run.unitId,
						status: "failed",
					},
					receipt,
					decision: rejectedDecision,
					failure: infrastructureFailure(
						"run-failure-finalization-failed",
						error,
					),
				};
			}
		}

		// At this point decision.outcome === "approved"
		const approvedDecision =
			decision as import("./run-loop.js").ApprovedPolicyDecision;

		// Merge workspace changes first — if this fails we must not mark the run as passed
		// and must retain the workspace so changes are not lost.
		let mergedHeadSha: string | undefined;
		if (workspace.commitAndMergeWorkspace) {
			try {
				const mergeResult = workspace.commitAndMergeWorkspace({
					path: preparedWorkspace.path,
					runId: run.id,
					projectRoot,
				});
				mergedHeadSha = mergeResult.mergedHeadSha;
			} catch (error) {
				return finalizeInfrastructureFailure(
					run,
					infrastructureFailure("merge-failed", error),
					{
						receipt,
						decision,
						workspace: preparedWorkspace,
						workspaceStatus: "retained",
					},
				);
			}
		}

		let completedRun: Run;
		try {
			completedRun = storage.commitRunSuccessOutcome(run.id, approvedDecision);
		} catch (error) {
			const failure = infrastructureFailure(
				"run-success-persistence-failed",
				error,
			);
			return finalizeInfrastructureFailure(run, failure, {
				receipt,
				decision,
				workspace: preparedWorkspace,
				workspaceStatus: "retained",
			});
		}

		recordModelOutcome(ctx, true);

		// Extract and persist learnings — silent, never breaks the run
		if (memoryPort) {
			try {
				const learnings = extractLearnings({
					run: completedRun,
					receipt,
					decision: approvedDecision,
					packet: validatedPacket,
					attemptCount,
				});
				if (learnings.length > 0) {
					memoryPort.writeLearnings(completedRun.id, learnings);
				}
				memoryPort.promoteLearnings(completedRun.id);
			} catch {
				// Silent — follows event bus subscriber convention
			}
		}

		let cleanupResult: { deleted: boolean; cleanupError?: string };
		try {
			cleanupResult = workspace.deleteWorkspace({
				path: preparedWorkspace.path,
				projectRoot,
			});
		} catch (error) {
			cleanupResult = {
				deleted: false,
				cleanupError: error instanceof Error ? error.message : String(error),
			};
		}
		if (!cleanupResult.deleted) {
			const cleanupError =
				cleanupResult.cleanupError ?? "workspace cleanup failed";
			try {
				storage.recordWorkspaceCleanupFailed(run.id, cleanupError);
			} catch (error) {
				return {
					run: completedRun,
					receipt,
					decision,
					failure: infrastructureFailure(
						"workspace-cleanup-persistence-failed",
						error,
					),
					workspace: {
						...preparedWorkspace,
						status: "cleanup-failed",
						cleanupError,
					},
				};
			}

			return {
				run: completedRun,
				receipt,
				decision,
				workspace: {
					...preparedWorkspace,
					status: "cleanup-failed",
					cleanupError,
				},
			};
		}

		try {
			storage.recordWorkspaceDeleted(run.id);
		} catch (error) {
			return {
				run: completedRun,
				receipt,
				decision,
				failure: infrastructureFailure(
					"workspace-delete-persistence-failed",
					error,
				),
				workspace: preparedWorkspace,
			};
		}

		return {
			run: completedRun,
			receipt,
			decision,
			mergedHeadSha,
		};
	}

	const orchestrator: BuildplaneOrchestrator = {
		initializeProject() {
			return storage.initializeProject();
		},
		runPacket(packet, eventBus?, createRunOptions?) {
			const bus = eventBus ?? defaultBus;
			const prepared = prepareRun(packet, createRunOptions);
			if (!prepared.ok) return prepared.result;
			const { ctx } = prepared;
			const admitted = admitPreparedRunSync(ctx);
			if (admitted.ok === false) return admitted.result;

			const profileName = ctx.validatedPacket.unit.policyProfile;
			let resolvedProfile: PolicyProfile | undefined;
			if (profileRegistry && profileName) {
				try {
					resolvedProfile = profileRegistry.resolve(profileName);
				} catch (error) {
					return finalizeInfrastructureFailure(
						ctx.run,
						infrastructureFailure("profile-resolution-failed", error),
						{
							workspace: ctx.workspace,
							workspaceStatus: "retained",
						},
					);
				}
			}

			bus.emit({
				kind: "execution-started",
				runId: ctx.run.id,
				timestamp: new Date().toISOString(),
				executionType: "command",
			});

			let receipt: ExecutionReceipt;
			try {
				receipt = runtime.executePacket(
					ctx.validatedPacket,
					ctx.workspace.path,
				);
				receipt = {
					...receipt,
					changedFiles: collectWorkspaceChangedFiles(ctx.workspace.path),
				};
			} catch (error) {
				bus.emit({
					kind: "execution-error",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					message: error instanceof Error ? error.message : String(error),
					phase: "execution",
				});
				const failure = infrastructureFailure(
					"runtime-execution-failed",
					error,
				);
				return finalizeInfrastructureFailure(ctx.run, failure, {
					workspace: ctx.workspace,
					workspaceStatus: "retained",
				});
			}

			bus.emit({
				kind: "command-execution-complete",
				runId: ctx.run.id,
				timestamp: new Date().toISOString(),
				exitCode: receipt.exitCode,
				outputChecks: receipt.outputChecks.map((c) => ({
					path: c.path,
					exists: c.exists,
				})),
			});

			const acceptanceDecision = evaluateAcceptanceBeforeFinalization({
				resolvedProfile,
				workspacePath: ctx.workspace.path,
				currentPacket: ctx.validatedPacket,
				currentReceipt: receipt,
				attemptCount: 0,
			});
			if (acceptanceDecision) {
				try {
					storage.recordExecutionEvidence(ctx.run.id, receipt);
				} catch (error) {
					return finalizeInfrastructureFailure(
						ctx.run,
						infrastructureFailure(
							"execution-evidence-persistence-failed",
							error,
						),
						{
							receipt,
							workspace: ctx.workspace,
							workspaceStatus: "retained",
						},
					);
				}
				return finalizeRun(
					{ ...ctx, attemptCount: 0 },
					receipt,
					acceptanceDecision,
				);
			}

			return finalizeRun(ctx, receipt);
		},
		async runPacketAsync(packet, eventBus?, createRunOptions?) {
			const bus = eventBus ?? defaultBus;

			// Resolve policy profile from registry
			const profileName = packet.unit.policyProfile;
			let resolvedProfile: PolicyProfile | undefined;
			if (profileRegistry && profileName) {
				try {
					resolvedProfile = profileRegistry.resolve(profileName);
				} catch (error) {
					// Unknown profile — fail the run without workspace preparation
					const failure = infrastructureFailure(
						"profile-resolution-failed",
						error,
					);
					try {
						const validatedPacket = validatePacketForWorkspaceRoot(
							packet,
							join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
						);
						const run = storage.createRun(validatedPacket, createRunOptions);
						return finalizeInfrastructureFailure(run, failure);
					} catch {
						return {
							run: {
								id: "profile-error",
								unitId: packet.unit.id,
								status: "failed" as const,
							},
							failure,
						};
					}
				}
			}

			// Operator suspension gate — check before workspace preparation
			if (resolvedProfile?.trustGates?.requiresApproval === true) {
				const validatedPacket = validatePacketForWorkspaceRoot(
					packet,
					join(projectRoot, ".buildplane", "workspaces", "future-run-id"),
				);
				const run = storage.createRun(validatedPacket, createRunOptions);
				storage.markRunRunning(run.id);
				const suspendedRun = storage.suspendRun(run.id);
				bus.emit({
					kind: "run-suspended",
					runId: run.id,
					unitId: packet.unit.id,
					timestamp: new Date().toISOString(),
					profileName: resolvedProfile.name,
					reason: "policy profile requires operator approval before execution",
				});
				return { run: suspendedRun, suspended: true } as RunPacketResult;
			}

			const prepared = prepareRun(packet, createRunOptions);
			if (!prepared.ok) {
				// Emit a visible event when workspace preparation fails
				if (prepared.result.failure?.kind === "workspace-prepare-failed") {
					bus.emit({
						kind: "execution-error",
						runId: prepared.result.run.id,
						timestamp: new Date().toISOString(),
						message: prepared.result.failure.message,
						phase: "workspace-prepare",
					});
				}
				return prepared.result;
			}
			const { ctx } = prepared;
			const admitted = await admitPreparedRunAsync(ctx);
			if (admitted.ok === false) return admitted.result;

			const runContext: EventContext = {
				runId: ctx.run.id,
				executor:
					ctx.validatedPacket.routingHints?.preferredWorker ??
					(ctx.validatedPacket.model ? "ai-sdk" : "command"),
			};
			const scopedBus = createRunScopedBus(runContext, bus);

			// Budget enforcement: count tokens mid-stream and abort if limit exceeded
			const effectiveBudgets = resolvedProfile?.budgets ?? topLevelBudgets;
			const abortController = new AbortController();
			let budgetUnsubscribe: (() => void) | undefined;

			if (effectiveBudgets && policy.evaluateBudgets) {
				const runStartTime = Date.now();
				let tokenCount = 0;
				let budgetBreached = false;

				budgetUnsubscribe = scopedBus.subscribe((event) => {
					if (budgetBreached || abortController.signal.aborted) return;
					if (event.kind !== "model-token-delta") return;
					if (event.runId !== ctx.run.id) return;

					tokenCount++;
					const elapsedMs = Date.now() - runStartTime;
					const usage = {
						promptTokens: 0,
						completionTokens: tokenCount,
						totalTokens: tokenCount,
						elapsedMs,
					};

					const decision = policy.evaluateBudgets?.(
						ctx.validatedPacket,
						usage,
						effectiveBudgets,
					);
					if (decision) {
						budgetBreached = true;
						const isTokensBreach =
							effectiveBudgets.maxTokens !== undefined &&
							tokenCount > effectiveBudgets.maxTokens;
						const budgetType: "tokens" | "time" = isTokensBreach
							? "tokens"
							: "time";
						const limit = isTokensBreach
							? (effectiveBudgets.maxTokens ?? 0)
							: (effectiveBudgets.maxComputeTimeMs ?? 0);
						const actual = isTokensBreach ? tokenCount : elapsedMs;
						scopedBus.emit({
							kind: "policy-budget-breached",
							runId: ctx.run.id,
							timestamp: new Date().toISOString(),
							budgetType,
							limit,
							actual,
						});
						abortController.abort();
					}
				});
			}

			async function executeOnce(p: UnitPacket): Promise<ExecutionReceipt> {
				const activityType = p.model
					? ("model" as const)
					: ("command" as const);
				scopedBus.emit({
					kind: "execution-started",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					executionType: activityType,
				});
				const activityId = randomUUID();
				if (ledgerActivityPort) {
					// write-ahead: resolves only once activity_started is durable on the tape
					await ledgerActivityPort.activityStarted({
						runId: ctx.run.id,
						activityId,
						activityType,
						input: activityInputDescriptor(p),
					});
				}
				let r: ExecutionReceipt;
				if (runtime.executePacketAsync) {
					r = await runtime.executePacketAsync(
						p,
						ctx.workspace.path,
						scopedBus,
						abortController.signal,
					);
				} else {
					r = runtime.executePacket(p, ctx.workspace.path);
					scopedBus.emit({
						kind: "command-execution-complete",
						runId: ctx.run.id,
						timestamp: new Date().toISOString(),
						exitCode: r.exitCode,
						outputChecks: r.outputChecks.map((c) => ({
							path: c.path,
							exists: c.exists,
						})),
					});
				}
				if (ledgerActivityPort) {
					await ledgerActivityPort.activityCompleted({
						runId: ctx.run.id,
						activityId,
						result: activityResultDescriptor(r),
					});
				}
				return r;
			}

			async function executeOnceWithChangedFiles(
				p: UnitPacket,
			): Promise<ExecutionReceipt> {
				const receipt = await executeOnce(p);
				return {
					...receipt,
					changedFiles: collectWorkspaceChangedFiles(ctx.workspace.path),
				};
			}

			let currentPacket = ctx.validatedPacket;
			let currentReceipt: ExecutionReceipt;

			try {
				currentReceipt = await executeOnceWithChangedFiles(currentPacket);
			} catch (error) {
				budgetUnsubscribe?.();
				const message = error instanceof Error ? error.message : String(error);
				scopedBus.emit({
					kind: "execution-error",
					runId: ctx.run.id,
					timestamp: new Date().toISOString(),
					message,
					phase: "execution",
				});
				return finalizeInfrastructureFailure(
					ctx.run,
					infrastructureFailure("runtime-execution-failed", error),
					{
						workspace: ctx.workspace,
						workspaceStatus: "retained",
					},
				);
			}
			// Retry-aware policy loop — budget subscriber stays active across all attempts
			// so token usage accumulates cumulatively. budgetUnsubscribe is called in the
			// finally block after ALL attempts complete (success, rejection, or error).
			let attemptCount = 0;
			try {
				while (true) {
					storage.recordExecutionEvidence(ctx.run.id, currentReceipt);

					const architectureGate =
						resolvedProfile?.trustGates?.architectureDiffScope;
					if (architectureGate && policy.evaluateArchitectureDiffScope) {
						const architectureDecision = policy.evaluateArchitectureDiffScope(
							currentReceipt.changedFiles ?? [],
							architectureGate,
						);
						if (architectureDecision) {
							return finalizeRun(
								{
									run: ctx.run,
									validatedPacket: currentPacket,
									workspace: ctx.workspace,
									attemptCount,
								},
								currentReceipt,
								architectureDecision,
							);
						}
					}

					let acceptanceDecision: PolicyDecision | null;
					try {
						acceptanceDecision = await evaluateAndRecordAcceptanceAsync({
							resolvedProfile,
							workspacePath: ctx.workspace.path,
							baseSha: ctx.workspace.headSha,
							currentPacket,
							currentReceipt,
							attemptCount,
							runId: ctx.run.id,
						});
					} catch (error) {
						// Recording the signed verdict is a write-ahead gate. If it fails
						// the run must NOT escape unfinalized — fail closed and quarantine.
						return finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure("acceptance-record-failed", error),
							{
								receipt: currentReceipt,
								workspace: ctx.workspace,
								workspaceStatus: "retained",
							},
						);
					}
					if (acceptanceDecision) {
						return finalizeRun(
							{
								run: ctx.run,
								validatedPacket: currentPacket,
								workspace: ctx.workspace,
								attemptCount,
							},
							currentReceipt,
							acceptanceDecision,
						);
					}

					const decision = policy.evaluateRun(
						currentPacket,
						currentReceipt,
						resolvedProfile,
						attemptCount,
					);

					scopedBus.emit({
						kind: "policy-decision",
						runId: ctx.run.id,
						timestamp: new Date().toISOString(),
						decisionKind: decision.kind,
						outcome: decision.outcome,
						reasons: decision.reasons,
					});

					if (decision.kind !== "retry-run") {
						return finalizeRun(
							{ ...ctx, attemptCount },
							currentReceipt,
							decision,
						);
					}

					// Retry: augment packet with feedback and re-execute
					attemptCount = decision.attemptNumber;
					const feedbackSuffix =
						decision.feedbackContext.length > 0
							? `\n\nPrevious attempt failed:\n${decision.feedbackContext.join("\n")}\n\nPlease fix these issues and try again.`
							: "";

					if (currentPacket.model) {
						currentPacket = {
							...currentPacket,
							model: {
								...currentPacket.model,
								systemPrompt:
									(currentPacket.model.systemPrompt ?? "") + feedbackSuffix,
							},
						};
					}

					try {
						currentReceipt = await executeOnceWithChangedFiles(currentPacket);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						scopedBus.emit({
							kind: "execution-error",
							runId: ctx.run.id,
							timestamp: new Date().toISOString(),
							message,
							phase: "retry-execution",
						});
						return finalizeInfrastructureFailure(
							ctx.run,
							infrastructureFailure("runtime-execution-failed", error),
							{
								workspace: ctx.workspace,
								workspaceStatus: "retained",
							},
						);
					}
				}
			} finally {
				budgetUnsubscribe?.();
			}
		},
		getStatus() {
			return storage.getStatusSnapshot();
		},
		inspect(id) {
			const snapshot = storage.inspectTarget(id);
			if (!snapshot.workspace?.path) {
				return snapshot;
			}

			return {
				...snapshot,
				workspace: {
					...snapshot.workspace,
					existsOnDisk: existsSync(snapshot.workspace.path),
				},
			};
		},

		approveRun(runId) {
			return storage.approveRun(runId);
		},

		rejectSuspendedRun(runId) {
			return storage.rejectSuspendedRun(runId);
		},

		async runGraphAsync(
			graph: UnitGraph,
			eventBus?: EventBus,
		): Promise<GraphResult> {
			const bus = eventBus ?? defaultBus;
			const graphId = randomUUID();
			const scheduler = createGraphScheduler(graph);

			// Map from unitId → runId for toResult()
			const runIdMap = new Map<string, string>();
			const decisionReasonsMap = new Map<string, readonly string[]>();

			bus.emit({
				kind: "graph-started",
				runId: graphId,
				graphId,
				unitCount: graph.nodes.length,
				timestamp: new Date().toISOString(),
			});

			// Build a lookup from unitId → UnitGraphNode for dispatch
			const nodeById = new Map(graph.nodes.map((n) => [n.unit.id, n]));

			// In-flight set: promises tagged with their unitId
			const inFlight = new Map<
				string,
				Promise<{ unitId: string; result: RunPacketResult }>
			>();

			/**
			 * Drain the scheduler: dispatch all newly ready units, then wait for
			 * one to complete (via Promise.race). Repeat until done.
			 */
			async function drainLoop(): Promise<void> {
				while (!scheduler.isDone()) {
					// Dispatch all ready units that aren't already in-flight
					for (const unitId of scheduler.readyUnits()) {
						if (inFlight.has(unitId)) continue;
						const graphNode = nodeById.get(unitId);
						if (!graphNode) continue;
						// Build a UnitPacket from the graph node (strip dependsOn)
						const packet: UnitPacket = {
							unit: graphNode.unit,
							execution: graphNode.execution,
							model: graphNode.model,
							intent: graphNode.intent,
							verification: graphNode.verification,
							routingHints: graphNode.routingHints,
							provenance_ref: graphNode.provenance_ref,
						};
						scheduler.markRunning(unitId);
						const promise = orchestrator
							.runPacketAsync(packet, bus)
							.then((result) => ({
								unitId,
								result,
							}));
						inFlight.set(unitId, promise);
					}

					if (inFlight.size === 0) {
						// No ready units and nothing in-flight — graph is stuck or done
						break;
					}

					// Wait for the next unit to complete
					const { unitId, result } = await Promise.race(inFlight.values());
					inFlight.delete(unitId);

					if (result.run.id) {
						runIdMap.set(unitId, result.run.id);
					}
					if (result.decision?.reasons) {
						decisionReasonsMap.set(unitId, result.decision.reasons);
					}

					if (result.run.status === "passed") {
						scheduler.markPassed(unitId);
					} else {
						// failed, cancelled, suspended all count as failure for graph purposes
						scheduler.markFailed(unitId);
					}
				}
			}

			await drainLoop();

			const graphResult = scheduler.toResult(runIdMap, decisionReasonsMap);

			bus.emit({
				kind: "graph-completed",
				runId: graphId,
				graphId,
				outcome: graphResult.outcome,
				timestamp: new Date().toISOString(),
			});

			return graphResult;
		},

		async runStrategy(
			strategy: StrategyPacket,
			eventBus?: EventBus,
		): Promise<StrategyResult> {
			const strategyResult = await runStrategy(
				strategy,
				orchestrator,
				eventBus,
			);

			// Post-strategy memory hook — fires once when all strategy children complete
			if (strategyResult.rounds && strategyResult.rounds.length > 1) {
				let learnings: ReturnType<typeof extractLearnings>;
				try {
					const strategyDecision: PolicyDecision =
						strategyResult.outcome === "passed"
							? {
									kind: "advance-run" as const,
									outcome: "approved" as const,
									reasons: strategyResult.mergeDecision.reasons,
								}
							: {
									kind: "reject-run" as const,
									outcome: "rejected" as const,
									reasons: strategyResult.mergeDecision.reasons,
								};

					learnings = extractLearnings({
						run: {
							id: strategyResult.strategyId,
							unitId: strategyResult.strategyId,
							status: strategyResult.outcome === "passed" ? "passed" : "failed",
						},
						receipt: {
							command: "",
							args: [],
							cwd: "",
							startedAt: new Date().toISOString(),
							completedAt: new Date().toISOString(),
							exitCode: strategyResult.outcome === "passed" ? 0 : 1,
							stdout: "",
							stderr: "",
							outputChecks: [],
						},
						decision: strategyDecision,
						packet: {
							unit: {
								id: strategyResult.strategyId,
								kind: "command",
								scope: "task",
								inputRefs: [],
								expectedOutputs: [],
								verificationContract: "exit-0",
								policyProfile: "default",
							},
							execution: { command: "", args: [] },
							verification: { requiredOutputs: [] },
							provenance_ref: "",
						},
						strategyResult,
					});
				} catch {
					// Silent — follows event bus subscriber convention
					return strategyResult;
				}

				if (memoryPort && learnings.length > 0) {
					try {
						memoryPort.writeLearnings(strategyResult.strategyId, learnings);
					} catch {
						// Silent — follows event bus subscriber convention
					}
				}

				try {
					promoteStrategyWorkflowProcedure(strategy, strategyResult, learnings);
				} catch {
					// Silent — follows event bus subscriber convention
				}
			}

			return strategyResult;
		},
	};

	return orchestrator;
}
