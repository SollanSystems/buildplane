import { createHash } from "node:crypto";
import {
	type CapabilityBundleV0,
	evaluateToolInvocation,
	validateCapabilityBundle,
} from "@buildplane/capability-broker";
import { isTrustedGovernedActionExecutor } from "./governed-executor-provenance.js";
import {
	type RunCommandInput,
	type RunCommandResult,
	runCommand,
} from "./run-command.js";
import {
	type WriteFileInput,
	type WriteFileResult,
	writeFile,
} from "./write-file.js";

/**
 * Capability authorization is not enough if a public governed executor can be
 * called directly with a structurally similar context. Contexts in this set
 * are created only after ActionGateway has validated the run, role, bundle,
 * and sandbox boundary. Consumers may ask whether a context is minted, but
 * there is deliberately no exported way to add one.
 */
const gatewayMintedGovernedContexts = new WeakSet<object>();
const MAX_ECMASCRIPT_EPOCH_MS = 8_640_000_000_000_000;
const ACTION_GATEWAY_ROLES = [
	"implementer",
	"reviewer",
	"adversary",
	"judge",
	"candidate",
] as const;
const ACTION_GATEWAY_TRUST_TIERS = ["raw", "governed"] as const;
const RESERVED_GATEWAY_ACTION_FAMILIES = [
	"git",
	"model",
	"network",
	"secret",
	"mcp",
	"a2a",
	"external_service",
] as const;
const ACTION_FAMILY_UNAVAILABLE_REASON =
	"ACTION_FAMILY_UNAVAILABLE: reserved action family has no ActionGateway implementation";

/** Roles accepted by the signed trust-spine contract. */
export type ActionGatewayRole =
	| "implementer"
	| "reviewer"
	| "adversary"
	| "judge"
	| "candidate";

export type ActionGatewayTrustTier = "raw" | "governed";

type ReservedGatewayActionKind =
	(typeof RESERVED_GATEWAY_ACTION_FAMILIES)[number];

export type GatewayAction =
	| {
			readonly actionId: string;
			readonly kind: "process.run";
			readonly command: string;
			readonly args?: readonly string[];
			readonly cwd?: string;
	  }
	| {
			readonly actionId: string;
			readonly kind: "filesystem.write";
			readonly path: string;
			readonly content: string;
	  }
	| {
			readonly actionId: string;
			readonly kind: ReservedGatewayActionKind;
	  };

type ExecutableGatewayAction = Extract<
	GatewayAction,
	{ readonly kind: "process.run" | "filesystem.write" }
>;
type ReservedGatewayAction = Extract<
	GatewayAction,
	{ readonly kind: ReservedGatewayActionKind }
>;

export interface ActionGatewayReceipt {
	readonly actionId: string;
	readonly kind: GatewayAction["kind"] | "unknown";
	readonly runId: string;
	readonly role: ActionGatewayRole;
	readonly trustTier: ActionGatewayTrustTier;
	readonly outcome: "succeeded" | "failed" | "denied";
	readonly inputDigest: string;
	readonly resultDigest: string;
	readonly reason?: string;
	readonly exitCode?: number;
}

export interface GatewayTools {
	runCommand(input: RunCommandInput): RunCommandResult;
	writeFile(input: WriteFileInput): WriteFileResult;
}

/**
 * The immutable authority context passed to the future OCI action executor.
 *
 * The executor receives the same validated capability bundle that admitted the
 * gateway rather than a worker-controlled approximation of it. It is a
 * deliberately separate interface from {@link GatewayTools}: the latter is a
 * local host-tool implementation and must never be selected for governed
 * work.
 */
