import { createHash } from "node:crypto";
import {
	bundleDigest,
	type CapabilityBundleV0,
	type ValidateCapabilityBundleResult,
	validateCapabilityBundle,
} from "@buildplane/capability-broker";
import type { AcceptanceContractV0 } from "./policy.js";
import type {
	CommandExecutionBlock,
	ModelExecutionBlock,
	RoutingHints,
	ToolDefinition,
	UnitPacket,
} from "./run-loop.js";
import type {
	ExecutionRole,
	MergePolicy,
	StrategyChild,
	StrategyMode,
	StrategyPacket,
	Unit,
} from "./types.js";

const VALID_EXECUTION_ROLES = new Set<ExecutionRole>([
	"implementer",
	"reviewer",
	"adversary",
	"judge",
	"candidate",
]);

const GOVERNED_ACCEPTANCE_CONTRACT_FIELDS = new Set([
	"schemaVersion",
	"contract_version",
	"diff_scope",
	"checks",
]);
const GOVERNED_UNIT_PACKET_FIELDS = new Set([
	"unit",
	"execution_role",
	"execution",
	"model",
	"intent",
	"verification",
	"routingHints",
	"provenance_ref",
	"capability_bundle",
	"capability_bundle_digest",
	"acceptance_contract",
	"trust_scope",
]);
const GOVERNED_ACCEPTANCE_DIFF_SCOPE_FIELDS = new Set([
	"allowed_globs",
	"denied_globs",
]);
const GOVERNED_ACCEPTANCE_CHECK_FIELDS = new Set(["command"]);
const GOVERNED_TRUST_SCOPE_FIELDS = new Set([
	"schemaVersion",
	"lane",
	"principal",
	"scope",
]);

/**
 * Closed source form of the existing V0 policy acceptance contract.
 *
 * The policy evaluator still receives the compatible V0 fields; `schemaVersion`
 * makes the packet-level governed contract additive and explicit so unbounded
 * JSON can never be hashed into a dispatch authority.
 */
export interface GovernedAcceptanceContractV1 extends AcceptanceContractV0 {
	readonly schemaVersion: 1;
}

/**
 * Closed identity and purpose declaration carried in a governed source packet.
 *
 * This does not itself grant authority. Its complete, canonical form is bound
 * into the normalized governed packet digest and must agree with the signed
 * dispatch before a worker can receive an action lease.
 */
export interface GovernedTrustScopeV1 {
	readonly schemaVersion: 1;
	readonly lane: "governed";
	readonly principal: string;
	readonly scope: string;
}

/** A `UnitPacket` whose source-only governed contracts have been closed. */
export type GovernedUnitPacketV1 = Omit<
	UnitPacket,
	| "capability_bundle"
	| "capability_bundle_digest"
	| "acceptance_contract"
	| "trust_scope"
> & {
	readonly capability_bundle: CapabilityBundleV0;
	readonly capability_bundle_digest: string;
	readonly acceptance_contract: GovernedAcceptanceContractV1;
	readonly trust_scope: GovernedTrustScopeV1;
};

