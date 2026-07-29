import {
	canonicalActionRequestedV2Digest,
	canonicalSha256Digest,
	type DurableActionRequestV2,
	deriveGovernedCommandInputCommitmentV1,
	type GovernedDispatchLineageV3,
	type GrantedGovernedActivityClaimV1,
	inspectGovernedDispatchAuthorityWindowV1,
	parseNativeRfc3339Utc,
} from "@buildplane/kernel";

const MAX_ECMASCRIPT_EPOCH_MS = 8_640_000_000_000_000;
const ACTION_GATEWAY_ROLES = [
	"implementer",
	"reviewer",
	"adversary",
	"judge",
	"candidate",
] as const;

type GovernedPermitRole = (typeof ACTION_GATEWAY_ROLES)[number];

type PermitExecutableAction =
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
	  };

interface GovernedActionPermitRecord {
	readonly runId: string;
	readonly worktreeRoot: string;
	readonly role: GovernedPermitRole;
	readonly actionFingerprint: string;
	readonly dispatchEnvelopeDigest: string;
	readonly capabilityBundleDigest: string;
	readonly sandboxProfileDigest: string;
	readonly durableActionRequestDigest: string;
	readonly canonicalInputDigest: string;
	readonly idempotencyKey: string;
	readonly leaseId: string;
	readonly leaseExpiryOrderingNanos: bigint;
	readonly governedDeadlineAtMs: number;
}

/**
 * This map, rather than a structural TypeScript interface, is the authority
 * boundary. A caller can manufacture an object with every visible field, but
 * only this module can associate that object with a durable claim record.
 */
const claimBoundPermits = new WeakMap<object, GovernedActionPermitRecord>();
const consumedClaimBoundPermits = new WeakSet<object>();

/**
 * Internal-only mint input. The module is intentionally not re-exported from
 * the package entrypoint: governed workers may mint only after the durable
 * request and native activity claim are both available.
 */
export interface MintGovernedActionPermitInput {
	readonly runId: string;
	readonly worktreeRoot: string;
	readonly role: GovernedPermitRole;
	readonly action: PermitExecutableAction;
	readonly dispatch: GovernedDispatchLineageV3;
	readonly durableRequest: DurableActionRequestV2;
	readonly claim: GrantedGovernedActivityClaimV1;
	readonly capabilityBundleDigest: string;
	readonly sandboxProfileDigest: string;
	readonly governedDeadlineAtMs: number;
	readonly nowMs: number;
}

/**
 * Mint an opaque, one-use permit for exactly one already-claimed OCI action.
 * Every equality below is intentional: the worker is a caller of this seam,
 * never a source of authority.
 */
