import { createHash } from "node:crypto";

export type RunAdmissionDecision =
	| "PASS"
	| "BLOCKED"
	| "FAILED"
	| "INSUFFICIENT_EVIDENCE"
	| "UNSAFE_TO_RUN";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| undefined
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };
export type JsonRecord = { readonly [key: string]: JsonValue };

export interface RunAdmissionEvidenceInput extends JsonRecord {
	readonly kind: string;
	readonly ref: string;
	readonly digest: string | null;
	readonly required: boolean;
	readonly status: string;
	readonly reason?: string;
}

export interface RunAdmissionDeclaredScope extends JsonRecord {
	readonly allowed_paths?: readonly string[];
	readonly forbidden_paths?: readonly string[];
	readonly network_allowed?: boolean;
}

export interface RunAdmissionRequest extends JsonRecord {
	readonly requested_capabilities?: readonly string[];
	readonly requested_side_effects?: readonly string[];
	readonly declared_scope?: RunAdmissionDeclaredScope;
	readonly operator_approvals?: readonly JsonValue[];
}

export interface RunAdmissionRepo extends JsonRecord {
	readonly path?: string;
	readonly worktree_path?: string;
	readonly expected_remote?: string;
	readonly base_ref?: string;
	readonly base_commit?: string;
	readonly head_commit?: string;
	readonly worktree_clean?: boolean;
}

export interface CreateRunAdmissionReceiptDryRunInput {
	readonly receiptId: string;
	readonly decidedAt: string;
	readonly run: JsonRecord;
	readonly repo: RunAdmissionRepo;
	readonly request: RunAdmissionRequest;
	readonly policyProfileId: string;
	readonly evidenceInputs: readonly RunAdmissionEvidenceInput[];
	readonly actor?: string;
	readonly source?: string;
	readonly pack?: string | null;
	readonly host?: string | null;
	readonly provider?: string | null;
}

export interface RunAdmissionDeniedSideEffect extends JsonRecord {
	readonly effect: string;
	readonly reason: string;
}

export interface RunAdmissionCapabilityGrant extends JsonRecord {
	readonly capability: string;
	readonly scope: readonly string[];
	readonly expires_at: string | null;
}

export interface RunAdmissionPolicy extends JsonRecord {
	readonly profile_id: string;
	readonly allowed_side_effects: readonly string[];
	readonly denied_side_effects: readonly RunAdmissionDeniedSideEffect[];
	readonly capability_grants: readonly RunAdmissionCapabilityGrant[];
	readonly quarantine: boolean;
	readonly quarantine_reason?: string;
}

export interface RunAdmissionDecisionBlock extends JsonRecord {
	readonly decision: RunAdmissionDecision;
	readonly decided_by: string;
	readonly decided_at: string;
	readonly reasons: readonly string[];
	readonly missing_evidence: readonly string[];
	readonly unsafe_requests: readonly string[];
	readonly will_execute_worker: false;
	readonly authorized_next_step: string;
}

export interface RunAdmissionReplay extends JsonRecord {
	readonly side_effect_safe: true;
	readonly behavior: string;
	readonly fork: string;
}

export interface RunAdmissionProvenance extends JsonRecord {
	readonly created_by: string;
	readonly created_from: string;
	readonly redaction_policy: string;
	readonly pack: string | null;
	readonly host: string | null;
	readonly provider: string | null;
	readonly worker_agent_trusted: false;
}

export interface RunAdmissionReceipt extends JsonRecord {
	readonly $schema: string;
	readonly schema_version: "0.1.0";
	readonly receipt_type: "run.admission";
	readonly receipt_id: string;
	readonly run: JsonRecord;
	readonly repo: RunAdmissionRepo;
	readonly request: RunAdmissionRequest;
	readonly policy: RunAdmissionPolicy;
	readonly evidence_inputs: readonly RunAdmissionEvidenceInput[];
	readonly admission: RunAdmissionDecisionBlock;
	readonly idempotency_key: string;
	readonly replay: RunAdmissionReplay;
	readonly provenance: RunAdmissionProvenance;
}

export interface RunAdmissionRecordedReplay extends JsonRecord {
	readonly side_effect_safe: true;
	readonly allowed_actions: readonly string[];
	readonly forbidden_side_effects: readonly string[];
	readonly behavior: string;
	readonly fork: string;
}