export function parseUnitPacket(input: string): UnitPacket {
	const packet = asRecord(JSON.parse(input), "packet");
	const unitRecord = asRecord(packet.unit, "packet.unit");
	const verificationRecord =
		packet.verification === undefined
			? {}
			: asRecord(packet.verification, "packet.verification");

	const hasExecution = packet.execution !== undefined;
	const hasModel = packet.model !== undefined;

	if (!hasExecution && !hasModel) {
		throw new TypeError(
			"packet must have either an 'execution' block or a 'model' block",
		);
	}

	if (hasExecution && hasModel) {
		throw new TypeError(
			"packet must have either 'execution' or 'model', not both",
		);
	}

	const unit: Unit = {
		id: readRequiredString(unitRecord, "id", "packet.unit"),
		kind: readRequiredString(unitRecord, "kind", "packet.unit"),
		scope: readRequiredString(unitRecord, "scope", "packet.unit"),
		inputRefs:
			readOptionalStringArray(unitRecord, "inputRefs", "packet.unit") ?? [],
		expectedOutputs:
			readOptionalStringArray(unitRecord, "expectedOutputs", "packet.unit") ??
			[],
		verificationContract: readRequiredString(
			unitRecord,
			"verificationContract",
			"packet.unit",
		),
		policyProfile: readRequiredString(
			unitRecord,
			"policyProfile",
			"packet.unit",
		),
	};

	const verification = {
		requiredOutputs:
			readOptionalStringArray(
				verificationRecord,
				"requiredOutputs",
				"packet.verification",
			) ?? [],
	};

	const intent = parseTaskIntent(packet.intent);
	const routingHints = parseRoutingHints(packet.routingHints);
	const execution_role = parseExecutionRole(
		packet.execution_role,
		"packet.execution_role",
	);

	const provenance_ref =
		packet.provenance_ref === undefined || packet.provenance_ref === ""
			? ""
			: readRequiredString(packet, "provenance_ref", "packet");

	const capabilityFields = parseCapabilityBundleFields(packet);

	const reserved = {
		...(packet.acceptance_contract === undefined
			? {}
			: { acceptance_contract: packet.acceptance_contract }),
		...(packet.trust_scope === undefined
			? {}
			: { trust_scope: packet.trust_scope }),
	};

	if (hasExecution) {
		return {
			unit,
			execution_role,
			execution: parseExecutionBlock(packet.execution),
			...(intent === undefined ? {} : { intent }),
			verification,
			...(routingHints === undefined ? {} : { routingHints }),
			provenance_ref,
			...capabilityFields,
			...reserved,
		};
	}

	return {
		unit,
		execution_role,
		model: parseModelBlock(packet.model),
		...(intent === undefined ? {} : { intent }),
		verification,
		...(routingHints === undefined ? {} : { routingHints }),
		provenance_ref,
		...capabilityFields,
		...reserved,
	};
}

/**
 * Whether a normalized packet carries any evidence that belongs to the
 * governed transaction rather than an ambient legacy/raw execution lane.
 *
 * `execution_role` is intentionally excluded: legacy parsing normalizes an
 * omitted role to `implementer`, so only `parseGovernedUnitPacket` can enforce
 * that the role was explicitly supplied at the source boundary.
 */
export function carriesGovernanceFields(packet: UnitPacket): boolean {
	return (
		packet.capability_bundle !== undefined ||
		packet.capability_bundle_digest !== undefined ||
		packet.acceptance_contract !== undefined ||
		packet.trust_scope !== undefined ||
		(packet.provenance_ref ?? "").trim().length > 0
	);
}

/**
 * Parse a packet proposed for the governed trust lane.
 *
 * `parseUnitPacket` deliberately preserves the legacy default role and absent
 * governance fields because it is also the compiler for raw and historical
 * packets. That compatibility behavior must not become inferred authority at
 * governed admission. This strict entry point checks the raw source before
 * calling the legacy-compatible parser, so a caller cannot distinguish an
 * omitted role from an explicit implementer role after parsing.
 *
 * This validates only source-level admission prerequisites. Signature, digest
 * resolution, manifest verification, current target base, and sandbox
 * availability remain responsibilities of the signed admission boundary.
 */
export function parseGovernedUnitPacket(input: string): GovernedUnitPacketV1 {
	const packet = readClosedGovernanceRecord(
		JSON.parse(input),
		"packet",
		GOVERNED_UNIT_PACKET_FIELDS,
	);
	if (packet.execution_role === undefined) {
		throw new TypeError(
			"packet.execution_role is required for governed admission; legacy role defaults are not authority.",
		);
	}
	if (
		typeof packet.provenance_ref !== "string" ||
		packet.provenance_ref.trim().length === 0
	) {
		throw new TypeError(
			"packet.provenance_ref must be a non-empty string for governed admission.",
		);
	}
	if (
		packet.capability_bundle === undefined ||
		packet.capability_bundle_digest === undefined
	) {
		throw new TypeError(
			"packet.capability_bundle and packet.capability_bundle_digest are required for governed admission.",
		);
	}
	const acceptance_contract = parseGovernedAcceptanceContractV1(
		packet.acceptance_contract,
	);
	const trust_scope = parseGovernedTrustScopeV1(packet.trust_scope);
	const normalized = parseUnitPacket(input);
	if (
		normalized.capability_bundle === undefined ||
		normalized.capability_bundle_digest === undefined
	) {
		throw new TypeError(
			"packet.capability_bundle and packet.capability_bundle_digest are required for governed admission.",
		);
	}
	return Object.freeze({
		...normalized,
		capability_bundle: normalized.capability_bundle,
		capability_bundle_digest: normalized.capability_bundle_digest,
		acceptance_contract,
		trust_scope,
	});
}