export function mintGovernedActionPermit(
	input: MintGovernedActionPermitInput,
): object {
	const runId = requireNonEmpty(input.runId, "permit run id");
	const worktreeRoot = requireNonEmpty(
		input.worktreeRoot,
		"permit worktree root",
	);
	const role = requireRole(input.role);
	const action = normalizeExecutableAction(input.action);
	if (action.kind !== "process.run") {
		throw new TypeError(
			"governed action permits currently require a durable command input commitment.",
		);
	}
	const capabilityBundleDigest = requireCanonicalDigest(
		input.capabilityBundleDigest,
		"permit capability bundle digest",
	);
	const sandboxProfileDigest = requireCanonicalDigest(
		input.sandboxProfileDigest,
		"permit sandbox profile digest",
	);
	const governedDeadlineAtMs = requireEpochMilliseconds(
		input.governedDeadlineAtMs,
		"permit governed deadline",
	);
	const nowMs = requireEpochMilliseconds(input.nowMs, "permit current time", {
		allowZero: true,
	});
	if (nowMs >= governedDeadlineAtMs) {
		throw new TypeError(
			"governed action permit deadline is exhausted before OCI dispatch.",
		);
	}

	const dispatch = input.dispatch;
	if (
		dispatch.schemaVersion !== 3 ||
		dispatch.runId !== runId ||
		dispatch.executionRole !== role ||
		dispatch.commitMode !== "atomic" ||
		dispatch.trustTier !== "governed" ||
		dispatch.actionEvidenceVersion !== "sealed_v3" ||
		dispatch.capabilityBundleDigest !== capabilityBundleDigest ||
		dispatch.sandboxProfileDigest !== sandboxProfileDigest
	) {
		throw new TypeError(
			"governed action permit does not match the signed V3 dispatch authority.",
		);
	}
	const dispatchEnvelopeDigest = requireCanonicalDigest(
		dispatch.envelopeDigest,
		"dispatch envelope digest",
	);
	assertCanonicalDispatchDigests(dispatch);
	const authorityWindow = inspectGovernedDispatchAuthorityWindowV1(
		dispatch,
		nowMs,
	);
	if (authorityWindow.state !== "active") {
		throw new TypeError(
			`governed action permit dispatch authority is ${authorityWindow.failure.replaceAll("-", " ")}.`,
		);
	}
	const deadlineTimestamp = timestampForEpoch(governedDeadlineAtMs);
	if (
		deadlineTimestamp === undefined ||
		deadlineTimestamp.orderingNanos > authorityWindow.effectiveDeadlineNanos
	) {
		throw new TypeError(
			"governed action permit deadline extends beyond the signed effective dispatch deadline.",
		);
	}

	const durableRequest = input.durableRequest;
	assertDurableRequest(durableRequest);
	const durableActionRequestDigest = requireCanonicalDigest(
		durableRequest.actionRequestDigest,
		"durable action request digest",
	);
	const request = durableRequest.actionRequest;
	const expectedCommandInput = deriveGovernedCommandInputCommitmentV1({
		runId,
		actionId: action.actionId,
		command: action.command,
		args: action.args,
		...(action.cwd === undefined ? {} : { cwd: action.cwd }),
	});
	if (
		request.runId !== runId ||
		request.workflowId !== dispatch.workflowId ||
		request.unitId !== dispatch.unitId ||
		request.attempt !== dispatch.attempt ||
		request.provenanceRef !== dispatch.provenanceRef ||
		request.actionId !== action.actionId ||
		request.actionKind !== "process" ||
		request.dispatchEnvelopeDigest !== dispatchEnvelopeDigest ||
		request.capabilityBundleDigest !== capabilityBundleDigest ||
		request.sandboxProfileDigest !== sandboxProfileDigest ||
		request.executionRole !== role ||
		request.governedPacketDigest !== dispatch.governedPacketDigest ||
		request.repositoryBindingDigest !== dispatch.repositoryBindingDigest ||
		request.ledgerAuthorityRealmDigest !==
			dispatch.ledgerAuthorityRealmDigest ||
		request.policyDigest !== dispatch.policyDigest ||
		request.contextManifestDigest !== dispatch.contextManifestDigest ||
		request.workerManifestDigest !== dispatch.workerManifestDigest ||
		request.authorityActor !== dispatch.authorityActor
	) {
		throw new TypeError(
			"governed action permit does not match the durable action request or signed dispatch.",
		);
	}
	if (
		request.canonicalInputDigest !== expectedCommandInput.digest ||
		request.canonicalInputRef !== expectedCommandInput.ref
	) {
		throw new TypeError(
			"governed action permit durable canonical input does not commit to the exact executable command.",
		);
	}
	const canonicalInputDigest = expectedCommandInput.digest;
	const idempotencyKey = requireNonEmpty(
		request.idempotencyKey,
		"durable action idempotency key",
	);
	const claim = input.claim;
	if (
		claim.state !== "granted" ||
		claim.activityId !== action.actionId ||
		claim.idempotencyKey !== idempotencyKey
	) {
		throw new TypeError(
			"governed action permit does not match the granted native activity claim.",
		);
	}
	const leaseId = requireNonEmpty(claim.leaseId, "activity claim lease id");
	requireNonEmpty(claim.claimEventId, "activity claim event id");
	requireCanonicalDigest(claim.claimEventDigest, "activity claim event digest");
	const leaseExpiresAt = parseNativeRfc3339Utc(claim.leaseExpiresAt);
	if (
		leaseExpiresAt === undefined ||
		!leaseAllowsAt(leaseExpiresAt.orderingNanos, nowMs)
	) {
		throw new TypeError(
			"governed action permit activity claim lease is expired before OCI dispatch.",
		);
	}

	const permit = Object.freeze(Object.create(null)) as object;
	claimBoundPermits.set(
		permit,
		Object.freeze({
			runId,
			worktreeRoot,
			role,
			actionFingerprint: expectedCommandInput.digest,
			dispatchEnvelopeDigest,
			capabilityBundleDigest,
			sandboxProfileDigest,
			durableActionRequestDigest,
			canonicalInputDigest,
			idempotencyKey,
			leaseId,
			leaseExpiryOrderingNanos: leaseExpiresAt.orderingNanos,
			governedDeadlineAtMs,
		}),
	);
	return permit;
}