export interface RunAdmissionRecordedPayload extends JsonRecord {
	readonly receipt_id: string;
	readonly receipt_digest: string;
	readonly receipt_ref: string | null;
	readonly idempotency_key: string;
	readonly decision: RunAdmissionDecision;
	readonly policy_profile_id: string;
	readonly requested_side_effects: readonly string[];
	readonly allowed_side_effects: readonly string[];
	readonly denied_side_effects: readonly RunAdmissionDeniedSideEffect[];
	readonly missing_evidence: readonly string[];
	readonly unsafe_requests: readonly string[];
	readonly evidence_inputs: readonly RunAdmissionEvidenceInput[];
	readonly quarantine: boolean;
	readonly will_execute_worker: false;
	readonly authorized_next_step: string;
	readonly decided_by: string;
	readonly decided_at: string;
}

export interface RunAdmissionRecordedEvent extends JsonRecord {
	readonly kind: "run_admission_recorded";
	readonly schema_version: "0.1.0";
	readonly recorded_at: string;
	readonly payload: RunAdmissionRecordedPayload;
	readonly replay: RunAdmissionRecordedReplay;
}

export interface RunAdmissionReceiptArtifactWriteInput {
	readonly receipt: RunAdmissionReceipt;
	readonly receiptDigest: string;
	readonly contents: string;
}

export interface RunAdmissionEventAppendInput {
	readonly event: RunAdmissionRecordedEvent;
	readonly receipt: RunAdmissionReceipt;
}

export interface RunAdmissionLocalEvidenceWriteResult {
	readonly ref: string;
	readonly path?: string;
}

export interface RunAdmissionLocalEvidenceStore {
	readonly writeReceiptArtifact: (
		input: RunAdmissionReceiptArtifactWriteInput,
	) =>
		| RunAdmissionLocalEvidenceWriteResult
		| Promise<RunAdmissionLocalEvidenceWriteResult>;
	readonly appendAdmissionEvent: (
		input: RunAdmissionEventAppendInput,
	) =>
		| RunAdmissionLocalEvidenceWriteResult
		| Promise<RunAdmissionLocalEvidenceWriteResult>;
}

export interface RecordRunAdmissionReceiptAttemptInput {
	readonly receipt: RunAdmissionReceipt;
	readonly store: RunAdmissionLocalEvidenceStore;
	readonly recordedAt?: string;
}

export interface RunAdmissionReceiptAttemptRecord extends JsonRecord {
	readonly receipt_json: string;
	readonly receipt_digest: string;
	readonly receipt_ref: string;
	readonly receipt_path?: string;
	readonly payload: RunAdmissionRecordedPayload;
	readonly event: RunAdmissionRecordedEvent;
	readonly event_ref: string;
	readonly event_path?: string;
}

export class RunAdmissionReceiptInputError extends Error {
	readonly code = "INVALID_PACKET";

	constructor(message = "Invalid run admission receipt input.") {
		super(message);
		this.name = "RunAdmissionReceiptInputError";
	}
}

const SAFE_SIDE_EFFECTS = new Set([
	"fs.read:repo",
	"fs.write:declared_scope",
	"command.execute:verification",
	"git.commit:local_worktree",
]);

const READ_ONLY_SIDE_EFFECTS = new Set(["fs.read:repo"]);

const REQUIRED_PASS_EVIDENCE_KINDS = [
	"git.status",
	"git.rev-parse",
	"declared_scope",
] as const;

const REQUIRED_PASS_REPO_BINDING_FIELDS = [
	"path",
	"worktree_path",
	"expected_remote",
	"base_ref",
	"base_commit",
	"head_commit",
	"worktree_clean",
] as const;

const STANDARD_DENIED_SIDE_EFFECTS: readonly RunAdmissionDeniedSideEffect[] = [
	{
		effect: "git.push:remote",
		reason: "Run admission cannot push or mutate remotes.",
	},
	{
		effect: "github.pr.create",
		reason:
			"GitHub side effects require a separate explicit operator approval and receipt.",
	},
	{
		effect: "deploy:production",
		reason: "Production mutation is outside local-first admission scope.",
	},
];