/**
 * Strict parser for the source acceptance contract admitted to governed work.
 *
 * The legacy/raw parser intentionally remains permissive because historical
 * packets use untyped reserved fields. Governed admission instead accepts only
 * this closed V1 wrapper around the established V0 policy semantics.
 */
export function parseGovernedAcceptanceContractV1(
	input: unknown,
): GovernedAcceptanceContractV1 {
	const record = readClosedGovernanceRecord(
		input,
		"packet.acceptance_contract",
		GOVERNED_ACCEPTANCE_CONTRACT_FIELDS,
	);
	if (record.schemaVersion !== 1) {
		throw new TypeError(
			"packet.acceptance_contract.schemaVersion must be 1 for governed admission.",
		);
	}
	if (record.contract_version !== "v0") {
		throw new TypeError(
			'packet.acceptance_contract.contract_version must be "v0" for governed admission.',
		);
	}
	const diffScope = readClosedGovernanceRecord(
		record.diff_scope,
		"packet.acceptance_contract.diff_scope",
		GOVERNED_ACCEPTANCE_DIFF_SCOPE_FIELDS,
	);
	const allowed_globs = readGovernanceStringArray(
		diffScope.allowed_globs,
		"packet.acceptance_contract.diff_scope.allowed_globs",
	);
	const denied_globs =
		diffScope.denied_globs === undefined
			? undefined
			: readGovernanceStringArray(
					diffScope.denied_globs,
					"packet.acceptance_contract.diff_scope.denied_globs",
				);
	const checksInput = readGovernanceArray(
		record.checks,
		"packet.acceptance_contract.checks",
	);
	const checks = checksInput.map((entry, index) => {
		const check = readClosedGovernanceRecord(
			entry,
			`packet.acceptance_contract.checks[${index}]`,
			GOVERNED_ACCEPTANCE_CHECK_FIELDS,
		);
		return Object.freeze({
			command: readGovernanceString(
				check.command,
				`packet.acceptance_contract.checks[${index}].command`,
			),
		});
	});
	assertUniqueGovernanceStrings(
		allowed_globs,
		"packet.acceptance_contract.diff_scope.allowed_globs",
	);
	if (denied_globs !== undefined) {
		assertUniqueGovernanceStrings(
			denied_globs,
			"packet.acceptance_contract.diff_scope.denied_globs",
		);
	}
	assertUniqueGovernanceStrings(
		checks.map((check) => check.command),
		"packet.acceptance_contract.checks commands",
	);
	return Object.freeze({
		schemaVersion: 1 as const,
		contract_version: "v0" as const,
		diff_scope: Object.freeze({
			allowed_globs,
			...(denied_globs === undefined ? {} : { denied_globs }),
		}),
		checks: Object.freeze(checks),
	});
}

/** Strict parser for the V1 trust-scope declaration used only in governed work. */
export function parseGovernedTrustScopeV1(
	input: unknown,
): GovernedTrustScopeV1 {
	const record = readClosedGovernanceRecord(
		input,
		"packet.trust_scope",
		GOVERNED_TRUST_SCOPE_FIELDS,
	);
	if (record.schemaVersion !== 1) {
		throw new TypeError(
			"packet.trust_scope.schemaVersion must be 1 for governed admission.",
		);
	}
	if (record.lane !== "governed") {
		throw new TypeError(
			'packet.trust_scope.lane must be "governed" for governed admission.',
		);
	}
	return Object.freeze({
		schemaVersion: 1 as const,
		lane: "governed" as const,
		principal: readGovernanceString(
			record.principal,
			"packet.trust_scope.principal",
		),
		scope: readGovernanceString(record.scope, "packet.trust_scope.scope"),
	});
}