/**
 * Validate and consume a permit immediately before an OCI effect. Returning a
 * denial string keeps gateway failures normal receipts while withholding every
 * internal binding from callers that do not own a valid permit.
 */
export function consumeGovernedActionPermit(input: {
	readonly permit: unknown;
	readonly runId: string;
	readonly worktreeRoot: string;
	readonly role: GovernedPermitRole;
	readonly action: PermitExecutableAction;
	readonly capabilityBundleDigest: string;
	readonly sandboxProfileDigest: string;
	readonly governedDeadlineAtMs: number;
	readonly nowMs: number;
	/**
	 * Worker-presented copy of the exact durable evidence that led to this OCI
	 * dispatch. It is not authority by itself; the opaque permit must agree.
	 */
	readonly evidence: unknown;
}): string | undefined {
	if (typeof input.permit !== "object" || input.permit === null) {
		return "governed actions require an exact unconsumed durable claim-bound permit";
	}
	const permit = input.permit;
	const record = claimBoundPermits.get(permit);
	if (record === undefined) {
		return "governed actions require an exact unconsumed durable claim-bound permit";
	}
	if (consumedClaimBoundPermits.has(permit)) {
		return "governed action claim-bound permit was already consumed";
	}

	let action: PermitExecutableAction;
	let role: GovernedPermitRole;
	let capabilityBundleDigest: string;
	let sandboxProfileDigest: string;
	let governedDeadlineAtMs: number;
	let nowMs: number;
	let evidence: PresentedGovernedActionEvidence;
	let actionCommitmentDigest: string;
	try {
		action = normalizeExecutableAction(input.action);
		if (action.kind !== "process.run") {
			return "governed action claim-bound permit has no durable command input commitment";
		}
		role = requireRole(input.role);
		capabilityBundleDigest = requireCanonicalDigest(
			input.capabilityBundleDigest,
			"permit capability bundle digest",
		);
		sandboxProfileDigest = requireCanonicalDigest(
			input.sandboxProfileDigest,
			"permit sandbox profile digest",
		);
		governedDeadlineAtMs = requireEpochMilliseconds(
			input.governedDeadlineAtMs,
			"permit governed deadline",
		);
		nowMs = requireEpochMilliseconds(input.nowMs, "permit current time", {
			allowZero: true,
		});
		evidence = parsePresentedGovernedActionEvidence(input.evidence);
		actionCommitmentDigest = deriveGovernedCommandInputCommitmentV1({
			runId: input.runId,
			actionId: action.actionId,
			command: action.command,
			args: action.args,
			...(action.cwd === undefined ? {} : { cwd: action.cwd }),
		}).digest;
	} catch {
		return "governed action claim-bound permit inputs are invalid";
	}

	if (
		record.runId !== input.runId ||
		record.worktreeRoot !== input.worktreeRoot ||
		record.role !== role ||
		record.actionFingerprint !== actionCommitmentDigest ||
		record.capabilityBundleDigest !== capabilityBundleDigest ||
		record.sandboxProfileDigest !== sandboxProfileDigest ||
		record.governedDeadlineAtMs !== governedDeadlineAtMs ||
		record.dispatchEnvelopeDigest !== evidence.dispatchEnvelopeDigest ||
		record.durableActionRequestDigest !== evidence.durableActionRequestDigest ||
		record.canonicalInputDigest !== evidence.canonicalInputDigest ||
		record.idempotencyKey !== evidence.idempotencyKey ||
		record.leaseId !== evidence.leaseId
	) {
		return "governed action claim-bound permit does not bind this OCI action";
	}
	if (nowMs >= record.governedDeadlineAtMs) {
		return "governed action claim-bound permit deadline is exhausted before OCI dispatch";
	}
	if (!leaseAllowsAt(record.leaseExpiryOrderingNanos, nowMs)) {
		return "governed action claim-bound permit lease is expired before OCI dispatch";
	}

	// Consume before calling the executor. A throw or crash after this point is
	// an unknown effect for reconciliation, never permission to retry locally.
	consumedClaimBoundPermits.add(permit);
	return undefined;
}

