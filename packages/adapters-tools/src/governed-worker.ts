import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { bundleDigest } from "@buildplane/capability-broker";
import {
	type ActionReceiptRecordedV2,
	type ActionRedactionV2,
	type ActionRequestedV2,
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionRequestedV2Digest,
	canonicalGovernedUnitPacketV1Digest,
	canonicalSha256Digest,
	type DurableActionRequestV2,
	type ExecutionReceipt,
	type GovernedActionEvidencePort,
	type GovernedActivityClaimDispositionV1,
	type GovernedActivityClaimPort,
	type GovernedActivityResultDispositionV1,
	type GovernedActivityResultOutcomeV1,
	type GovernedDispatchLineageV3,
	type GovernedWorkerExecutionPort,
	type GovernedWorkerExecutionResultV3,
	type GrantedGovernedActivityClaimV1,
	type RecordActionReceiptV2Input,
	type UnitPacket,
} from "@buildplane/kernel";
import {
	type ActionGatewayReceipt,
	createActionGateway,
	type GovernedActionExecutor,
} from "./action-gateway.js";
import { isTrustedGovernedActionExecutor } from "./governed-executor-provenance.js";

const MAX_ECMASCRIPT_EPOCH_MS = 8_640_000_000_000_000;
const DISPATCH_BUDGET_FIELDS = new Set(["maxTokens", "maxComputeTimeMs"]);

/** The activity lease protocol is kernel-owned and re-exported for callers. */
export type {
	GovernedActivityClaimDispositionV1,
	GovernedActivityClaimPort,
	GovernedActivityResultDispositionV1,
	GovernedActivityResultOutcomeV1,
	GrantedGovernedActivityClaimV1,
} from "@buildplane/kernel";

/**
 * Host-owned evidence persistence for the command action plane. The worker
 * supplies neither a blob reference nor a digest: it receives both only after
 * this store durably records a redacted canonical input/result. Keeping this
 * seam separate from the event tape avoids making telemetry availability an
 * authorization dependency.
 */
export interface GovernedCommandEvidenceStore {
	persistCanonicalInput(input: {
		readonly runId: string;
		readonly actionId: string;
		readonly command: string;
		readonly args: readonly string[];
		readonly cwd?: string;
	}): Promise<{
		readonly canonicalInputDigest: string;
		readonly canonicalInputRef: string;
		readonly redactions: readonly ActionRedactionV2[];
	}>;
	persistActionResult(input: {
		readonly runId: string;
		readonly actionId: string;
		readonly actionRequestRef: string;
		readonly actionRequestDigest: string;
		/** Only hashes, codes, and output existence facts are persisted here. */
		readonly gatewayResult: {
			readonly outcome: ActionGatewayReceipt["outcome"];
			readonly inputDigest: string;
			readonly resultDigest: string;
			readonly exitCode?: number;
		};
		readonly outputChecks: readonly {
			readonly path: string;
			readonly exists: boolean;
		}[];
	}): Promise<{
		readonly evidenceDigest: string;
		readonly evidenceRef: string;
		/** Required only when the typed action succeeded. */
		readonly resultDigest?: string;
		readonly resultRef?: string;
		readonly redactions: readonly ActionRedactionV2[];
	}>;
}

/**
 * Configuration for the command-only first governed worker. Provider/model
 * workers deliberately do not route through this adapter: until an API worker
 * presents typed tool calls, a model packet remains blocked rather than
 * inheriting an ambient CLI or host shell.
 */
export interface CreateGovernedCommandWorkerExecutionPortOptions {
	/** A verified rootless OCI executor; ActionGateway rejects host fallbacks. */
	readonly actionExecutor: GovernedActionExecutor;
	/**
	 * Required for V3 governed execution. Without a host-owned evidence store,
	 * no command is authorized; legacy V1 compatibility has no access to it.
	 */
	readonly evidenceStore?: GovernedCommandEvidenceStore;
	/**
	 * Required for every newly sealed V3 action. It is independent from the
	 * evidence store so losing telemetry can never widen effect authority.
	 */
	readonly activityClaimPort?: GovernedActivityClaimPort;
	/**
	 * Bounded native activity lease requested for one OCI command. The ledger
	 * caps it at the signed dispatch expiry; it is never an authority extension.
	 */
	readonly activityLeaseDurationMs?: number;
	/** Observational only; it can never act as durable action evidence. */
	readonly onActionReceipt?: (receipt: ActionGatewayReceipt) => void;
	/** Injectable wall-clock for deterministic tests and durable timestamps. */
	readonly now?: () => string;
	/** Injectable monotonic clock used only for resource accounting. */
	readonly nowMs?: () => number;
}

type GovernedWorkerExecutionInput = Parameters<
	GovernedWorkerExecutionPort["executeCandidatePacketAsync"]
>[0];

/** The only V3 evidence operations this command-only port can invoke. */
type GovernedActionEvidenceWriter = Pick<
	GovernedActionEvidencePort,
	"recordActionRequested" | "recordActionReceipt"
>;

/**
 * Closed admission-time copy of every caller-owned value that crosses the
 * first asynchronous boundary. Nothing below the worker entrypoint may retain
 * the kernel's mutable invocation object, packet, or dispatch records.
 */
interface GovernedCommandInputSnapshot {
	readonly runId: string;
	readonly packet: UnitPacket;
	readonly projectRoot: string;
	readonly signalAborted: boolean;
	readonly governedDispatch?: GovernedDispatchLineageV3;
	readonly actionEvidencePort?: GovernedActionEvidenceWriter;
}

/**
 * Builds the narrow, command-only governed worker port used by candidate
 * execution. It creates a fresh immutable ActionGateway per kernel run and
 * never references `BuildplaneRuntimePort`, legacy model executors, or host
 * tools. Missing model support is a structured block, never a fallback.
 */