export interface GovernedActionExecutionContext {
	readonly runId: string;
	readonly worktreeRoot: string;
	readonly role: ActionGatewayRole;
	readonly capabilityBundle: CapabilityBundleV0;
	/**
	 * Immutable absolute deadline derived by the verified dispatch authority.
	 * This is intentionally not a per-action allowance: retries and multiple
	 * effects consume one shared signed compute-time window.
	 */
	readonly deadlineAtMs: number;
	/**
	 * Captured once by the gateway so an executor can re-check the same deadline
	 * immediately before its control-plane effect. It is not worker-provided
	 * action input.
	 */
	readonly nowMs: () => number;
}

/**
 * Runtime proof for concrete governed executors. A plain object satisfying the
 * TypeScript interface is not authority: only ActionGateway can mint an entry
 * in this module-private set. This function intentionally exposes a predicate,
 * not a setter or token, so an in-process caller cannot forge the proof.
 */
export function isActionGatewayMintedExecutionContext(
	context: unknown,
): context is GovernedActionExecutionContext {
	return (
		typeof context === "object" &&
		context !== null &&
		gatewayMintedGovernedContexts.has(context)
	);
}

/**
 * Closed declaration required from a sandbox integration before the gateway
 * may dispatch a governed effect. This records the isolation contract which
 * the executor is responsible for enforcing; it is not an OCI implementation
 * and does not make the host tools safe by itself.
 */
export interface GovernedSandboxAttestationV1 {
	readonly schemaVersion: 1;
	readonly runtime: "rootless-oci";
	readonly rootless: true;
	readonly readOnlyBase: true;
	readonly writableOverlay: true;
	readonly network: "none";
	readonly hostFallback: false;
	readonly profileDigest: string;
}

/**
 * Explicit seam for the future bounded OCI action plane.
 *
 * `createActionGateway` never constructs this executor and never adapts
 * `GatewayTools` into one. Until an OCI integration supplies this contract,
 * governed actions fail closed rather than falling through to the host shell
 * or host filesystem.
 */
export interface GovernedActionExecutor {
	readonly sandbox: GovernedSandboxAttestationV1;
	runCommand(
		input: RunCommandInput,
		context: GovernedActionExecutionContext,
	): RunCommandResult;
	writeFile(
		input: WriteFileInput,
		context: GovernedActionExecutionContext,
	): WriteFileResult;
}

export interface CreateActionGatewayOptions {
	readonly runId: string;
	readonly worktreeRoot: string;
	readonly role: ActionGatewayRole;
	readonly trustTier: ActionGatewayTrustTier;
	/** Required for every governed action; never inferred from a worker prompt. */
	readonly capabilityBundle?: CapabilityBundleV0;
	/** Observational only. A telemetry failure can never change an authorization result. */
	readonly onReceipt?: (receipt: ActionGatewayReceipt) => void;
	/**
	 * Raw-lane test/integration seam. Governed gateways deliberately ignore it
	 * so a caller cannot accidentally select the default host shell or
	 * filesystem after setting `trustTier: "governed"`.
	 */
	readonly tools?: GatewayTools;
	/**
	 * Mandatory for an implementer/candidate governed action. It must be
	 * created by the internal rootless-OCI factory; a structural callback or
	 * caller-supplied attestation is rejected before it can observe an action.
	 */
	readonly governedExecutor?: GovernedActionExecutor;
	/**
	 * Absolute epoch-millisecond deadline derived from a verified signed
	 * dispatch. A governed executor without this deadline is denied before it
	 * receives an action; raw execution never reads this field.
	 */
	readonly governedDeadlineAtMs?: number;
	/**
	 * Captured wall clock for the governed deadline. Production uses Date.now;
	 * the injectable seam exists solely for deterministic host-side tests.
	 */
	readonly governedNowMs?: () => number;
}

/**
 * Immutable per-run boundary for local process and filesystem effects.
 *
 * It intentionally has no ambient shell object, mutable global executor slot,
 * or fallback path. A governed gateway requires a capability bundle and an
 * explicitly supplied rootless-OCI executor; it never falls back to the
 * default host tools. Implementer/candidate roles may perform the bounded
 * mutation actions their capability bundle allows. Reviewer, adversary, and
 * judge roles may run only bounded read-only verification processes.
 */