interface PresentedGovernedActionEvidence {
	readonly dispatchEnvelopeDigest: string;
	readonly durableActionRequestDigest: string;
	readonly canonicalInputDigest: string;
	readonly idempotencyKey: string;
	readonly leaseId: string;
}

function parsePresentedGovernedActionEvidence(
	input: unknown,
): PresentedGovernedActionEvidence {
	if (!isPlainDataRecord(input)) {
		throw new TypeError(
			"governed action permit evidence must be a plain data object",
		);
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const expectedKeys = new Set([
		"dispatchEnvelopeDigest",
		"durableActionRequestDigest",
		"canonicalInputDigest",
		"idempotencyKey",
		"leaseId",
	]);
	if (
		Object.keys(descriptors).length !== expectedKeys.size ||
		Object.keys(descriptors).some((key) => !expectedKeys.has(key))
	) {
		throw new TypeError(
			"governed action permit evidence must use the closed V1 schema",
		);
	}
	for (const descriptor of Object.values(descriptors)) {
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError(
				"governed action permit evidence cannot contain accessors",
			);
		}
	}
	const value = input as Record<string, unknown>;
	return Object.freeze({
		dispatchEnvelopeDigest: requireCanonicalDigest(
			value.dispatchEnvelopeDigest,
			"presented dispatch envelope digest",
		),
		durableActionRequestDigest: requireCanonicalDigest(
			value.durableActionRequestDigest,
			"presented durable action request digest",
		),
		canonicalInputDigest: requireCanonicalDigest(
			value.canonicalInputDigest,
			"presented canonical input digest",
		),
		idempotencyKey: requireNonEmpty(
			value.idempotencyKey,
			"presented action idempotency key",
		),
		leaseId: requireNonEmpty(value.leaseId, "presented activity lease id"),
	});
}

function assertDurableRequest(request: DurableActionRequestV2): void {
	const canonicalDigest = canonicalActionRequestedV2Digest(
		request.actionRequest,
	);
	if (
		request.actionRequestDigest !== canonicalDigest ||
		canonicalActionRequestedV2Digest(request.actionRequest) !== canonicalDigest
	) {
		throw new TypeError(
			"governed action permit durable request does not bind its canonical action request.",
		);
	}
	requireNonEmpty(request.actionRequestRef, "durable action request reference");
}