export function createGovernedCommandWorkerExecutionPort(
	options: CreateGovernedCommandWorkerExecutionPortOptions,
): GovernedWorkerExecutionPort {
	if (!options || typeof options !== "object") {
		throw new TypeError(
			"createGovernedCommandWorkerExecutionPort requires explicit options.",
		);
	}
	if (!options.actionExecutor) {
		throw new TypeError(
			"createGovernedCommandWorkerExecutionPort requires an OCI ActionGateway executor.",
		);
	}
	if (!isTrustedGovernedActionExecutor(options.actionExecutor)) {
		throw new TypeError(
			"createGovernedCommandWorkerExecutionPort requires an executor produced by the trusted rootless OCI executor factory.",
		);
	}
	const now = options.now ?? (() => new Date().toISOString());
	const nowMs = options.nowMs ?? (() => Date.now());
	const actionExecutor = options.actionExecutor;
	const evidenceStore = captureEvidenceStore(options.evidenceStore);
	const activityClaimPort = captureActivityClaimPort(options.activityClaimPort);
	const activityLeaseDurationMs = normalizeActivityLeaseDuration(
		options.activityLeaseDurationMs,
	);
	const onActionReceipt = options.onActionReceipt;

	return Object.freeze({
		async executeCandidatePacketAsync(input: GovernedWorkerExecutionInput) {
			const admitted = captureGovernedCommandInput(
				input,
				actionExecutor,
				now,
				nowMs,
			);
			const workerInput = admitted.input;
			const v3Dispatch = admitted.dispatch;
			const execution = workerInput.packet.execution;
			if (workerInput.signalAborted) {
				return resultForDispatch(
					v3Dispatch,
					blockedReceipt(
						workerInput.packet,
						workerInput.projectRoot,
						now,
						"governed worker execution was cancelled before an action was authorized.",
					),
				);
			}
			if (workerInput.packet.model !== undefined && execution !== undefined) {
				return resultForDispatch(
					v3Dispatch,
					blockedReceipt(
						workerInput.packet,
						workerInput.projectRoot,
						now,
						"the governed command worker cannot combine a model packet with command execution.",
					),
				);
			}
			if (!execution) {
				return resultForDispatch(
					v3Dispatch,
					blockedReceipt(
						workerInput.packet,
						workerInput.projectRoot,
						now,
						"governed API/SDK model workers are not configured; ambient model adapters are unavailable in the governed lane.",
					),
				);
			}

			let outputPaths: readonly {
				readonly path: string;
				readonly resolved: string;
			}[];
			try {
				assertWorkspaceRelativePath(
					workerInput.projectRoot,
					execution.cwd,
					"execution cwd",
					{ allowWorkspaceRoot: true },
				);
				outputPaths = Object.freeze(
					workerInput.packet.verification.requiredOutputs.map((path) =>
						Object.freeze({
							path,
							resolved: assertWorkspaceRelativePath(
								workerInput.projectRoot,
								path,
								"required output",
							),
						}),
					),
				);
			} catch (error) {
				return resultForDispatch(
					v3Dispatch,
					blockedReceipt(
						workerInput.packet,
						workerInput.projectRoot,
						now,
						error instanceof Error ? error.message : String(error),
					),
				);
			}

			const actionEvidencePort = workerInput.actionEvidencePort;
			if (!actionEvidencePort || !evidenceStore || !activityClaimPort) {
				throw new TypeError(
					"V3 governed command execution requires durable action evidence, a host-owned evidence store, and a native activity-claim authority before OCI execution.",
				);
			}
			return executeV3Command({
				input: workerInput,
				dispatch: v3Dispatch,
				execution,
				outputPaths,
				actionExecutor,
				evidenceStore,
				actionEvidencePort,
				activityClaimPort,
				activityLeaseDurationMs,
				deadlineAtMs: admitted.deadlineAtMs,
				now,
				nowMs,
				onActionReceipt,
			});
		},
	});
}

/**
 * Evidence is part of governed authorization, not best-effort telemetry. Bind
 * its methods once so mutating the caller's options object cannot replace the
 * write-ahead/result store after the port has been constructed.
 */
function captureEvidenceStore(
	input: GovernedCommandEvidenceStore | undefined,
): GovernedCommandEvidenceStore | undefined {
	if (input === undefined) return undefined;
	if (
		!input ||
		typeof input.persistCanonicalInput !== "function" ||
		typeof input.persistActionResult !== "function"
	) {
		throw new TypeError(
			"createGovernedCommandWorkerExecutionPort evidenceStore must provide durable input and result writers.",
		);
	}
	return Object.freeze({
		persistCanonicalInput: input.persistCanonicalInput.bind(input),
		persistActionResult: input.persistActionResult.bind(input),
	});
}

/** Bind the authority methods once: caller-side mutation cannot cross-wire runs. */
function captureActivityClaimPort(
	input: GovernedActivityClaimPort | undefined,
): GovernedActivityClaimPort | undefined {
	if (input === undefined) return undefined;
	if (
		!input ||
		typeof input.claim !== "function" ||
		typeof input.recordResult !== "function"
	) {
		throw new TypeError(
			"createGovernedCommandWorkerExecutionPort activityClaimPort must provide native claim and terminal-result writers.",
		);
	}
	return Object.freeze({
		claim: input.claim.bind(input),
		recordResult: input.recordResult.bind(input),
	});
}

function normalizeActivityLeaseDuration(value: number | undefined): number {
	const duration = value ?? 300_000;
	if (
		!Number.isSafeInteger(duration) ||
		duration < 1_000 ||
		duration > 900_000
	) {
		throw new RangeError(
			"governed activity lease duration must be an integer from 1000 through 900000 milliseconds.",
		);
	}
	return duration;
}