export interface ActionGateway {
	readonly runId: string;
	readonly role: ActionGatewayRole;
	readonly trustTier: ActionGatewayTrustTier;
	execute(action: GatewayAction): ActionGatewayReceipt;
}

export function createActionGateway(
	options: CreateActionGatewayOptions,
): ActionGateway {
	const trustTier = normalizeActionGatewayTrustTier(options.trustTier);
	const role = normalizeActionGatewayRole(options.role);
	const capabilityBundle =
		options.capabilityBundle === undefined
			? undefined
			: cloneImmutableCapabilityBundle(options.capabilityBundle);
	const governedExecutor =
		trustTier === "governed" && options.governedExecutor !== undefined
			? normalizeGovernedExecutor(options.governedExecutor)
			: undefined;
	const governedDeadlineAtMs =
		trustTier === "governed"
			? normalizeGovernedDeadlineAtMs(options.governedDeadlineAtMs)
			: undefined;
	const governedNowMs =
		trustTier === "governed"
			? captureGovernedNowMs(options.governedNowMs)
			: undefined;
	const context = Object.freeze({
		runId: requireNonEmpty(options.runId, "runId"),
		worktreeRoot: requireNonEmpty(options.worktreeRoot, "worktreeRoot"),
		role,
		trustTier,
		capabilityBundle,
		governedExecutor,
		governedDeadlineAtMs,
		governedNowMs,
	});
	// Host tools are intentionally constructed only for the raw lane. Keeping
	// this branch outside the governed path prevents a future refactor from
	// accidentally routing a governed action through runCommand/writeFile.
	const rawTools =
		context.trustTier === "raw"
			? (options.tools ?? createGatewayTools(context))
			: undefined;

	const gateway: ActionGateway = {
		runId: context.runId,
		role: context.role,
		trustTier: context.trustTier,
		execute(action) {
			const parsed = parseGatewayAction(action);
			if (!parsed.ok) {
				const receipt: ActionGatewayReceipt = {
					actionId: parsed.actionId,
					kind: parsed.kind,
					runId: context.runId,
					role: context.role,
					trustTier: context.trustTier,
					outcome: "denied",
					inputDigest: digest({ invalid: true, reason: parsed.reason }),
					resultDigest: digest({ outcome: "denied", reason: parsed.reason }),
					reason: parsed.reason,
				};
				return isReservedGatewayActionKind(parsed.kind)
					? freezeReceipt(receipt)
					: emitReceipt(options.onReceipt, receipt);
			}
			const normalizedAction = parsed.action;
			if (isReservedGatewayAction(normalizedAction)) {
				return unavailableReservedActionReceipt(context, normalizedAction);
			}
			const inputDigest = digest(normalizedAction);
			const denial = authorizationDenial(context, normalizedAction);
			if (denial) {
				return emitReceipt(options.onReceipt, {
					actionId: normalizedAction.actionId,
					kind: normalizedAction.kind,
					runId: context.runId,
					role: context.role,
					trustTier: context.trustTier,
					outcome: "denied",
					inputDigest,
					resultDigest: digest({ outcome: "denied", reason: denial }),
					reason: denial,
				});
			}

			if (normalizedAction.kind === "process.run") {
				const input: RunCommandInput = {
					command: normalizedAction.command,
					...(normalizedAction.args === undefined
						? {}
						: { args: normalizedAction.args }),
					...(normalizedAction.cwd === undefined
						? {}
						: { cwd: normalizedAction.cwd }),
				};
				let result: RunCommandResult;
				if (context.trustTier === "governed") {
					const executor = context.governedExecutor;
					if (executor === undefined) {
						return deniedMissingExecutorReceipt(
							options.onReceipt,
							context,
							normalizedAction,
							inputDigest,
						);
					}
					result = executor.runCommand(
						input,
						governedExecutionContext(context),
					);
				} else {
					// Constructed above whenever the raw lane is selected.
					if (rawTools === undefined) {
						throw new Error("ActionGateway raw tool registry is unavailable.");
					}
					result = rawTools.runCommand(input);
				}
				const brokerDenied = isBrokerDenied(result.error);
				const outcome = brokerDenied
					? "denied"
					: result.success
						? "succeeded"
						: "failed";
				return emitReceipt(options.onReceipt, {
					actionId: normalizedAction.actionId,
					kind: normalizedAction.kind,
					runId: context.runId,
					role: context.role,
					trustTier: context.trustTier,
					outcome,
					inputDigest,
					resultDigest: digest(result),
					...(result.error === undefined ? {} : { reason: result.error }),
					exitCode: result.exitCode,
				});
			}

			const input: WriteFileInput = {
				path: normalizedAction.path,
				content: normalizedAction.content,
			};
			let result: WriteFileResult;
			if (context.trustTier === "governed") {
				const executor = context.governedExecutor;
				if (executor === undefined) {
					return deniedMissingExecutorReceipt(
						options.onReceipt,
						context,
						normalizedAction,
						inputDigest,
					);
				}
				result = executor.writeFile(input, governedExecutionContext(context));
			} else {
				// Constructed above whenever the raw lane is selected.
				if (rawTools === undefined) {
					throw new Error("ActionGateway raw tool registry is unavailable.");
				}
				result = rawTools.writeFile(input);
			}
			const brokerDenied = isBrokerDenied(result.error);
			const outcome = brokerDenied
				? "denied"
				: result.success
					? "succeeded"
					: "failed";
			return emitReceipt(options.onReceipt, {
				actionId: normalizedAction.actionId,
				kind: normalizedAction.kind,
				runId: context.runId,
				role: context.role,
				trustTier: context.trustTier,
				outcome,
				inputDigest,
				resultDigest: digest(result),
				...(result.error === undefined ? {} : { reason: result.error }),
			});
		},
	};

	return Object.freeze(gateway);
}