const UNSAFE_DENIAL_REASONS = new Map<string, string>([
	[
		"fs.write:declared_scope",
		"Non-read grants are revoked after an unsafe side-effect request.",
	],
	[
		"command.execute:verification",
		"Execution grants are revoked until unsafe requested effects are removed or explicitly approved.",
	],
	["git.push:remote", "Remote push is outside local-first admission scope."],
	[
		"github.pr.create",
		"GitHub mutation requires a separate explicit approval and receipt.",
	],
	[
		"deploy:production",
		"Production deploys are never authorized by run admission.",
	],
]);

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireJsonRecord(value: unknown, field: string): JsonRecord {
	if (!isJsonRecord(value)) {
		throw new RunAdmissionReceiptInputError(`${field} must be an object.`);
	}
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new RunAdmissionReceiptInputError(
			`${field} must be a non-empty string.`,
		);
	}
	return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new RunAdmissionReceiptInputError(
			`${field} must be an array of strings.`,
		);
	}
	return value;
}

function cloneJson<T extends JsonValue>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function unique(items: readonly string[]): readonly string[] {
	return Array.from(new Set(items));
}

function hasPresentRequiredEvidence(
	evidenceInputs: readonly RunAdmissionEvidenceInput[],
	kind: string,
): boolean {
	return evidenceInputs.some(
		(evidence) =>
			evidence.kind === kind &&
			evidence.required &&
			evidence.status === "present",
	);
}

function collectUnavailableRequiredEvidence(
	evidenceInputs: readonly RunAdmissionEvidenceInput[],
): readonly string[] {
	return unique(
		evidenceInputs
			.filter((evidence) => evidence.required && evidence.status !== "present")
			.map((evidence) => evidence.kind),
	);
}

function hasNonEmptyString(value: JsonValue): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function collectMissingRepoBindingEvidence(
	repo: RunAdmissionRepo,
): readonly string[] {
	return REQUIRED_PASS_REPO_BINDING_FIELDS.filter((field) => {
		if (field === "worktree_clean") {
			return repo.worktree_clean !== true;
		}
		return !hasNonEmptyString(repo[field]);
	}).map((field) => `repo.${field}`);
}

function collectPassBlockingMissingEvidence(
	evidenceInputs: readonly RunAdmissionEvidenceInput[],
	repo: RunAdmissionRepo,
): readonly string[] {
	const unavailableRequiredEvidence =
		collectUnavailableRequiredEvidence(evidenceInputs);
	const absentRequiredEvidence = REQUIRED_PASS_EVIDENCE_KINDS.filter(
		(kind) => !hasPresentRequiredEvidence(evidenceInputs, kind),
	);
	return unique([
		...unavailableRequiredEvidence,
		...absentRequiredEvidence,
		...(unavailableRequiredEvidence.length === 0
			? collectMissingRepoBindingEvidence(repo)
			: []),
	]);
}

function unsafeDenialReason(effect: string): string {
	if (UNSAFE_DENIAL_REASONS.has(effect)) {
		return UNSAFE_DENIAL_REASONS.get(effect) as string;
	}
	if (effect.startsWith("kanban.")) {
		return "Kanban mutation is outside run admission and requires explicit operator authority.";
	}
	return "Requested side effect is not allowlisted for run admission.";
}

function isUnsafeSideEffect(effect: string): boolean {
	return !SAFE_SIDE_EFFECTS.has(effect);
}

function compareJsonKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function stableJson(value: JsonValue): string {
	if (value === undefined) {
		return "null";
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	const record = value as { readonly [key: string]: JsonValue };
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort(compareJsonKeys)
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

function createIdempotencyKey(input: {
	readonly run: JsonRecord;
	readonly repo: RunAdmissionRepo;
	readonly request: RunAdmissionRequest;
	readonly evidenceInputs: readonly RunAdmissionEvidenceInput[];
	readonly policyProfileId: string;
}): string {
	const material: JsonRecord = {
		contract: "run.admission:v0",
		repo: {
			expected_remote: input.repo.expected_remote ?? null,
			base_ref: input.repo.base_ref ?? null,
			base_commit: input.repo.base_commit ?? null,
			worktree_path: input.repo.worktree_path ?? null,
		},
		run: {
			unit_id: input.run.unit_id ?? null,
		},
		request: {
			requested_capabilities: [
				...(input.request.requested_capabilities ?? []),
			].sort(compareJsonKeys),
			requested_side_effects: [
				...(input.request.requested_side_effects ?? []),
			].sort(compareJsonKeys),
			declared_scope_allowed_paths: [
				...(input.request.declared_scope?.allowed_paths ?? []),
			].sort(compareJsonKeys),
		},
		evidence_inputs: input.evidenceInputs
			.filter((evidence) => evidence.required)
			.map((evidence) => ({
				kind: evidence.kind,
				digest: evidence.digest ?? null,
				status: evidence.status,
			})),
		policy_profile_id: input.policyProfileId,
	};
	const digest = createHash("sha256")
		.update(stableJson(material))
		.digest("hex");
	return `run.admission:v0:sha256:${digest}`;
}

function buildCapabilityGrants(
	allowedSideEffects: readonly string[],
	repo: RunAdmissionRepo,
	request: RunAdmissionRequest,
): readonly RunAdmissionCapabilityGrant[] {
	const grants: RunAdmissionCapabilityGrant[] = [];
	for (const effect of allowedSideEffects) {
		if (effect === "fs.read:repo") {
			grants.push({
				capability: effect,
				scope: [repo.path ?? repo.worktree_path ?? ""].filter(
					(scope) => scope.length > 0,
				),
				expires_at: null,
			});
		}
		if (effect === "fs.write:declared_scope") {
			grants.push({
				capability: effect,
				scope: [...(request.declared_scope?.allowed_paths ?? [])],
				expires_at: null,
			});
		}
		if (effect === "command.execute:verification") {
			grants.push({
				capability: effect,
				scope: ["git diff --check", "pnpm lint"],
				expires_at: null,
			});
		}
		if (effect === "git.commit:local_worktree") {
			grants.push({
				capability: effect,
				scope: [repo.worktree_path ?? repo.path ?? ""].filter(
					(scope) => scope.length > 0,
				),
				expires_at: null,
			});
		}
	}
	return grants;
}

function buildUnsafeDeniedSideEffects(
	requestedSideEffects: readonly string[],
): readonly RunAdmissionDeniedSideEffect[] {
	const deniedEffects = unique(
		requestedSideEffects.filter(
			(effect) =>
				!READ_ONLY_SIDE_EFFECTS.has(effect) || isUnsafeSideEffect(effect),
		),
	);
	return deniedEffects.map((effect) => ({
		effect,
		reason: unsafeDenialReason(effect),
	}));
}

function createReplay(
	decision: RunAdmissionDecision,
	receiptId: string,
): RunAdmissionReplay {
	if (decision === "INSUFFICIENT_EVIDENCE") {
		return {
			side_effect_safe: true,
			behavior:
				"Replay may show that admission halted before grants because required evidence was missing.",
			fork: "A fork may capture the missing evidence and recompute admission; it may not inherit write grants from this receipt.",
		};
	}
	if (decision === "UNSAFE_TO_RUN") {
		return {
			side_effect_safe: true,
			behavior:
				"Replay may display the unsafe request and quarantine instruction but must not release the quarantine or perform denied effects.",
			fork: "A fork must remove unsafe requested side effects or cite a separate explicit release receipt before recomputing admission.",
		};
	}
	return {
		side_effect_safe: true,
		behavior:
			"Replay may display this receipt and cited evidence refs but must not re-run admission or workers.",
		fork: `A fork must carry parent receipt ${receiptId} and recompute admission if repo base, scope, capabilities, evidence, or policy changes.`,
	};
}

function validateInput(input: CreateRunAdmissionReceiptDryRunInput): void {
	const record = requireJsonRecord(input, "input");
	requireString(record.receiptId, "receiptId");
	requireString(record.decidedAt, "decidedAt");
	requireString(record.policyProfileId, "policyProfileId");
	requireJsonRecord(record.run, "run");
	requireJsonRecord(record.repo, "repo");
	const request = requireJsonRecord(record.request, "request");
	requireStringArray(
		request.requested_side_effects,
		"request.requested_side_effects",
	);
	if (request.requested_capabilities !== undefined) {
		requireStringArray(
			request.requested_capabilities,
			"request.requested_capabilities",
		);
	}
	if (!Array.isArray(record.evidenceInputs)) {
		throw new RunAdmissionReceiptInputError("evidenceInputs must be an array.");
	}
	for (let index = 0; index < record.evidenceInputs.length; index += 1) {
		const evidence = record.evidenceInputs[index];
		const evidenceRecord = requireJsonRecord(
			evidence,
			`evidenceInputs[${index}]`,
		);
		requireString(evidenceRecord.kind, `evidenceInputs[${index}].kind`);
		requireString(evidenceRecord.status, `evidenceInputs[${index}].status`);
		if (typeof evidenceRecord.required !== "boolean") {
			throw new RunAdmissionReceiptInputError(
				`evidenceInputs[${index}].required must be a boolean.`,
			);
		}
	}
}

function createReceiptDigest(receiptJson: string): string {
	const digest = createHash("sha256").update(receiptJson).digest("hex");
	return `sha256:${digest}`;
}

function createRecordedReplay(
	receipt: RunAdmissionReceipt,
): RunAdmissionRecordedReplay {
	return {
		side_effect_safe: true,
		allowed_actions: ["inspect_receipt", "verify_receipt_digest"],
		forbidden_side_effects: [
			"worker.execute",
			"github.pr.create",
			"network.mutate",
			"kanban.write:auto",
			"git.push:remote",
			"deploy:production",
			"git.merge",
		],
		behavior: receipt.replay.behavior,
		fork: receipt.replay.fork,
	};
}

function createRecordedPayload(input: {
	readonly receipt: RunAdmissionReceipt;
	readonly receiptDigest: string;
	readonly receiptRef: string | null;
}): RunAdmissionRecordedPayload {
	const { receipt, receiptDigest, receiptRef } = input;
	return {
		receipt_id: receipt.receipt_id,
		receipt_digest: receiptDigest,
		receipt_ref: receiptRef,
		idempotency_key: receipt.idempotency_key,
		decision: receipt.admission.decision,
		policy_profile_id: receipt.policy.profile_id,
		requested_side_effects: cloneJson(
			receipt.request.requested_side_effects ?? [],
		),
		allowed_side_effects: cloneJson(receipt.policy.allowed_side_effects),
		denied_side_effects: cloneJson(receipt.policy.denied_side_effects),
		missing_evidence: cloneJson(receipt.admission.missing_evidence),
		unsafe_requests: cloneJson(receipt.admission.unsafe_requests),
		evidence_inputs: cloneJson(receipt.evidence_inputs),
		quarantine: receipt.policy.quarantine,
		will_execute_worker: false,
		authorized_next_step: receipt.admission.authorized_next_step,
		decided_by: receipt.admission.decided_by,
		decided_at: receipt.admission.decided_at,
	};
}

export function createRunAdmissionReceiptDryRun(
	input: CreateRunAdmissionReceiptDryRunInput,
): RunAdmissionReceipt {
	validateInput(input);

	const actor = input.actor ?? "buildplane.kernel.admission";
	const source = input.source ?? "dry-run";
	const run = cloneJson(input.run);
	const repo = cloneJson(input.repo);
	const request = cloneJson(input.request);
	const evidenceInputs = cloneJson(input.evidenceInputs as JsonValue) as
		| RunAdmissionEvidenceInput[]
		| readonly RunAdmissionEvidenceInput[];
	const requestedSideEffects = [...(request.requested_side_effects ?? [])];
	let missingEvidence = collectPassBlockingMissingEvidence(
		evidenceInputs,
		repo,
	);
	const unsafeRequests = unique(
		requestedSideEffects.filter((effect) => isUnsafeSideEffect(effect)),
	);

	let decision: RunAdmissionDecision = "PASS";
	let allowedSideEffects: readonly string[] = requestedSideEffects.filter(
		(effect) => SAFE_SIDE_EFFECTS.has(effect),
	);
	let deniedSideEffects: readonly RunAdmissionDeniedSideEffect[] =
		STANDARD_DENIED_SIDE_EFFECTS;
	let quarantine = false;
	let quarantineReason: string | undefined;
	let reasons: readonly string[] = [
		"Required repo/worktree/base evidence is present.",
		"Requested side effects are limited to declared local docs/fixture scope and verification commands.",
		"Remote, GitHub, production, and network mutation side effects are denied.",
	];
	let authorizedNextStep = "record_admission_only";

	if (missingEvidence.length > 0) {
		decision = "INSUFFICIENT_EVIDENCE";
		allowedSideEffects = [];
		deniedSideEffects = requestedSideEffects
			.filter((effect) => !READ_ONLY_SIDE_EFFECTS.has(effect))
			.map((effect) => ({
				effect,
				reason:
					"The kernel cannot grant side effects until required admission evidence is present.",
			}));
		reasons = [
			"Missing required evidence prevents repo/worktree/base binding.",
			"Missing evidence fails closed instead of becoming a PASS.",
		];
		authorizedNextStep = "capture_missing_evidence_then_recompute_admission";
	}

	if (unsafeRequests.length > 0) {
		decision = "UNSAFE_TO_RUN";
		missingEvidence = collectUnavailableRequiredEvidence(evidenceInputs);
		allowedSideEffects = requestedSideEffects.filter((effect) =>
			READ_ONLY_SIDE_EFFECTS.has(effect),
		);
		deniedSideEffects = buildUnsafeDeniedSideEffects(requestedSideEffects);
		quarantine = true;
		quarantineReason =
			"Unsafe requested side effects require explicit release authority.";
		reasons = [
			"Requested side effects include remote, hosted-service, network, production, or otherwise unauthorized mutation.",
			"Unsafe requested side effects revoke non-read grants and freeze the bundle until explicit release authority exists.",
		];
		authorizedNextStep = "freeze_and_require_explicit_release_authority";
	}

	const policy: RunAdmissionPolicy = {
		profile_id: input.policyProfileId,
		allowed_side_effects: unique(allowedSideEffects),
		denied_side_effects: deniedSideEffects,
		capability_grants: buildCapabilityGrants(
			unique(allowedSideEffects),
			repo,
			request,
		),
		quarantine,
		...(quarantineReason ? { quarantine_reason: quarantineReason } : {}),
	};

	return {
		$schema: "https://buildplane.local/schemas/run-admission-receipt.v0.json",
		schema_version: "0.1.0",
		receipt_type: "run.admission",
		receipt_id: input.receiptId,
		run,
		repo,
		request,
		policy,
		evidence_inputs: evidenceInputs,
		admission: {
			decision,
			decided_by: actor,
			decided_at: input.decidedAt,
			reasons,
			missing_evidence: missingEvidence,
			unsafe_requests: unsafeRequests,
			will_execute_worker: false,
			authorized_next_step: authorizedNextStep,
		},
		idempotency_key: createIdempotencyKey({
			run,
			repo,
			request,
			evidenceInputs,
			policyProfileId: input.policyProfileId,
		}),
		replay: createReplay(decision, input.receiptId),
		provenance: {
			created_by: actor,
			created_from: source,
			redaction_policy:
				"Secrets are redacted as [REDACTED]; raw secret values are never stored.",
			pack: input.pack ?? null,
			host: input.host ?? null,
			provider: input.provider ?? null,
			worker_agent_trusted: false,
		},
	};
}

export async function recordRunAdmissionReceiptAttempt(
	input: RecordRunAdmissionReceiptAttemptInput,
): Promise<RunAdmissionReceiptAttemptRecord> {
	const receiptJson = stableJson(input.receipt);
	const receiptDigest = createReceiptDigest(receiptJson);
	const receiptArtifact = await input.store.writeReceiptArtifact({
		receipt: input.receipt,
		receiptDigest,
		contents: receiptJson,
	});
	const payload = createRecordedPayload({
		receipt: input.receipt,
		receiptDigest,
		receiptRef: receiptArtifact.ref,
	});
	const event: RunAdmissionRecordedEvent = {
		kind: "run_admission_recorded",
		schema_version: "0.1.0",
		recorded_at: input.recordedAt ?? input.receipt.admission.decided_at,
		payload,
		replay: createRecordedReplay(input.receipt),
	};
	const eventAppend = await input.store.appendAdmissionEvent({
		event,
		receipt: input.receipt,
	});
	return {
		receipt_json: receiptJson,
		receipt_digest: receiptDigest,
		receipt_ref: receiptArtifact.ref,
		...(receiptArtifact.path ? { receipt_path: receiptArtifact.path } : {}),
		payload,
		event,
		event_ref: eventAppend.ref,
		...(eventAppend.path ? { event_path: eventAppend.path } : {}),
	};
}