async function executeV3Command(context: {
	readonly input: GovernedCommandInputSnapshot;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly execution: NonNullable<UnitPacket["execution"]>;
	readonly outputPaths: readonly {
		readonly path: string;
		readonly resolved: string;
	}[];
	readonly actionExecutor: GovernedActionExecutor;
	readonly evidenceStore: GovernedCommandEvidenceStore;
	readonly actionEvidencePort: GovernedActionEvidenceWriter;
	readonly activityClaimPort: GovernedActivityClaimPort;
	readonly activityLeaseDurationMs: number;
	readonly deadlineAtMs: number;
	readonly now: () => string;
	readonly nowMs: () => number;
	readonly onActionReceipt?: (receipt: ActionGatewayReceipt) => void;
}): Promise<GovernedWorkerExecutionResultV3> {
	const {
		input: workerInput,
		dispatch,
		execution,
		evidenceStore,
		actionEvidencePort,
		deadlineAtMs,
	} = context;
	// Do not persist an action intent after the shared signed compute window has
	// elapsed. The gateway and OCI executor repeat this immediately before their
	// own effect boundaries to account for durable setup time.
	assertDispatchComputeDeadlineUnexpiredAt(deadlineAtMs, context.nowMs());
	const actionId = governedActionId(workerInput.runId, dispatch.envelopeDigest);
	const args = [...(execution.args ?? [])];
	const persistedInput = await evidenceStore.persistCanonicalInput({
		runId: workerInput.runId,
		actionId,
		command: execution.command,
		args,
		...(execution.cwd === undefined ? {} : { cwd: execution.cwd }),
	});
	assertPersistedInput(persistedInput);
	const requestedAt = context.now();
	const actionRequest: ActionRequestedV2 = {
		schemaVersion: 2,
		runId: workerInput.runId,
		workflowId: dispatch.workflowId,
		unitId: dispatch.unitId,
		attempt: dispatch.attempt,
		provenanceRef: dispatch.provenanceRef,
		actionId,
		idempotencyKey: `${dispatch.idempotencyKey}:command`,
		actionKind: "process",
		canonicalInputDigest: canonicalSha256Digest(
			persistedInput.canonicalInputDigest,
		),
		canonicalInputRef: requireEvidenceReference(
			persistedInput.canonicalInputRef,
			"canonical input",
		),
		dispatchEnvelopeDigest: dispatch.envelopeDigest,
		capabilityBundleDigest: dispatch.capabilityBundleDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: dispatch.sandboxProfileDigest,
		repositoryBindingDigest: dispatch.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: dispatch.ledgerAuthorityRealmDigest,
		governedPacketDigest: dispatch.governedPacketDigest,
		authorityActor: dispatch.authorityActor,
		executionRole: dispatch.executionRole,
		requestedAt,
	};
	const durableRequest =
		await actionEvidencePort.recordActionRequested(actionRequest);
	assertDurableRequest(actionRequest, durableRequest);
	const preGatewayAt = context.now();
	try {
		assertV3DispatchUnexpiredAt(dispatch, preGatewayAt);
	} catch (error) {
		await recordDeniedActionReceipt({
			dispatch,
			durableRequest,
			actionEvidencePort,
			completedAt: preGatewayAt,
			failureCode: "DISPATCH_EXPIRED_BEFORE_OCI_ACTION",
			message:
				error instanceof Error
					? error.message
					: "V3 governed dispatch expired.",
		});
		throw error;
	}
	try {
		assertDispatchComputeDeadlineUnexpiredAt(deadlineAtMs, context.nowMs());
	} catch (error) {
		await recordDeniedActionReceipt({
			dispatch,
			durableRequest,
			actionEvidencePort,
			completedAt: preGatewayAt,
			failureCode: "DISPATCH_COMPUTE_BUDGET_EXHAUSTED_BEFORE_OCI_ACTION",
			message:
				error instanceof Error
					? error.message
					: "V3 governed dispatch compute deadline is exhausted.",
		});
		throw error;
	}
	const activityClaim = requireGrantedActivityClaim(
		await context.activityClaimPort.claim({
			dispatch,
			durableRequest,
			activityId: actionId,
			idempotencyKey: actionRequest.idempotencyKey,
			leaseDurationMs: context.activityLeaseDurationMs,
		}),
		actionId,
		actionRequest.idempotencyKey,
	);
	const preOciAt = context.now();
	try {
		assertActivityClaimUnexpiredAt(activityClaim, preOciAt);
	} catch (error) {
		await recordUnknownActivityAndReceipt({
			dispatch,
			durableRequest,
			actionEvidencePort,
			activityClaimPort: context.activityClaimPort,
			claim: activityClaim,
			completedAt: preOciAt,
			wallTimeMs: 0,
			failureCode: "ACTIVITY_LEASE_EXPIRED_BEFORE_OCI_ACTION",
			message: error instanceof Error ? error.message : String(error),
			evidenceDigest: durableRequest.actionRequestDigest,
			evidenceRef: durableRequest.actionRequestRef,
		});
		throw error;
	}

	let gatewayReceipt: ActionGatewayReceipt;
	const startedAt = preOciAt;
	const startedAtMs = context.nowMs();
	try {
		const gateway = createActionGateway({
			runId: workerInput.runId,
			worktreeRoot: workerInput.projectRoot,
			role: "implementer",
			trustTier: "governed",
			capabilityBundle: workerInput.packet.capability_bundle,
			governedExecutor: context.actionExecutor,
			governedDeadlineAtMs: deadlineAtMs,
			governedNowMs: context.nowMs,
			onReceipt: context.onActionReceipt,
		});
		gatewayReceipt = gateway.execute({
			actionId,
			kind: "process.run",
			command: execution.command,
			...(execution.args === undefined ? {} : { args: execution.args }),
			...(execution.cwd === undefined ? {} : { cwd: execution.cwd }),
		});
	} catch (error) {
		await recordUnknownActivityAndReceipt({
			dispatch,
			durableRequest,
			actionEvidencePort,
			activityClaimPort: context.activityClaimPort,
			claim: activityClaim,
			completedAt: context.now(),
			wallTimeMs: elapsedMilliseconds(startedAtMs, context.nowMs()),
			failureCode: "ACTION_GATEWAY_UNCERTAIN",
			message: error instanceof Error ? error.message : String(error),
			evidenceDigest: durableRequest.actionRequestDigest,
			evidenceRef: durableRequest.actionRequestRef,
		});
		throw error;
	}
	const completedAt = context.now();
	const outputChecks = context.outputPaths.map(({ path }) => ({
		path,
		// The pre-action path validation is not sufficient: an untrusted process
		// can replace a previously absent required output with a symbolic link.
		// Do not let an output check turn that link into a claim that the candidate
		// produced an in-workspace artifact.
		exists: hasSafeRequiredOutput(workerInput.projectRoot, path),
	}));

	let persistedResult: Awaited<
		ReturnType<GovernedCommandEvidenceStore["persistActionResult"]>
	>;
	try {
		persistedResult = await evidenceStore.persistActionResult({
			runId: workerInput.runId,
			actionId,
			actionRequestRef: durableRequest.actionRequestRef,
			actionRequestDigest: durableRequest.actionRequestDigest,
			gatewayResult: {
				outcome: gatewayReceipt.outcome,
				inputDigest: gatewayReceipt.inputDigest,
				resultDigest: gatewayReceipt.resultDigest,
				...(gatewayReceipt.exitCode === undefined
					? {}
					: { exitCode: gatewayReceipt.exitCode }),
			},
			outputChecks,
		});
		assertPersistedResult(persistedResult, gatewayReceipt.outcome);
	} catch (error) {
		await recordUnknownActivityAndReceipt({
			dispatch,
			durableRequest,
			actionEvidencePort,
			activityClaimPort: context.activityClaimPort,
			claim: activityClaim,
			completedAt,
			wallTimeMs: elapsedMilliseconds(startedAtMs, context.nowMs()),
			failureCode: "ACTION_RESULT_PERSISTENCE_UNCERTAIN",
			message: error instanceof Error ? error.message : String(error),
			evidenceDigest: durableRequest.actionRequestDigest,
			evidenceRef: durableRequest.actionRequestRef,
		});
		throw error;
	}

	const outcome = gatewayReceipt.outcome;
	const activityOutcome: GovernedActivityResultOutcomeV1 =
		outcome === "succeeded" ? "succeeded" : "failed";
	const successfulResult =
		outcome === "succeeded"
			? toSuccessfulResultFields(persistedResult)
			: undefined;
	const successfulResultFields = successfulResult ?? {};
	const activityResult = await context.activityClaimPort.recordResult({
		dispatch,
		durableRequest,
		claim: activityClaim,
		outcome: activityOutcome,
		resultDigest: successfulResult?.resultDigest ?? null,
		resultRef: successfulResult?.resultRef ?? null,
		evidenceDigest: canonicalSha256Digest(persistedResult.evidenceDigest),
		evidenceRef: requireEvidenceReference(
			persistedResult.evidenceRef,
			"action evidence",
		),
	});
	if (activityResult.state === "lease_expired") {
		await recordUnknownActivityAndReceipt({
			dispatch,
			durableRequest,
			actionEvidencePort,
			activityClaimPort: context.activityClaimPort,
			claim: activityClaim,
			completedAt,
			wallTimeMs: elapsedMilliseconds(startedAtMs, context.nowMs()),
			failureCode: "ACTIVITY_LEASE_EXPIRED_AFTER_OCI_ACTION",
			message:
				"the activity lease expired before a terminal governed command result could be recorded.",
			evidenceDigest: canonicalSha256Digest(persistedResult.evidenceDigest),
			evidenceRef: requireEvidenceReference(
				persistedResult.evidenceRef,
				"action evidence",
			),
		});
		throw new Error(
			"governed activity lease expired after the OCI action; the effect is recorded as unknown and requires reconciliation.",
		);
	}
	assertRecordedActivityResult(activityResult, activityOutcome);
	const receiptInput = {
		schemaVersion: 2 as const,
		runId: workerInput.runId,
		workflowId: dispatch.workflowId,
		unitId: dispatch.unitId,
		attempt: dispatch.attempt,
		provenanceRef: dispatch.provenanceRef,
		actionId,
		idempotencyKey: actionRequest.idempotencyKey,
		actionRequestDigest: durableRequest.actionRequestDigest,
		dispatchEnvelopeDigest: dispatch.envelopeDigest,
		capabilityBundleDigest: dispatch.capabilityBundleDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: dispatch.sandboxProfileDigest,
		authorityActor: dispatch.authorityActor,
		executionRole: dispatch.executionRole,
		outcome,
		...successfulResultFields,
		evidenceDigest: canonicalSha256Digest(persistedResult.evidenceDigest),
		evidenceRef: requireEvidenceReference(
			persistedResult.evidenceRef,
			"action evidence",
		),
		resourceUsage: {
			wallTimeMs: elapsedMilliseconds(startedAtMs, context.nowMs()),
		},
		redactions: mergeRedactions(
			persistedInput.redactions,
			persistedResult.redactions,
		),
		...(outcome === "succeeded"
			? {}
			: {
					failure: {
						code: outcome === "denied" ? "ACTION_DENIED" : "ACTION_FAILED",
						messageDigest: sha256Digest(
							gatewayReceipt.reason ?? `governed command ${outcome}`,
						),
						retryable: false,
					},
				}),
		completedAt,
	};

	// The native activity result is already immutable. Never replace a recorded
	// success/failure with an `unknown` receipt when receipt persistence fails:
	// recovery must reconcile the exact terminal result.
	const durableReceipt =
		await actionEvidencePort.recordActionReceipt(receiptInput);
	assertDurableReceipt(receiptInput, durableReceipt);

	return {
		executionReceipt: executionReceiptFromGateway({
			execution,
			projectRoot: workerInput.projectRoot,
			startedAt,
			completedAt,
			gatewayReceipt,
			outputChecks,
		}),
		actionReceipts: [
			{
				actionId,
				actionReceiptRef: durableReceipt.receipt.actionReceiptRef,
				actionReceiptDigest: durableReceipt.actionReceiptDigest,
			},
		],
	};
}