function createGatewayTools(context: {
	readonly worktreeRoot: string;
	readonly capabilityBundle?: CapabilityBundleV0;
}): GatewayTools {
	const capabilityOptions = context.capabilityBundle
		? { capabilityBundle: context.capabilityBundle }
		: undefined;
	return {
		runCommand: (input) =>
			runCommand(input, context.worktreeRoot, capabilityOptions),
		writeFile: (input) =>
			writeFile(input, context.worktreeRoot, capabilityOptions),
	};
}

function unavailableReservedActionReceipt(
	context: {
		readonly runId: string;
		readonly role: ActionGatewayRole;
		readonly trustTier: ActionGatewayTrustTier;
	},
	action: ReservedGatewayAction,
): ActionGatewayReceipt {
	const reason = ACTION_FAMILY_UNAVAILABLE_REASON;
	// Reserved families are deliberately outside the executable action plane.
	// Do not notify receipt observers here: they are telemetry-only callbacks,
	// and unavailable actions must decide before any telemetry-dependent code.
	return freezeReceipt({
		actionId: action.actionId,
		kind: action.kind,
		runId: context.runId,
		role: context.role,
		trustTier: context.trustTier,
		outcome: "denied",
		inputDigest: digest(action),
		resultDigest: digest({ outcome: "denied", reason }),
		reason,
	});
}