/**
 * Canonical content address for the closed V1 acceptance source contract.
 *
 * The established acceptance-contract digest convention hashes canonical JSON
 * directly, so this function deliberately preserves that convention rather
 * than adding a competing digest domain. Parsing first is what prevents a
 * caller from assigning semantic meaning to arbitrary nested JSON.
 */
export function canonicalGovernedAcceptanceContractV1Digest(
	input: unknown,
): string {
	const contract = parseGovernedAcceptanceContractV1(input);
	return sha256GovernanceJson({
		checks: contract.checks.map((check) => ({ command: check.command })),
		contract_version: contract.contract_version,
		diff_scope: {
			allowed_globs: [...contract.diff_scope.allowed_globs],
			...(contract.diff_scope.denied_globs === undefined
				? {}
				: { denied_globs: [...contract.diff_scope.denied_globs] }),
		},
		schemaVersion: contract.schemaVersion,
	});
}

/** Canonical content address for the closed V1 trust-scope source contract. */
export function canonicalGovernedTrustScopeV1Digest(input: unknown): string {
	const scope = parseGovernedTrustScopeV1(input);
	return sha256GovernanceJson({
		lane: scope.lane,
		principal: scope.principal,
		schemaVersion: scope.schemaVersion,
		scope: scope.scope,
	});
}