/**
 * An OCI action may have started whenever this helper is called. First pin the
 * native lease to `unknown`; only then may the V3 evidence port receive its
 * matching unknown receipt. If either write is indeterminate, leave the claim
 * unresolved so replay blocks instead of inventing a safe-looking terminal
 * record.
 */
async function recordUnknownActivityAndReceipt(input: {
	readonly dispatch: GovernedDispatchLineageV3;
	readonly durableRequest: DurableActionRequestV2;
	readonly actionEvidencePort: GovernedActionEvidenceWriter;
	readonly activityClaimPort: GovernedActivityClaimPort;
	readonly claim: GrantedGovernedActivityClaimV1;
	readonly completedAt: string;
	readonly wallTimeMs: number;
	readonly failureCode: string;
	readonly message: string;
	readonly evidenceDigest: string;
	readonly evidenceRef: string;
}): Promise<void> {
	try {
		const terminal = await input.activityClaimPort.recordResult({
			dispatch: input.dispatch,
			durableRequest: input.durableRequest,
			claim: input.claim,
			outcome: "unknown",
			resultDigest: null,
			resultRef: null,
			evidenceDigest: canonicalSha256Digest(input.evidenceDigest),
			evidenceRef: requireEvidenceReference(
				input.evidenceRef,
				"activity evidence",
			),
		});
		assertRecordedActivityResult(terminal, "unknown");
	} catch {
		// The claim remains unresolved. Do not write an action receipt whose
		// terminal state cannot agree with a tape-backed native result.
		return;
	}
	await recordUnknownActionReceipt(input);
}

async function recordUnknownActionReceipt(input: {
	readonly dispatch: GovernedDispatchLineageV3;
	readonly durableRequest: DurableActionRequestV2;
	readonly actionEvidencePort: GovernedActionEvidenceWriter;
	readonly completedAt: string;
	readonly wallTimeMs: number;
	readonly failureCode: string;
	readonly message: string;
}): Promise<void> {
	const request = input.durableRequest.actionRequest;
	try {
		await input.actionEvidencePort.recordActionReceipt({
			schemaVersion: 2,
			runId: request.runId,
			workflowId: request.workflowId,
			unitId: request.unitId,
			attempt: request.attempt,
			provenanceRef: request.provenanceRef,
			actionId: request.actionId,
			idempotencyKey: request.idempotencyKey,
			actionRequestDigest: input.durableRequest.actionRequestDigest,
			dispatchEnvelopeDigest: input.dispatch.envelopeDigest,
			capabilityBundleDigest: input.dispatch.capabilityBundleDigest,
			policyDigest: input.dispatch.policyDigest,
			contextManifestDigest: input.dispatch.contextManifestDigest,
			workerManifestDigest: input.dispatch.workerManifestDigest,
			sandboxProfileDigest: input.dispatch.sandboxProfileDigest,
			authorityActor: input.dispatch.authorityActor,
			executionRole: input.dispatch.executionRole,
			outcome: "unknown",
			evidenceDigest: input.durableRequest.actionRequestDigest,
			evidenceRef: input.durableRequest.actionRequestRef,
			resourceUsage: { wallTimeMs: input.wallTimeMs },
			redactions: [],
			failure: {
				code: input.failureCode,
				messageDigest: sha256Digest(input.message),
				retryable: false,
			},
			completedAt: input.completedAt,
		});
	} catch {
		// The original error remains the causal failure. A later resume/reconciler
		// must treat this write-ahead request as unresolved rather than retrying it.
	}
}

/** A pre-effect authority failure is terminally denied, never ambiguous. */
async function recordDeniedActionReceipt(input: {
	readonly dispatch: GovernedDispatchLineageV3;
	readonly durableRequest: DurableActionRequestV2;
	readonly actionEvidencePort: GovernedActionEvidenceWriter;
	readonly completedAt: string;
	readonly failureCode: string;
	readonly message: string;
}): Promise<void> {
	const request = input.durableRequest.actionRequest;
	const receiptInput: RecordActionReceiptV2Input = {
		schemaVersion: 2,
		runId: request.runId,
		workflowId: request.workflowId,
		unitId: request.unitId,
		attempt: request.attempt,
		provenanceRef: request.provenanceRef,
		actionId: request.actionId,
		idempotencyKey: request.idempotencyKey,
		actionRequestDigest: input.durableRequest.actionRequestDigest,
		dispatchEnvelopeDigest: input.dispatch.envelopeDigest,
		capabilityBundleDigest: input.dispatch.capabilityBundleDigest,
		policyDigest: input.dispatch.policyDigest,
		contextManifestDigest: input.dispatch.contextManifestDigest,
		workerManifestDigest: input.dispatch.workerManifestDigest,
		sandboxProfileDigest: input.dispatch.sandboxProfileDigest,
		authorityActor: input.dispatch.authorityActor,
		executionRole: input.dispatch.executionRole,
		outcome: "denied",
		evidenceDigest: input.durableRequest.actionRequestDigest,
		evidenceRef: input.durableRequest.actionRequestRef,
		resourceUsage: { wallTimeMs: 0 },
		redactions: [],
		failure: {
			code: input.failureCode,
			messageDigest: sha256Digest(input.message),
			retryable: false,
		},
		completedAt: input.completedAt,
	};
	try {
		await input.actionEvidencePort.recordActionReceipt(receiptInput);
	} catch {
		// No OCI effect was attempted, so the original authority failure remains
		// safe and causal. A caller can surface the evidence persistence issue.
	}
}