function authorizationDenial(
	context: {
		readonly worktreeRoot: string;
		readonly role: ActionGatewayRole;
		readonly trustTier: ActionGatewayTrustTier;
		readonly capabilityBundle?: CapabilityBundleV0;
		readonly governedExecutor?: GovernedActionExecutor;
		readonly governedDeadlineAtMs?: number;
		readonly governedNowMs?: () => number;
	},
	action: ExecutableGatewayAction,
): string | undefined {
	if (typeof action.actionId !== "string" || action.actionId.length === 0) {
		return "actionId is required";
	}
	if (
		context.trustTier === "governed" &&
		context.capabilityBundle === undefined
	) {
		return "governed actions require a capability bundle";
	}
	// Reviewer-class roles may observe a candidate through a bounded process,
	// but they never receive a mutable action. Deny before broker/executor
	// dispatch so a broad fsWrite bundle cannot become an incidental write path.
	if (
		context.trustTier === "governed" &&
		isReadOnlyEvaluatorRole(context.role) &&
		action.kind !== "process.run"
	) {
		return `${context.role} is not permitted to perform ${action.kind}`;
	}
	// The gateway, rather than a caller-provided sandbox executor, is the
	// authority boundary. A governed executor must not be able to weaken a
	// capability bundle by simply omitting its own broker check. Raw tools retain
	// their existing local checks; governed actions are evaluated here before any
	// executor method can observe the request.
	if (
		context.trustTier === "governed" &&
		context.capabilityBundle !== undefined
	) {
		const decision = evaluateToolInvocation(
			context.capabilityBundle,
			action.kind === "process.run"
				? {
						tool: "run_command",
						command: action.command,
						...(action.args === undefined ? {} : { args: action.args }),
					}
				: { tool: "write_file", path: action.path },
			{ worktreeRoot: context.worktreeRoot },
		);
		if (decision.decision === "deny") {
			return `capability broker: ${decision.reason}`;
		}
	}
	if (
		context.trustTier === "governed" &&
		context.governedExecutor === undefined
	) {
		return "governed actions require an attested rootless OCI sandbox executor; host tool fallback is disabled";
	}
	if (context.trustTier === "governed") {
		if (
			context.governedDeadlineAtMs === undefined ||
			context.governedNowMs === undefined
		) {
			return "governed actions require a signed absolute compute deadline before an OCI action can be authorized";
		}
		const currentTime = readGovernedNowMs(context.governedNowMs);
		if (currentTime === undefined) {
			return "governed action clock returned an invalid epoch-millisecond timestamp";
		}
		if (currentTime >= context.governedDeadlineAtMs) {
			return "governed dispatch compute deadline is exhausted and cannot authorize an OCI action";
		}
	}
	return undefined;
}

function governedExecutionContext(context: {
	readonly runId: string;
	readonly worktreeRoot: string;
	readonly role: ActionGatewayRole;
	readonly trustTier: ActionGatewayTrustTier;
	readonly capabilityBundle?: CapabilityBundleV0;
	readonly governedExecutor?: GovernedActionExecutor;
	readonly governedDeadlineAtMs?: number;
	readonly governedNowMs?: () => number;
}): GovernedActionExecutionContext {
	if (
		context.trustTier !== "governed" ||
		context.capabilityBundle === undefined ||
		context.governedExecutor === undefined ||
		context.governedDeadlineAtMs === undefined ||
		context.governedNowMs === undefined
	) {
		throw new Error(
			"ActionGateway invariant violated: governed executor was selected without governed authority.",
		);
	}
	const minted = Object.freeze({
		runId: context.runId,
		worktreeRoot: context.worktreeRoot,
		role: context.role,
		capabilityBundle: context.capabilityBundle,
		deadlineAtMs: context.governedDeadlineAtMs,
		nowMs: context.governedNowMs,
	});
	gatewayMintedGovernedContexts.add(minted);
	return minted;
}

function normalizeActionGatewayRole(value: unknown): ActionGatewayRole {
	if (
		typeof value !== "string" ||
		!ACTION_GATEWAY_ROLES.includes(value as ActionGatewayRole)
	) {
		throw new TypeError(
			"ActionGateway role must be one of implementer, reviewer, adversary, judge, candidate.",
		);
	}
	return value as ActionGatewayRole;
}

function normalizeActionGatewayTrustTier(
	value: unknown,
): ActionGatewayTrustTier {
	if (
		typeof value !== "string" ||
		!ACTION_GATEWAY_TRUST_TIERS.includes(value as ActionGatewayTrustTier)
	) {
		throw new TypeError(
			"ActionGateway trustTier must be one of raw, governed.",
		);
	}
	return value as ActionGatewayTrustTier;
}