function sha256GovernanceJson(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(value), "utf8")
		.digest("hex")}`;
}

function readClosedGovernanceRecord(
	input: unknown,
	label: string,
	allowedFields: ReadonlySet<string>,
): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError(`${label} must be an object for governed admission.`);
	}
	if (Object.getOwnPropertySymbols(input).length > 0) {
		throw new TypeError(`${label} must not contain symbol fields.`);
	}
	const record = input as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(record)) {
		if (!allowedFields.has(key)) {
			throw new TypeError(`${label} contains unknown field ${key}.`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(`${label}.${key} must be a data property.`);
		}
	}
	return record;
}

function readGovernanceArray(
	input: unknown,
	label: string,
): readonly unknown[] {
	if (!Array.isArray(input)) {
		throw new TypeError(`${label} must be an array for governed admission.`);
	}
	const entries: unknown[] = [];
	for (let index = 0; index < input.length; index += 1) {
		if (!Object.hasOwn(input, index)) {
			throw new TypeError(`${label} must not contain sparse arrays.`);
		}
		entries.push(input[index]);
	}
	return Object.freeze(entries);
}

function readGovernanceStringArray(
	input: unknown,
	label: string,
): readonly string[] {
	return Object.freeze(
		readGovernanceArray(input, label).map((entry, index) =>
			readGovernanceString(entry, `${label}[${index}]`),
		),
	);
}

function readGovernanceString(input: unknown, label: string): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.trim() !== input ||
		input.includes("\0")
	) {
		throw new TypeError(
			`${label} must be a non-empty, trimmed string without NUL bytes.`,
		);
	}
	return input;
}

function assertUniqueGovernanceStrings(
	values: readonly string[],
	label: string,
): void {
	if (new Set(values).size !== values.length) {
		throw new TypeError(`${label} must not contain duplicate values.`);
	}
}

function parseExecutionRole(raw: unknown, label: string): ExecutionRole {
	const role = raw === undefined ? "implementer" : raw;
	if (
		typeof role !== "string" ||
		!VALID_EXECUTION_ROLES.has(role as ExecutionRole)
	) {
		throw new TypeError(
			`${label} must be one of: ${[...VALID_EXECUTION_ROLES].join(", ")}`,
		);
	}
	return role as ExecutionRole;
}

function parseCapabilityBundleFields(packet: Record<string, unknown>): {
	capability_bundle?: CapabilityBundleV0;
	capability_bundle_digest?: string;
} {
	if (packet.capability_bundle === undefined) {
		return {};
	}
	const validated: ValidateCapabilityBundleResult = validateCapabilityBundle(
		packet.capability_bundle,
	);
	if (!validated.ok) {
		throw new TypeError(
			`packet.capability_bundle invalid: ${validated.errors.join("; ")}`,
		);
	}
	const digestField = packet.capability_bundle_digest;
	if (digestField === undefined) {
		throw new TypeError(
			"packet.capability_bundle_digest is required when capability_bundle is set",
		);
	}
	if (typeof digestField !== "string" || !digestField.startsWith("sha256:")) {
		throw new TypeError(
			"packet.capability_bundle_digest must be a sha256-prefixed digest string",
		);
	}
	const expected = bundleDigest(validated.bundle);
	if (digestField !== expected) {
		throw new TypeError(
			"packet.capability_bundle_digest does not match capability_bundle canonical digest",
		);
	}
	return {
		capability_bundle: validated.bundle,
		capability_bundle_digest: digestField,
	};
}

function parseTaskIntent(
	raw: unknown,
): NonNullable<UnitPacket["intent"]> | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const record = asRecord(raw, "packet.intent");
	const contextRecord = asRecord(record.context ?? {}, "packet.intent.context");
	const constraintsRecord = asRecord(
		record.constraints ?? {},
		"packet.intent.constraints",
	);
	const featuresRecord = asRecord(
		record.features ?? {},
		"packet.intent.features",
	);

	return {
		objective: readRequiredString(record, "objective", "packet.intent"),
		taskType: readRequiredString(
			record,
			"taskType",
			"packet.intent",
		) as NonNullable<UnitPacket["intent"]>["taskType"],
		context: {
			files:
				readOptionalStringArray(
					contextRecord,
					"files",
					"packet.intent.context",
				) ?? [],
			...(readOptionalStringArray(
				contextRecord,
				"priorWork",
				"packet.intent.context",
			) === undefined
				? {}
				: {
						priorWork: readOptionalStringArray(
							contextRecord,
							"priorWork",
							"packet.intent.context",
						),
					}),
			...(readOptionalStringArray(
				contextRecord,
				"memories",
				"packet.intent.context",
			) === undefined
				? {}
				: {
						memories: readOptionalStringArray(
							contextRecord,
							"memories",
							"packet.intent.context",
						),
					}),
			...(readOptionalString(
				contextRecord,
				"codebaseHints",
				"packet.intent.context",
			) === undefined
				? {}
				: {
						codebaseHints: readOptionalString(
							contextRecord,
							"codebaseHints",
							"packet.intent.context",
						),
					}),
			...(readOptionalString(
				contextRecord,
				"retryContext",
				"packet.intent.context",
			) === undefined
				? {}
				: {
						retryContext: readOptionalString(
							contextRecord,
							"retryContext",
							"packet.intent.context",
						),
					}),
		},
		constraints: {
			scope:
				readOptionalStringArray(
					constraintsRecord,
					"scope",
					"packet.intent.constraints",
				) ?? [],
			...(readOptionalStringArray(
				constraintsRecord,
				"forbidden",
				"packet.intent.constraints",
			) === undefined
				? {}
				: {
						forbidden: readOptionalStringArray(
							constraintsRecord,
							"forbidden",
							"packet.intent.constraints",
						),
					}),
			verification:
				readOptionalStringArray(
					constraintsRecord,
					"verification",
					"packet.intent.constraints",
				) ?? [],
		},
		features: {
			ambiguity: readRequiredString(
				featuresRecord,
				"ambiguity",
				"packet.intent.features",
			) as NonNullable<UnitPacket["intent"]>["features"]["ambiguity"],
			reversibility: readRequiredString(
				featuresRecord,
				"reversibility",
				"packet.intent.features",
			) as NonNullable<UnitPacket["intent"]>["features"]["reversibility"],
			verifierStrength: readRequiredString(
				featuresRecord,
				"verifierStrength",
				"packet.intent.features",
			) as NonNullable<UnitPacket["intent"]>["features"]["verifierStrength"],
			...(readOptionalString(
				featuresRecord,
				"language",
				"packet.intent.features",
			) === undefined
				? {}
				: {
						language: readOptionalString(
							featuresRecord,
							"language",
							"packet.intent.features",
						),
					}),
			...(readOptionalString(
				featuresRecord,
				"framework",
				"packet.intent.features",
			) === undefined
				? {}
				: {
						framework: readOptionalString(
							featuresRecord,
							"framework",
							"packet.intent.features",
						),
					}),
			...(readOptionalString(
				featuresRecord,
				"estimatedComplexity",
				"packet.intent.features",
			) === undefined
				? {}
				: {
						estimatedComplexity: readOptionalString(
							featuresRecord,
							"estimatedComplexity",
							"packet.intent.features",
						) as NonNullable<
							UnitPacket["intent"]
						>["features"]["estimatedComplexity"],
					}),
			...(readOptionalNumber(
				featuresRecord,
				"changeSurface",
				"packet.intent.features",
			) === undefined
				? {}
				: {
						changeSurface: readOptionalNumber(
							featuresRecord,
							"changeSurface",
							"packet.intent.features",
						),
					}),
		},
	};
}

function parseExecutionBlock(raw: unknown): CommandExecutionBlock {
	const record = asRecord(raw, "packet.execution");
	const args = readOptionalStringArray(record, "args", "packet.execution");
	const cwd = readOptionalString(record, "cwd", "packet.execution");

	return {
		command: readRequiredString(record, "command", "packet.execution"),
		...(args === undefined ? {} : { args }),
		...(cwd === undefined ? {} : { cwd }),
	};
}

function parseModelBlock(raw: unknown): ModelExecutionBlock {
	const record = asRecord(raw, "packet.model");
	const systemPrompt = readOptionalString(
		record,
		"systemPrompt",
		"packet.model",
	);
	const prompt = readOptionalString(record, "prompt", "packet.model");
	const tools = parseOptionalTools(record.tools);

	return {
		provider: readRequiredString(record, "provider", "packet.model"),
		model: readRequiredString(record, "model", "packet.model"),
		...(prompt === undefined ? {} : { prompt }),
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(tools === undefined ? {} : { tools }),
	};
}

const VALID_PREFERRED_WORKERS = new Set(["claude-code", "codex"]);

function parseRoutingHints(raw: unknown): RoutingHints | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const record = asRecord(raw, "packet.routingHints");
	const preferredWorker = readOptionalString(
		record,
		"preferredWorker",
		"packet.routingHints",
	);

	if (
		preferredWorker !== undefined &&
		!VALID_PREFERRED_WORKERS.has(preferredWorker)
	) {
		throw new TypeError(
			`packet.routingHints.preferredWorker must be one of: ${[...VALID_PREFERRED_WORKERS].join(", ")}`,
		);
	}

	const preferredModel = readOptionalString(
		record,
		"preferredModel",
		"packet.routingHints",
	);
	const effort = readOptionalString(record, "effort", "packet.routingHints");

	if (effort !== undefined && !["low", "medium", "high"].includes(effort)) {
		throw new TypeError(
			"packet.routingHints.effort must be one of: low, medium, high",
		);
	}

	return {
		...(preferredWorker === undefined
			? {}
			: {
					preferredWorker: preferredWorker as RoutingHints["preferredWorker"],
				}),
		...(preferredModel === undefined ? {} : { preferredModel }),
		...(effort === undefined
			? {}
			: { effort: effort as RoutingHints["effort"] }),
	};
}

function parseOptionalTools(
	raw: unknown,
): readonly ToolDefinition[] | undefined {
	if (raw === undefined) {
		return undefined;
	}

	if (!Array.isArray(raw)) {
		throw new TypeError("packet.model.tools must be an array");
	}

	return raw.map((item, i) => {
		const record = asRecord(item, `packet.model.tools[${i}]`);
		return {
			name: readRequiredString(record, "name", `packet.model.tools[${i}]`),
			description: readRequiredString(
				record,
				"description",
				`packet.model.tools[${i}]`,
			),
			parameters: asRecord(
				record.parameters ?? {},
				`packet.model.tools[${i}].parameters`,
			),
		};
	});
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}

	return value as Record<string, unknown>;
}

function readRequiredString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${label}.${key} must be a non-empty string`);
	}

	return value;
}