/**
 * Read only own data properties from the caller's invocation object. This
 * deliberately does not spread, stringify, or otherwise evaluate accessors
 * supplied by a caller or inherited through a prototype.
 */
function readOwnData(
	source: unknown,
	property: string,
	label: string,
	options?: { readonly optional?: boolean },
): unknown {
	if (source === null || typeof source !== "object") {
		throw new TypeError(`${label} must be an object with own data properties.`);
	}
	const descriptor = Object.getOwnPropertyDescriptor(source, property);
	if (descriptor === undefined) {
		if (options?.optional) return undefined;
		throw new TypeError(`${label}.${property} must be an own data property.`);
	}
	if (!("value" in descriptor)) {
		throw new TypeError(`${label}.${property} must not be an accessor.`);
	}
	return descriptor.value;
}

/**
 * Copies recursively from plain own data records only. The resulting graph is
 * deep-frozen before any validation or persistence can yield to another task.
 */
function cloneOwnData<T>(
	value: T,
	label: string,
	state: {
		readonly memo: WeakMap<object, object>;
		readonly active: WeakSet<object>;
	} = { memo: new WeakMap(), active: new WeakSet() },
): T {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "undefined"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError(`${label} must not contain a non-finite number.`);
		}
		return value;
	}
	if (typeof value !== "object") {
		throw new TypeError(`${label} must contain only plain data values.`);
	}

	const source = value as object;
	if (state.active.has(source)) {
		throw new TypeError(`${label} must not contain a cycle.`);
	}
	const memoized = state.memo.get(source);
	if (memoized !== undefined) return memoized as T;

	if (Array.isArray(source)) {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
		if (
			lengthDescriptor === undefined ||
			!("value" in lengthDescriptor) ||
			typeof lengthDescriptor.value !== "number" ||
			!Number.isSafeInteger(lengthDescriptor.value) ||
			lengthDescriptor.value < 0
		) {
			throw new TypeError(`${label} must be a well-formed data array.`);
		}
		const clone: unknown[] = new Array(lengthDescriptor.value);
		state.memo.set(source, clone);
		state.active.add(source);
		try {
			for (const key of Reflect.ownKeys(source)) {
				if (key === "length") continue;
				if (
					typeof key !== "string" ||
					!isDataArrayIndex(key, lengthDescriptor.value)
				) {
					throw new TypeError(
						`${label} must not contain extra array properties.`,
					);
				}
				const descriptor = Object.getOwnPropertyDescriptor(source, key);
				if (!isEnumerableDataDescriptor(descriptor)) {
					throw new TypeError(`${label}.${key} must be enumerable data.`);
				}
				Object.defineProperty(clone, key, {
					value: cloneOwnData(descriptor.value, `${label}.${key}`, state),
					enumerable: true,
					configurable: false,
					writable: false,
				});
			}
			return Object.freeze(clone) as T;
		} finally {
			state.active.delete(source);
		}
	}

	const prototype = Object.getPrototypeOf(source);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain own-data object.`);
	}
	const clone = Object.create(prototype) as Record<string, unknown>;
	state.memo.set(source, clone);
	state.active.add(source);
	try {
		for (const key of Reflect.ownKeys(source)) {
			if (typeof key !== "string") {
				throw new TypeError(`${label} must not contain symbol properties.`);
			}
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (!isEnumerableDataDescriptor(descriptor)) {
				throw new TypeError(`${label}.${key} must be enumerable data.`);
			}
			Object.defineProperty(clone, key, {
				value: cloneOwnData(descriptor.value, `${label}.${key}`, state),
				enumerable: true,
				configurable: false,
				writable: false,
			});
		}
		return Object.freeze(clone) as T;
	} finally {
		state.active.delete(source);
	}
}

function isEnumerableDataDescriptor(
	descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
	return (
		descriptor !== undefined &&
		descriptor.enumerable === true &&
		"value" in descriptor
	);
}

function isDataArrayIndex(value: string, length: number): boolean {
	const index = Number(value);
	return (
		Number.isInteger(index) &&
		index >= 0 &&
		index < length &&
		String(index) === value
	);
}

function captureGovernedCommandInput(
	input: GovernedWorkerExecutionInput,
	actionExecutor: GovernedActionExecutor,
	now: () => string,
	nowMs: () => number,
): Readonly<{
	readonly input: GovernedCommandInputSnapshot;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly deadlineAtMs: number;
}> {
	const snapshot: GovernedCommandInputSnapshot = Object.freeze({
		runId: captureRunId(readOwnData(input, "runId", "governed worker input")),
		packet: captureUnitPacket(
			readOwnData(input, "packet", "governed worker input"),
		),
		projectRoot: captureProjectRoot(
			readOwnData(input, "projectRoot", "governed worker input"),
		),
		signalAborted: captureAbortState(
			readOwnData(input, "signal", "governed worker input"),
		),
		governedDispatch: captureGovernedDispatch(
			readOwnData(input, "governedDispatch", "governed worker input", {
				optional: true,
			}),
		),
		actionEvidencePort: captureActionEvidencePort(
			readOwnData(input, "actionEvidencePort", "governed worker input", {
				optional: true,
			}),
		),
	});
	const dispatch = assertGovernedCommandInput(snapshot, actionExecutor, now);
	const deadlineAtMs = deriveDispatchComputeDeadlineAtMs(dispatch);
	assertDispatchComputeDeadlineUnexpiredAt(deadlineAtMs, nowMs());
	return Object.freeze({ input: snapshot, dispatch, deadlineAtMs });
}

function captureRunId(value: unknown): string {
	if (typeof value !== "string") {
		throw new TypeError("governed worker execution requires a kernel run id.");
	}
	return value;
}

function captureUnitPacket(value: unknown): UnitPacket {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(
			"governed worker execution requires a plain unit packet.",
		);
	}
	return cloneOwnData(value, "packet") as UnitPacket;
}

function captureProjectRoot(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("governed worker execution requires a project root.");
	}
	try {
		return realpathSync(value);
	} catch {
		throw new TypeError(
			"governed worker execution project root must resolve before an action can be authorized.",
		);
	}
}

function captureAbortState(value: unknown): boolean {
	if (!(value instanceof AbortSignal)) {
		throw new TypeError(
			"governed worker execution requires a native AbortSignal.",
		);
	}
	return value.aborted;
}

function captureGovernedDispatch(
	value: unknown,
): GovernedDispatchLineageV3 | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("governed dispatch must be a plain own-data object.");
	}
	return cloneOwnData(value, "governed dispatch") as GovernedDispatchLineageV3;
}

function captureActionEvidencePort(
	value: unknown,
): GovernedActionEvidenceWriter | undefined {
	if (value === undefined) return undefined;
	const recordActionRequested = readOwnData(
		value,
		"recordActionRequested",
		"governed action evidence port",
	);
	const recordActionReceipt = readOwnData(
		value,
		"recordActionReceipt",
		"governed action evidence port",
	);
	if (
		typeof recordActionRequested !== "function" ||
		typeof recordActionReceipt !== "function"
	) {
		throw new TypeError(
			"governed action evidence port must provide own request and receipt writers.",
		);
	}
	const writers: GovernedActionEvidenceWriter = {
		recordActionRequested: (
			recordActionRequested as GovernedActionEvidencePort["recordActionRequested"]
		).bind(value),
		recordActionReceipt: (
			recordActionReceipt as GovernedActionEvidencePort["recordActionReceipt"]
		).bind(value),
	};
	return Object.freeze(writers);
}

function assertGovernedCommandInput(
	input: GovernedCommandInputSnapshot,
	actionExecutor: GovernedActionExecutor,
	now: () => string,
): GovernedDispatchLineageV3 {
	if (typeof input.runId !== "string" || input.runId.trim().length === 0) {
		throw new TypeError("governed worker execution requires a kernel run id.");
	}
	if (input.packet.execution_role !== "implementer") {
		throw new TypeError(
			"only an implementer packet may enter the governed command worker.",
		);
	}
	if (
		input.packet.capability_bundle === undefined ||
		input.packet.capability_bundle_digest === undefined
	) {
		throw new TypeError(
			"governed worker execution requires an admitted capability bundle and digest.",
		);
	}
	const admittedBundleDigest = bundleDigest(input.packet.capability_bundle);
	if (input.packet.capability_bundle_digest !== admittedBundleDigest) {
		throw new TypeError(
			"governed worker capability bundle digest must bind the exact admitted capability bundle.",
		);
	}
	const dispatch = input.governedDispatch;
	if (!dispatch) {
		throw new TypeError(
			"governed command execution requires a verified sealed_v3 dispatch; legacy candidate governance is replay-only and cannot authorize an OCI action.",
		);
	}
	assertNonEmptyGovernanceRecord(
		input.packet.acceptance_contract,
		"packet.acceptance_contract",
	);
	assertNonEmptyGovernanceRecord(
		input.packet.trust_scope,
		"packet.trust_scope",
	);
	if (!input.actionEvidencePort) {
		throw new TypeError(
			"V3 governed command execution requires a durable action evidence port.",
		);
	}
	if (
		dispatch.schemaVersion !== 3 ||
		dispatch.executionRole !== "implementer" ||
		dispatch.commitMode !== "atomic" ||
		dispatch.trustTier !== "governed" ||
		dispatch.actionEvidenceVersion !== "sealed_v3"
	) {
		throw new TypeError(
			"V3 governed command execution requires an implementer, atomic, sealed_v3 activity-claim dispatch.",
		);
	}
	if (
		dispatch.runId !== input.runId ||
		dispatch.unitId !== input.packet.unit.id ||
		dispatch.provenanceRef !== input.packet.provenance_ref ||
		dispatch.capabilityBundleDigest !== input.packet.capability_bundle_digest
	) {
		throw new TypeError(
			"V3 governed dispatch must match the run, packet unit, provenance, and capability authority.",
		);
	}
	if (
		canonicalGovernedUnitPacketV1Digest(input.packet) !==
		dispatch.governedPacketDigest
	) {
		throw new TypeError(
			"V3 governed command execution packet does not match the exact packet digest bound into the signed dispatch.",
		);
	}
	if (dispatch.sandboxProfileDigest !== actionExecutor.sandbox.profileDigest) {
		throw new TypeError(
			"V3 governed dispatch sandbox profile digest must match the OCI executor attestation.",
		);
	}
	for (const value of Object.values({
		envelopeDigest: dispatch.envelopeDigest,
		capabilityBundleDigest: dispatch.capabilityBundleDigest,
		acceptanceContractDigest: dispatch.acceptanceContractDigest,
		policyDigest: dispatch.policyDigest,
		contextManifestDigest: dispatch.contextManifestDigest,
		workerManifestDigest: dispatch.workerManifestDigest,
		sandboxProfileDigest: dispatch.sandboxProfileDigest,
		repositoryBindingDigest: dispatch.repositoryBindingDigest,
		ledgerAuthorityRealmDigest: dispatch.ledgerAuthorityRealmDigest,
		governedPacketDigest: dispatch.governedPacketDigest,
	})) {
		canonicalSha256Digest(value);
	}
	const issuedAt = Date.parse(dispatch.issuedAt);
	const expiresAt = Date.parse(dispatch.expiresAt);
	if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
		throw new TypeError(
			"V3 governed command execution requires parseable dispatch and current timestamps.",
		);
	}
	if (issuedAt >= expiresAt) {
		throw new TypeError(
			"V3 governed command execution requires expiresAt later than issuedAt.",
		);
	}
	assertV3DispatchUnexpiredAt(dispatch, now());
	return dispatch;
}

function assertV3DispatchUnexpiredAt(
	dispatch: GovernedDispatchLineageV3,
	observedAt: string,
): void {
	const currentTime = Date.parse(observedAt);
	if (!Number.isFinite(currentTime)) {
		throw new TypeError(
			"V3 governed command execution requires a parseable current timestamp.",
		);
	}
	if (Date.parse(dispatch.expiresAt) <= currentTime) {
		throw new TypeError(
			"V3 governed command dispatch is expired and cannot authorize an OCI action.",
		);
	}
}

/**
 * A V3 dispatch may have a broad envelope expiry and a stricter signed compute
 * budget. Derive one absolute deadline from its immutable issue timestamp so
 * retries and multiple actions never receive a fresh per-action allowance.
 * Older envelopes without maxComputeTimeMs remain bounded by expiresAt.
 */
function deriveDispatchComputeDeadlineAtMs(
	dispatch: GovernedDispatchLineageV3,
): number {
	const issuedAtMs = parseDispatchEpochMs(dispatch.issuedAt, "issuedAt");
	const expiresAtMs = parseDispatchEpochMs(dispatch.expiresAt, "expiresAt");
	if (issuedAtMs >= expiresAtMs) {
		throw new TypeError(
			"V3 governed command execution requires expiresAt later than issuedAt.",
		);
	}
	const budget = readClosedDispatchBudget(dispatch.budget);
	if (budget.maxComputeTimeMs === undefined) return expiresAtMs;
	if (budget.maxComputeTimeMs > MAX_ECMASCRIPT_EPOCH_MS - issuedAtMs) {
		throw new RangeError(
			"V3 governed dispatch maxComputeTimeMs overflows the absolute compute deadline.",
		);
	}
	const computeDeadlineAtMs = issuedAtMs + budget.maxComputeTimeMs;
	if (
		!Number.isSafeInteger(computeDeadlineAtMs) ||
		computeDeadlineAtMs <= issuedAtMs ||
		computeDeadlineAtMs > MAX_ECMASCRIPT_EPOCH_MS
	) {
		throw new RangeError(
			"V3 governed dispatch maxComputeTimeMs produces an invalid absolute compute deadline.",
		);
	}
	return Math.min(expiresAtMs, computeDeadlineAtMs);
}

function parseDispatchEpochMs(
	value: unknown,
	field: "issuedAt" | "expiresAt",
): number {
	if (typeof value !== "string") {
		throw new TypeError(
			`V3 governed command execution requires a parseable dispatch ${field} timestamp.`,
		);
	}
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < 0 ||
		parsed > MAX_ECMASCRIPT_EPOCH_MS
	) {
		throw new TypeError(
			`V3 governed command execution requires a parseable dispatch ${field} timestamp.`,
		);
	}
	return parsed;
}

function readClosedDispatchBudget(input: unknown): Readonly<{
	readonly maxTokens?: number;
	readonly maxComputeTimeMs?: number;
}> {
	if (
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		(Object.getPrototypeOf(input) !== Object.prototype &&
			Object.getPrototypeOf(input) !== null)
	) {
		throw new TypeError(
			"V3 governed dispatch budget must be a closed plain data object.",
		);
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string" || !DISPATCH_BUDGET_FIELDS.has(key)) {
			throw new TypeError(
				"V3 governed dispatch budget must use the closed V1 schema.",
			);
		}
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(
				"V3 governed dispatch budget cannot contain accessor fields.",
			);
		}
	}
	const record = input as Record<string, unknown>;
	const maxTokens = readOptionalPositiveBudgetInteger(
		record.maxTokens,
		"maxTokens",
	);
	const maxComputeTimeMs = readOptionalPositiveBudgetInteger(
		record.maxComputeTimeMs,
		"maxComputeTimeMs",
	);
	return Object.freeze({
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(maxComputeTimeMs === undefined ? {} : { maxComputeTimeMs }),
	});
}

function readOptionalPositiveBudgetInteger(
	value: unknown,
	field: "maxTokens" | "maxComputeTimeMs",
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(
			`V3 governed dispatch budget ${field} must be a positive safe integer when provided.`,
		);
	}
	return value;
}

function assertDispatchComputeDeadlineUnexpiredAt(
	deadlineAtMs: number,
	observedAtMs: unknown,
): void {
	if (
		!Number.isSafeInteger(deadlineAtMs) ||
		deadlineAtMs <= 0 ||
		deadlineAtMs > MAX_ECMASCRIPT_EPOCH_MS
	) {
		throw new TypeError(
			"V3 governed dispatch compute deadline is invalid and cannot authorize an OCI action.",
		);
	}
	if (!Number.isSafeInteger(observedAtMs)) {
		throw new TypeError(
			"V3 governed command execution requires a valid current epoch-millisecond timestamp.",
		);
	}
	const currentTimeMs = observedAtMs as number;
	if (currentTimeMs < 0) {
		throw new TypeError(
			"V3 governed command execution requires a valid current epoch-millisecond timestamp.",
		);
	}
	if (currentTimeMs >= deadlineAtMs) {
		throw new TypeError(
			"V3 governed dispatch compute deadline is exhausted and cannot authorize an OCI action.",
		);
	}
}

function requireGrantedActivityClaim(
	disposition: GovernedActivityClaimDispositionV1,
	activityId: string,
	idempotencyKey: string,
): GrantedGovernedActivityClaimV1 {
	if (!disposition || typeof disposition !== "object") {
		throw new TypeError(
			"governed activity claim authority returned an invalid disposition.",
		);
	}
	if (disposition.state !== "granted") {
		switch (disposition.state) {
			case "pending":
				throw new Error(
					"governed activity claim is pending; another attempt may own the effect and this worker must reconcile instead of executing it.",
				);
			case "recorded":
				throw new Error(
					"governed activity already has a terminal native result; this worker must recover it instead of executing the effect again.",
				);
			case "lease_expired":
				throw new Error(
					"governed activity claim lease expired before this worker could execute; reconciliation is required.",
				);
			case "rejected":
				throw new Error(
					`governed activity claim was rejected (${requireEvidenceReference(disposition.code, "activity claim rejection code")}).`,
				);
			default:
				throw new TypeError(
					"governed activity claim authority returned an unknown disposition.",
				);
		}
	}
	return {
		state: "granted",
		activityId: requireEvidenceReference(activityId, "activity id"),
		idempotencyKey: requireEvidenceReference(
			idempotencyKey,
			"activity idempotency key",
		),
		claimEventId: requireEvidenceReference(
			disposition.claimEventId,
			"activity claim event",
		),
		claimEventDigest: canonicalSha256Digest(disposition.claimEventDigest),
		leaseId: requireEvidenceReference(disposition.leaseId, "activity lease"),
		leaseExpiresAt: requireRfc3339Timestamp(
			disposition.leaseExpiresAt,
			"activity lease expiry",
		),
	};
}

function assertActivityClaimUnexpiredAt(
	claim: GrantedGovernedActivityClaimV1,
	observedAt: string,
): void {
	const now = Date.parse(
		requireRfc3339Timestamp(observedAt, "current timestamp"),
	);
	const expiresAt = Date.parse(claim.leaseExpiresAt);
	if (expiresAt <= now) {
		throw new Error(
			"governed activity claim lease is expired and cannot authorize an OCI action.",
		);
	}
}

function assertRecordedActivityResult(
	disposition: GovernedActivityResultDispositionV1,
	expectedOutcome: GovernedActivityResultOutcomeV1,
): void {
	if (!disposition || typeof disposition !== "object") {
		throw new TypeError(
			"governed activity authority returned an invalid terminal-result disposition.",
		);
	}
	if (disposition.state === "lease_expired") {
		throw new Error(
			"governed activity lease expired before its terminal result could be recorded.",
		);
	}
	if (disposition.state === "rejected") {
		throw new Error(
			`governed activity terminal result was rejected (${requireEvidenceReference(disposition.code, "activity result rejection code")}).`,
		);
	}
	if (disposition.state !== "recorded") {
		throw new TypeError(
			"governed activity authority returned an unknown terminal-result disposition.",
		);
	}
	if (disposition.resultOutcome !== expectedOutcome) {
		throw new Error(
			"governed activity terminal result conflicts with the effect outcome and requires reconciliation.",
		);
	}
	requireEvidenceReference(disposition.resultEventId, "activity result event");
	canonicalSha256Digest(disposition.resultEventDigest);
}

function requireRfc3339Timestamp(value: string, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new TypeError(`${label} must be a parseable RFC3339 timestamp.`);
	}
	return value;
}

function assertNonEmptyGovernanceRecord(value: unknown, label: string): void {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length === 0
	) {
		throw new TypeError(
			`${label} must be a non-empty object for V3 governed command execution.`,
		);
	}
}

function resultForDispatch(
	_dispatch: GovernedDispatchLineageV3,
	executionReceipt: ExecutionReceipt,
): GovernedWorkerExecutionResultV3 {
	return { executionReceipt, actionReceipts: [] };
}

function executionReceiptFromGateway(input: {
	readonly execution: NonNullable<UnitPacket["execution"]>;
	readonly projectRoot: string;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly gatewayReceipt: ActionGatewayReceipt;
	readonly outputChecks: readonly {
		readonly path: string;
		readonly exists: boolean;
	}[];
}): ExecutionReceipt {
	return {
		command: input.execution.command,
		args: [...(input.execution.args ?? [])],
		cwd: input.execution.cwd
			? resolve(input.projectRoot, input.execution.cwd)
			: resolve(input.projectRoot),
		startedAt: input.startedAt,
		completedAt: input.completedAt,
		exitCode:
			input.gatewayReceipt.exitCode ??
			(input.gatewayReceipt.outcome === "succeeded" ? 0 : 1),
		stdout: "",
		stderr:
			input.gatewayReceipt.outcome === "succeeded"
				? ""
				: (input.gatewayReceipt.reason ?? "governed action failed"),
		outputChecks: [...input.outputChecks],
	};
}

function assertPersistedInput(
	input: Awaited<
		ReturnType<GovernedCommandEvidenceStore["persistCanonicalInput"]>
	>,
): void {
	canonicalSha256Digest(input.canonicalInputDigest);
	requireEvidenceReference(input.canonicalInputRef, "canonical input");
}

function assertPersistedResult(
	input: Awaited<
		ReturnType<GovernedCommandEvidenceStore["persistActionResult"]>
	>,
	outcome: ActionGatewayReceipt["outcome"],
): void {
	canonicalSha256Digest(input.evidenceDigest);
	requireEvidenceReference(input.evidenceRef, "action evidence");
	if (outcome === "succeeded") {
		if (input.resultDigest === undefined || input.resultRef === undefined) {
			throw new TypeError(
				"successful governed command actions require a durable result digest and reference.",
			);
		}
		canonicalSha256Digest(input.resultDigest);
		requireEvidenceReference(input.resultRef, "action result");
	}
}

function requireSuccessfulPersistedResult(
	input: Awaited<
		ReturnType<GovernedCommandEvidenceStore["persistActionResult"]>
	>,
): { readonly resultDigest: string; readonly resultRef: string } {
	if (input.resultDigest === undefined || input.resultRef === undefined) {
		throw new TypeError(
			"successful governed command actions require a durable result digest and reference.",
		);
	}
	return { resultDigest: input.resultDigest, resultRef: input.resultRef };
}

function toSuccessfulResultFields(
	input: Awaited<
		ReturnType<GovernedCommandEvidenceStore["persistActionResult"]>
	>,
): { readonly resultDigest: string; readonly resultRef: string } {
	const result = requireSuccessfulPersistedResult(input);
	return {
		resultDigest: canonicalSha256Digest(result.resultDigest),
		resultRef: requireEvidenceReference(result.resultRef, "action result"),
	};
}

function assertDurableRequest(
	expected: ActionRequestedV2,
	actual: DurableActionRequestV2,
): void {
	if (
		canonicalActionRequestedV2Digest(actual.actionRequest) !==
			canonicalActionRequestedV2Digest(expected) ||
		actual.actionRequestDigest !== canonicalActionRequestedV2Digest(expected)
	) {
		throw new TypeError(
			"durable action request does not bind the exact V3 command action intent.",
		);
	}
	requireEvidenceReference(actual.actionRequestRef, "action request");
}

function assertDurableReceipt(
	expected: Omit<ActionReceiptRecordedV2, "actionReceiptRef">,
	actual: {
		readonly receipt: ActionReceiptRecordedV2;
		readonly actionReceiptDigest: string;
	},
): void {
	const expectedReceipt = {
		...expected,
		actionReceiptRef: actual.receipt.actionReceiptRef,
	};
	if (
		canonicalActionReceiptRecordedV2Digest(actual.receipt) !==
			canonicalActionReceiptRecordedV2Digest(expectedReceipt) ||
		actual.actionReceiptDigest !==
			canonicalActionReceiptRecordedV2Digest(expectedReceipt)
	) {
		throw new TypeError(
			"durable action receipt does not bind the exact V3 command action result.",
		);
	}
	requireEvidenceReference(actual.receipt.actionReceiptRef, "action receipt");
}

function mergeRedactions(
	...sources: readonly (readonly ActionRedactionV2[])[]
): readonly ActionRedactionV2[] {
	const redactions = sources.flat();
	return redactions.map((redaction) => ({
		field: redaction.field,
		reason: redaction.reason,
		...(redaction.redactedDigest === undefined
			? {}
			: { redactedDigest: canonicalSha256Digest(redaction.redactedDigest) }),
	}));
}

function elapsedMilliseconds(startedAt: number, completedAt: number): number {
	return Math.max(0, completedAt - startedAt);
}

function requireEvidenceReference(value: string, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} reference must be non-empty.`);
	}
	return value;
}