function isReadOnlyEvaluatorRole(
	role: ActionGatewayRole,
): role is Extract<ActionGatewayRole, "reviewer" | "adversary" | "judge"> {
	return role === "reviewer" || role === "adversary" || role === "judge";
}

function normalizeGovernedDeadlineAtMs(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > MAX_ECMASCRIPT_EPOCH_MS
	) {
		throw new TypeError(
			"ActionGateway governedDeadlineAtMs must be a positive safe epoch-millisecond timestamp within the ECMAScript date range.",
		);
	}
	return value;
}

function captureGovernedNowMs(
	value: CreateActionGatewayOptions["governedNowMs"],
): () => number {
	if (value === undefined) return Date.now;
	if (typeof value !== "function") {
		throw new TypeError("ActionGateway governedNowMs must be a function.");
	}
	return value.bind(undefined);
}

function readGovernedNowMs(clock: () => number): number | undefined {
	try {
		const value = clock();
		return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function deniedMissingExecutorReceipt(
	onReceipt: CreateActionGatewayOptions["onReceipt"],
	context: {
		readonly runId: string;
		readonly role: ActionGatewayRole;
		readonly trustTier: ActionGatewayTrustTier;
	},
	action: GatewayAction,
	inputDigest: string,
): ActionGatewayReceipt {
	const reason =
		"governed actions require an attested rootless OCI sandbox executor; host tool fallback is disabled";
	return emitReceipt(onReceipt, {
		actionId: action.actionId,
		kind: action.kind,
		runId: context.runId,
		role: context.role,
		trustTier: context.trustTier,
		outcome: "denied",
		inputDigest,
		resultDigest: digest({ outcome: "denied", reason }),
		reason,
	});
}

function normalizeGovernedExecutor(
	executor: GovernedActionExecutor,
): GovernedActionExecutor {
	if (typeof executor !== "object" || executor === null) {
		throw new TypeError(
			"ActionGateway governed executor must be an explicit sandbox executor object.",
		);
	}
	if (!isTrustedGovernedActionExecutor(executor)) {
		throw new TypeError(
			"ActionGateway governed executor must be produced by the trusted rootless OCI executor factory.",
		);
	}
	if (
		typeof executor.runCommand !== "function" ||
		typeof executor.writeFile !== "function"
	) {
		throw new TypeError(
			"ActionGateway governed executor must provide process and filesystem handlers.",
		);
	}
	const sandbox = normalizeSandboxAttestation(executor.sandbox);
	return Object.freeze({
		sandbox,
		runCommand: executor.runCommand.bind(executor),
		writeFile: executor.writeFile.bind(executor),
	});
}

function normalizeSandboxAttestation(
	attestation: GovernedSandboxAttestationV1,
): GovernedSandboxAttestationV1 {
	if (!isPlainDataRecord(attestation)) {
		throw new TypeError(
			"ActionGateway governed sandbox attestation must be a plain data object.",
		);
	}
	const parsed = ownDataRecord(attestation);
	if (!parsed.ok) {
		throw new TypeError(
			`ActionGateway governed sandbox attestation is invalid: ${parsed.reason}.`,
		);
	}
	const expectedKeys = new Set([
		"schemaVersion",
		"runtime",
		"rootless",
		"readOnlyBase",
		"writableOverlay",
		"network",
		"hostFallback",
		"profileDigest",
	]);
	if (
		Object.keys(parsed.value).length !== expectedKeys.size ||
		Object.keys(parsed.value).some((key) => !expectedKeys.has(key))
	) {
		throw new TypeError(
			"ActionGateway governed sandbox attestation must use the closed V1 schema.",
		);
	}
	if (
		parsed.value.schemaVersion !== 1 ||
		parsed.value.runtime !== "rootless-oci" ||
		parsed.value.rootless !== true ||
		parsed.value.readOnlyBase !== true ||
		parsed.value.writableOverlay !== true ||
		parsed.value.network !== "none" ||
		parsed.value.hostFallback !== false ||
		!isSha256Digest(parsed.value.profileDigest)
	) {
		throw new TypeError(
			"ActionGateway governed sandbox attestation does not declare the required rootless OCI isolation contract.",
		);
	}
	return Object.freeze({
		schemaVersion: 1,
		runtime: "rootless-oci",
		rootless: true,
		readOnlyBase: true,
		writableOverlay: true,
		network: "none",
		hostFallback: false,
		profileDigest: parsed.value.profileDigest,
	});
}

function isSha256Digest(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

type ParsedGatewayAction =
	| { readonly ok: true; readonly action: GatewayAction }
	| {
			readonly ok: false;
			readonly actionId: string;
			readonly kind: GatewayAction["kind"] | "unknown";
			readonly reason: string;
	  };

/**
 * Model/tool protocol objects are runtime input, not TypeScript values. Read
 * only own data properties so an accessor or inherited field cannot execute
 * while the action is being authorized. Unknown fields are rejected rather
 * than silently becoming future authority-bearing inputs.
 */
function parseGatewayAction(input: unknown): ParsedGatewayAction {
	try {
		if (!isPlainDataRecord(input)) {
			return invalidGatewayAction("action must be a plain data object");
		}
		const record = ownDataRecord(input);
		const actionId =
			typeof record.value.actionId === "string"
				? record.value.actionId
				: "unknown";
		const kind = knownGatewayKind(record.value.kind);
		if (!record.ok) {
			return invalidGatewayAction(record.reason, actionId, kind);
		}
		if (kind === "unknown") {
			return invalidGatewayAction("action kind is unsupported", actionId, kind);
		}
		const allowedKeys = isReservedGatewayActionKind(kind)
			? new Set(["actionId", "kind"])
			: kind === "process.run"
				? new Set(["actionId", "kind", "command", "args", "cwd"])
				: new Set(["actionId", "kind", "path", "content"]);
		if (Object.keys(record.value).some((key) => !allowedKeys.has(key))) {
			return invalidGatewayAction(
				"action contains an unknown field",
				actionId,
				kind,
			);
		}
		if (!isNonEmptyString(record.value.actionId)) {
			return invalidGatewayAction("actionId is required", actionId, kind);
		}
		if (isReservedGatewayActionKind(kind)) {
			const action: ReservedGatewayAction = {
				actionId: record.value.actionId,
				kind,
			};
			return { ok: true, action: Object.freeze(action) };
		}

		if (kind === "process.run") {
			if (!isNonEmptyString(record.value.command)) {
				return invalidGatewayAction("command is required", actionId, kind);
			}
			if (
				record.value.args !== undefined &&
				!isReadonlyStringArray(record.value.args)
			) {
				return invalidGatewayAction(
					"args must be a dense array of strings",
					actionId,
					kind,
				);
			}
			if (
				record.value.cwd !== undefined &&
				!isNonEmptyString(record.value.cwd)
			) {
				return invalidGatewayAction(
					"cwd must be a non-empty string",
					actionId,
					kind,
				);
			}
			return {
				ok: true,
				action: Object.freeze({
					actionId: record.value.actionId,
					kind,
					command: record.value.command,
					...(record.value.args === undefined
						? {}
						: { args: Object.freeze([...record.value.args]) }),
					...(record.value.cwd === undefined ? {} : { cwd: record.value.cwd }),
				}),
			};
		}

		if (!isNonEmptyString(record.value.path)) {
			return invalidGatewayAction("path is required", actionId, kind);
		}
		if (typeof record.value.content !== "string") {
			return invalidGatewayAction("content must be a string", actionId, kind);
		}
		return {
			ok: true,
			action: Object.freeze({
				actionId: record.value.actionId,
				kind,
				path: record.value.path,
				content: record.value.content,
			}),
		};
	} catch {
		return invalidGatewayAction("action could not be safely inspected");
	}
}

function invalidGatewayAction(
	reason: string,
	actionId = "unknown",
	kind: GatewayAction["kind"] | "unknown" = "unknown",
): ParsedGatewayAction {
	return { ok: false, actionId, kind, reason };
}

function knownGatewayKind(value: unknown): GatewayAction["kind"] | "unknown" {
	return value === "process.run" ||
		value === "filesystem.write" ||
		isReservedGatewayActionKind(value)
		? value
		: "unknown";
}

function isReservedGatewayActionKind(
	value: unknown,
): value is ReservedGatewayActionKind {
	return (
		typeof value === "string" &&
		RESERVED_GATEWAY_ACTION_FAMILIES.includes(
			value as ReservedGatewayActionKind,
		)
	);
}

function isReservedGatewayAction(
	action: GatewayAction,
): action is ReservedGatewayAction {
	return isReservedGatewayActionKind(action.kind);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPlainDataRecord(value: unknown): value is object {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownDataRecord(value: object):
	| { readonly ok: true; readonly value: Record<string, unknown> }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly value: Record<string, unknown>;
	  } {
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const record = Object.create(null) as Record<string, unknown>;
	let reason: string | undefined;
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string") {
			reason ??= "action cannot contain symbol fields";
			continue;
		}
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) {
			reason ??= "action cannot contain accessor fields";
			continue;
		}
		record[key] = descriptor.value;
	}
	return reason === undefined
		? { ok: true, value: record }
		: { ok: false, reason, value: record };
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	) {
		return false;
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0
	) {
		return false;
	}
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)];
		if (
			!descriptor ||
			!("value" in descriptor) ||
			typeof descriptor.value !== "string"
		) {
			return false;
		}
	}
	for (const key of Reflect.ownKeys(descriptors)) {
		if (
			typeof key !== "string" ||
			(key !== "length" && !isArrayIndex(key, length))
		) {
			return false;
		}
	}
	return true;
}

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function freezeReceipt(receipt: ActionGatewayReceipt): ActionGatewayReceipt {
	return Object.freeze({ ...receipt });
}