function readOptionalString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${label}.${key} must be a non-empty string`);
	}

	return value;
}

function readOptionalNumber(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${label}.${key} must be a finite number`);
	}

	return value;
}

function readOptionalStringArray(
	record: Record<string, unknown>,
	key: string,
	label: string,
): readonly string[] | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}

	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new TypeError(`${label}.${key} must be an array of strings`);
	}

	return value;
}

// ── StrategyPacket parser ───────────────────────────────────

const VALID_STRATEGY_MODES = new Set<StrategyMode>([
	"single",
	"implement-then-review",
	"parallel-candidates",
	"escalate-on-disagreement",
	"adversarial",
]);

const VALID_MERGE_POLICIES = new Set<MergePolicy>([
	"direct",
	"reviewer-must-approve",
	"best-by-objective",
	"judge-decides",
	"adversary-loop",
]);

export function parseStrategyPacket(raw: unknown): StrategyPacket {
	const packet = asRecord(raw, "strategyPacket");

	const id = readRequiredString(packet, "id", "strategyPacket");

	const modeRaw = readRequiredString(packet, "mode", "strategyPacket");
	if (!VALID_STRATEGY_MODES.has(modeRaw as StrategyMode)) {
		throw new TypeError(
			`strategyPacket.mode must be one of: ${[...VALID_STRATEGY_MODES].join(", ")}`,
		);
	}
	const mode = modeRaw as StrategyMode;

	const mergePolicyRaw = readRequiredString(
		packet,
		"mergePolicy",
		"strategyPacket",
	);
	if (!VALID_MERGE_POLICIES.has(mergePolicyRaw as MergePolicy)) {
		throw new TypeError(
			`strategyPacket.mergePolicy must be one of: ${[...VALID_MERGE_POLICIES].join(", ")}`,
		);
	}
	const mergePolicy = mergePolicyRaw as MergePolicy;

	if (!Array.isArray(packet.children) || packet.children.length === 0) {
		throw new TypeError("strategyPacket.children must be a non-empty array");
	}

	const childUnitIds = new Set<string>();
	const children: StrategyChild[] = (packet.children as unknown[]).map(
		(rawChild: unknown, i: number) => {
			const child = asRecord(rawChild, `strategyPacket.children[${i}]`);

			const roleRaw = readRequiredString(
				child,
				"role",
				`strategyPacket.children[${i}]`,
			);
			if (!VALID_EXECUTION_ROLES.has(roleRaw as ExecutionRole)) {
				throw new TypeError(
					`strategyPacket.children[${i}].role must be one of: ${[...VALID_EXECUTION_ROLES].join(", ")}`,
				);
			}
			const role = roleRaw as ExecutionRole;

			const packetRecord = asRecord(
				child.packet,
				`strategyPacket.children[${i}].packet`,
			);
			const childPacket = parseUnitPacket(JSON.stringify(packetRecord));
			if (
				packetRecord.execution_role !== undefined &&
				childPacket.execution_role !== role
			) {
				throw new TypeError(
					`strategyPacket.children[${i}].packet.execution_role "${childPacket.execution_role}" does not match child role "${role}"`,
				);
			}
			const normalizedChildPacket: UnitPacket = {
				...childPacket,
				execution_role: role,
			};
			if (childUnitIds.has(normalizedChildPacket.unit.id)) {
				throw new TypeError(
					`strategyPacket.children[${i}].packet.unit.id duplicates child unit id "${normalizedChildPacket.unit.id}"`,
				);
			}
			childUnitIds.add(normalizedChildPacket.unit.id);

			const dependsOnRaw = child.dependsOn;
			let dependsOn: readonly string[] | undefined;
			if (dependsOnRaw !== undefined) {
				if (
					!Array.isArray(dependsOnRaw) ||
					dependsOnRaw.some((x) => typeof x !== "string")
				) {
					throw new TypeError(
						`strategyPacket.children[${i}].dependsOn must be an array of strings`,
					);
				}
				dependsOn = dependsOnRaw as string[];
			}

			return {
				packet: normalizedChildPacket,
				role,
				...(dependsOn !== undefined ? { dependsOn } : {}),
			};
		},
	);

	// Validate dependsOn references point to valid child unit IDs
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child.dependsOn) {
			for (const ref of child.dependsOn) {
				if (!childUnitIds.has(ref)) {
					throw new TypeError(
						`strategyPacket.children[${i}].dependsOn references unknown unit id "${ref}"`,
					);
				}
			}
		}
	}

	return { id, mode, children, mergePolicy };
}