function assertCanonicalDispatchDigests(
	dispatch: GovernedDispatchLineageV3,
): void {
	for (const [label, digest] of Object.entries({
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
		requireCanonicalDigest(digest, `dispatch ${label}`);
	}
}

function normalizeExecutableAction(input: unknown): PermitExecutableAction {
	if (!isPlainDataRecord(input)) {
		throw new TypeError("permit action must be a plain data object");
	}
	const descriptors = Object.getOwnPropertyDescriptors(input);
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string") {
			throw new TypeError("permit action cannot contain symbol fields");
		}
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor)) {
			throw new TypeError("permit action cannot contain accessor fields");
		}
	}
	const action = input as Record<string, unknown>;
	const actionId = requireNonEmpty(action.actionId, "permit action id");
	if (action.kind === "process.run") {
		assertClosedKeys(descriptors, [
			"actionId",
			"kind",
			"command",
			"args",
			"cwd",
		]);
		const command = requireNonEmpty(action.command, "permit action command");
		const args =
			action.args === undefined ? undefined : normalizeStringArray(action.args);
		const cwd =
			action.cwd === undefined
				? undefined
				: requireNonEmpty(action.cwd, "permit action cwd");
		return Object.freeze({
			actionId,
			kind: "process.run" as const,
			command,
			...(args === undefined ? {} : { args: Object.freeze(args) }),
			...(cwd === undefined ? {} : { cwd }),
		});
	}
	if (action.kind === "filesystem.write") {
		assertClosedKeys(descriptors, ["actionId", "kind", "path", "content"]);
		return Object.freeze({
			actionId,
			kind: "filesystem.write" as const,
			path: requireNonEmpty(action.path, "permit action path"),
			content: requireString(action.content, "permit action content"),
		});
	}
	throw new TypeError("permit action kind is unsupported");
}

function assertClosedKeys(
	descriptors: PropertyDescriptorMap,
	allowed: readonly string[],
): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
		throw new TypeError("permit action contains an unknown field");
	}
}

function normalizeStringArray(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	) {
		throw new TypeError("permit action args must be a dense array of strings");
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0
	) {
		throw new TypeError("permit action args must be a dense array of strings");
	}
	const args: string[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)];
		if (
			!descriptor ||
			!("value" in descriptor) ||
			typeof descriptor.value !== "string"
		) {
			throw new TypeError(
				"permit action args must be a dense array of strings",
			);
		}
		args.push(descriptor.value);
	}
	for (const key of Reflect.ownKeys(descriptors)) {
		if (
			typeof key !== "string" ||
			(key !== "length" && !isArrayIndex(key, length))
		) {
			throw new TypeError(
				"permit action args must be a dense array of strings",
			);
		}
	}
	return args;
}

function leaseAllowsAt(
	leaseExpiryOrderingNanos: bigint,
	nowMs: number,
): boolean {
	if (nowMs >= MAX_ECMASCRIPT_EPOCH_MS) return false;
	const nowCeiling = timestampForEpoch(nowMs + 1);
	return (
		nowCeiling !== undefined &&
		leaseExpiryOrderingNanos > nowCeiling.orderingNanos
	);
}

function timestampForEpoch(
	value: number,
): ReturnType<typeof parseNativeRfc3339Utc> {
	try {
		return parseNativeRfc3339Utc(new Date(value).toISOString());
	} catch {
		return undefined;
	}
}

function requireEpochMilliseconds(
	value: unknown,
	label: string,
	options?: { readonly allowZero?: boolean },
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < (options?.allowZero ? 0 : 1) ||
		value > MAX_ECMASCRIPT_EPOCH_MS
	) {
		throw new TypeError(
			`${label} must be a ${options?.allowZero ? "non-negative" : "positive"} safe epoch-millisecond timestamp within the ECMAScript date range.`,
		);
	}
	return value;
}

function requireCanonicalDigest(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a canonical sha256 digest.`);
	}
	const canonical = canonicalSha256Digest(value);
	if (canonical !== value) {
		throw new TypeError(`${label} must be a canonical sha256 digest.`);
	}
	return canonical;
}

function requireRole(value: unknown): GovernedPermitRole {
	if (
		typeof value !== "string" ||
		!ACTION_GATEWAY_ROLES.includes(value as GovernedPermitRole)
	) {
		throw new TypeError("permit role is unsupported");
	}
	return value as GovernedPermitRole;
}

function requireNonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be non-empty.`);
	}
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a string.`);
	}
	return value;
}

function isPlainDataRecord(value: unknown): value is object {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}