function emitReceipt(
	onReceipt: CreateActionGatewayOptions["onReceipt"],
	receipt: ActionGatewayReceipt,
): ActionGatewayReceipt {
	// A receipt is returned to the caller *and* observed by optional telemetry.
	// Never let a mutable observer rewrite the authorization decision that the
	// caller receives. All current fields are primitives, so a frozen copy is a
	// complete immutable snapshot.
	const immutableReceipt = freezeReceipt(receipt);
	try {
		onReceipt?.(immutableReceipt);
	} catch {
		// Receipts are telemetry. Authority was already decided and cannot weaken
		// merely because an observer is unavailable.
	}
	return immutableReceipt;
}

function requireNonEmpty(value: string, field: string): string {
	if (value.length === 0) {
		throw new TypeError(`ActionGateway ${field} must be non-empty.`);
	}
	return value;
}

function cloneImmutableCapabilityBundle(
	bundle: CapabilityBundleV0,
): CapabilityBundleV0 {
	const validated = validateCapabilityBundle(bundle);
	if (!validated.ok) {
		throw new TypeError(
			`ActionGateway capability bundle is invalid: ${validated.errors.join("; ")}`,
		);
	}
	try {
		return deepFreeze(structuredClone(validated.bundle));
	} catch (error) {
		throw new TypeError(
			`ActionGateway capability bundle must be cloneable and immutable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const key of Reflect.ownKeys(value)) {
		const nested = (value as Record<PropertyKey, unknown>)[key];
		if (typeof nested === "object" && nested !== null) {
			deepFreeze(nested);
		}
	}
	return Object.freeze(value);
}

function isBrokerDenied(error: string | undefined): boolean {
	return error?.startsWith("capability broker:") ?? false;
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(value))
		.digest("hex")}`;
}