function sha256Digest(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function governedActionId(runId: string, envelopeDigest: string): string {
	return `governed:${runId}:${envelopeDigest.slice("sha256:".length)}`;
}

function blockedReceipt(
	packet: UnitPacket,
	projectRoot: string,
	now: () => string,
	reason: string,
): ExecutionReceipt {
	const execution = packet.execution;
	const timestamp = now();
	return {
		command: execution?.command ?? "governed-worker",
		args: [...(execution?.args ?? [])],
		cwd: resolve(projectRoot),
		startedAt: timestamp,
		completedAt: timestamp,
		exitCode: 1,
		stdout: "",
		stderr: reason,
		outputChecks: [],
	};
}

/** Existing segments are checked individually to deny symlink escapes. */
function assertWorkspaceRelativePath(
	workspaceRoot: string,
	value: string | undefined,
	label: string,
	options?: { readonly allowWorkspaceRoot?: boolean },
): string {
	const root = realpathSync(workspaceRoot);
	if (value === undefined) return root;
	if (isAbsolute(value)) throw new TypeError(`${label} must not be absolute.`);
	const normalized = normalize(value);
	const resolved = resolve(root, normalized);
	assertContained(root, resolved, label);
	if (resolved === root && options?.allowWorkspaceRoot !== true) {
		throw new TypeError(`${label} must not be the workspace root.`);
	}

	let current = root;
	for (const segment of normalized.split(/[\\/]+/).filter(Boolean)) {
		current = resolve(current, segment);
		if (!existsSync(current)) break;
		if (lstatSync(current).isSymbolicLink()) {
			throw new TypeError(`${label} traverses a symbolic link.`);
		}
		assertContained(root, realpathSync(current), label);
	}
	return resolved;
}

function assertContained(root: string, candidate: string, label: string): void {
	const relativePath = relative(root, candidate);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		throw new TypeError(`${label} is outside the workspace root.`);
	}
}

/**
 * Re-validate a required output after the worker action. Unlike the
 * preflight check this observes filesystem mutations performed by the worker
 * and treats a symlink (including one pointing back into the worktree) as an
 * invalid output. A candidate must contain concrete artifacts, not a handle
 * to another part of the filesystem.
 */
function hasSafeRequiredOutput(
	workspaceRoot: string,
	outputPath: string,
): boolean {
	try {
		const resolved = assertWorkspaceRelativePath(
			workspaceRoot,
			outputPath,
			"required output",
		);
		if (!existsSync(resolved)) return false;
		if (lstatSync(resolved).isSymbolicLink()) return false;
		const root = realpathSync(workspaceRoot);
		assertContained(root, realpathSync(resolved), "required output");
		return true;
	} catch {
		return false;
	}
}
