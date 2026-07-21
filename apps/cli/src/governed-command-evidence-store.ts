import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import type { GovernedCommandEvidenceStore } from "@buildplane/adapters-tools";
import type { ActionRedactionV2 } from "@buildplane/kernel";

type GovernedCommandCanonicalInput = Parameters<
	GovernedCommandEvidenceStore["persistCanonicalInput"]
>[0];
type GovernedCommandActionResult = Parameters<
	GovernedCommandEvidenceStore["persistActionResult"]
>[0];

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_REFERENCE_LENGTH = 4096;
const MAX_COMMAND_LENGTH = 64 * 1024;
const MAX_ARGUMENT_COUNT = 4096;
const MAX_ARGUMENT_LENGTH = 64 * 1024;
const MAX_TOTAL_ARGUMENT_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHECKS = 4096;
const MAX_TOTAL_OUTPUT_PATH_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const CAS_REFERENCE_PREFIX = "cas://governed-command-evidence/sha256/";
const HOST_EVIDENCE_DIRECTORY = ".buildplane-host-evidence";
const EVIDENCE_STORE_OPTION_FIELDS = ["projectRoot", "root"] as const;

type Artifact = {
	readonly digest: string;
	readonly ref: string;
};

type InputIdentity = {
	readonly runIdDigest: string;
	readonly actionIdDigest: string;
};

type ResultIdentity = InputIdentity & {
	readonly actionRequestRefDigest: string;
	readonly actionRequestDigest: string;
};

type SafeOutputCheck = {
	readonly pathDigest: string;
	readonly exists: boolean;
};

/**
 * Location of the host-owned evidence CAS. `projectRoot` identifies the
 * candidate/project boundary and is mandatory even when a dedicated `root`
 * volume is supplied. The root is always required to be outside that boundary
 * so an OCI workspace mount can never expose mutable evidence to a worker.
 */
export interface CreateGovernedCommandEvidenceStoreOptions {
	readonly projectRoot: string;
	/** Optional dedicated host artifact volume outside `projectRoot`. */
	readonly root?: string;
}

/**
 * Raised when an immutable identity has already been bound to different
 * bytes. Callers must reconcile the existing action rather than overwrite
 * or retry it with a new effect description.
 */
export class GovernedCommandEvidenceConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GovernedCommandEvidenceConflictError";
	}
}

/**
 * Creates the production host-owned evidence store for the first governed
 * command worker.
 *
 * The CAS never retains command text, arguments, cwd values, output paths,
 * stdout, or stderr. It persists only canonical SHA-256 commitments to those
 * values, identity commitments, result hashes, exit facts, and output
 * existence facts. Every immutable blob and identity binding is written via
 * an exclusive temporary file plus hard-link publication, so an existing
 * record can only be reused when its bytes are exactly equal.
 */
export function createGovernedCommandEvidenceStore(
	options: CreateGovernedCommandEvidenceStoreOptions,
): GovernedCommandEvidenceStore {
	const root = resolveEvidenceRoot(options);
	let tail: Promise<void> = Promise.resolve();

	function serialized<T>(operation: () => Promise<T>): Promise<T> {
		const next = tail.then(operation, operation);
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	return Object.freeze({
		persistCanonicalInput(input: GovernedCommandCanonicalInput) {
			return serialized(async () => {
				const normalized = normalizeCanonicalInput(input);
				const identity = inputIdentity(normalized.runId, normalized.actionId);
				const record = canonicalInputRecord(normalized, identity);
				const artifact = await writeContentAddressedRecord(root, record);
				await bindIdentity(root, inputIdentityBinding(identity, artifact));
				return {
					canonicalInputDigest: artifact.digest,
					canonicalInputRef: artifact.ref,
					redactions: inputRedactions(normalized),
				};
			});
		},

		persistActionResult(input: GovernedCommandActionResult) {
			return serialized(async () => {
				const normalized = normalizeActionResult(input);
				const identity = inputIdentity(normalized.runId, normalized.actionId);
				const canonicalInput = await requireInputBinding(root, identity);
				const requestIdentity = resultIdentity(normalized);
				const common = resultCommonRecord(
					normalized,
					identity,
					requestIdentity,
					canonicalInput,
				);
				const result =
					normalized.gatewayResult.outcome === "succeeded"
						? await writeContentAddressedRecord(root, {
								...common,
								recordKind: "governed_command_result_v1" as const,
							})
						: undefined;
				const evidence = await writeContentAddressedRecord(root, {
					...common,
					recordKind: "governed_command_evidence_v1" as const,
					...(result === undefined
						? {}
						: {
								resultDigest: result.digest,
								resultRef: result.ref,
							}),
				});
				await bindIdentity(
					root,
					resultRequestIdentityBinding(requestIdentity, evidence),
				);
				await bindIdentity(
					root,
					resultActionIdentityBinding(identity, evidence),
				);
				return {
					evidenceDigest: evidence.digest,
					evidenceRef: evidence.ref,
					...(result === undefined
						? {}
						: { resultDigest: result.digest, resultRef: result.ref }),
					redactions: resultRedactions(normalized),
				};
			});
		},
	});
}

function resolveEvidenceRoot(
	options: CreateGovernedCommandEvidenceStoreOptions,
): string {
	const record = readClosedStoreOptions(options);
	const projectRoot = requireExistingProjectRoot(record.projectRoot);
	const root =
		record.root === undefined
			? defaultHostEvidenceRoot(projectRoot)
			: requireHostEvidenceRoot(record.root, "root");
	assertEvidenceRootOutsideProject(projectRoot, root);
	return root;
}

function readClosedStoreOptions(
	options: CreateGovernedCommandEvidenceStoreOptions,
): Record<string, unknown> {
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		throw new TypeError(
			"createGovernedCommandEvidenceStore requires an explicit projectRoot.",
		);
	}
	const record = options as unknown as Record<string, unknown>;
	const allowed = new Set<string>(EVIDENCE_STORE_OPTION_FIELDS);
	for (const field of Object.getOwnPropertyNames(record)) {
		if (!allowed.has(field)) {
			throw new TypeError(
				`createGovernedCommandEvidenceStore contains unsupported field ${field}.`,
			);
		}
	}
	if (!Object.hasOwn(record, "projectRoot")) {
		throw new TypeError(
			"createGovernedCommandEvidenceStore requires an explicit projectRoot.",
		);
	}
	return record;
}

function requireExistingProjectRoot(value: unknown): string {
	const projectRoot = requireSafeAbsoluteDirectory(value, "projectRoot");
	if (!existsSync(projectRoot)) {
		throw new TypeError("projectRoot must name an existing directory.");
	}
	const stats = lstatSync(projectRoot);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new TypeError(
			"projectRoot must name an existing non-symbolic-link directory.",
		);
	}
	return realpathSync(projectRoot);
}

function requireHostEvidenceRoot(value: unknown, label: string): string {
	const root = requireSafeAbsoluteDirectory(value, label);
	if (!existsSync(root)) return root;
	const stats = lstatSync(root);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new TypeError(
			`${label} must name a non-symbolic-link directory when it exists.`,
		);
	}
	return realpathSync(root);
}

function defaultHostEvidenceRoot(projectRoot: string): string {
	const projectIdentity = digestHex(sha256Text(projectRoot));
	return safeDescendant(
		dirname(projectRoot),
		HOST_EVIDENCE_DIRECTORY,
		projectIdentity,
	);
}

function assertEvidenceRootOutsideProject(
	projectRoot: string,
	evidenceRoot: string,
): void {
	const relation = relative(projectRoot, evidenceRoot);
	if (
		relation.length === 0 ||
		(relation !== ".." &&
			!relation.startsWith(`..\\`) &&
			!relation.startsWith("../") &&
			!isAbsolute(relation))
	) {
		throw new TypeError(
			"governed command evidence root must be outside projectRoot; candidate mounts may never contain host-owned evidence.",
		);
	}
}

function requireSafeAbsoluteDirectory(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(
			`${label} must be a non-empty absolute directory path.`,
		);
	}
	if (
		value.includes("\0") ||
		hasTraversalSegment(value) ||
		!isAbsolute(value)
	) {
		throw new TypeError(
			`${label} must be an absolute path without traversal segments.`,
		);
	}
	const absolute = resolve(value);
	const parsed = parse(absolute);
	if (absolute === parsed.root) {
		throw new TypeError(`${label} must not be a filesystem root.`);
	}
	return absolute;
}

function hasTraversalSegment(value: string): boolean {
	return value.split(/[\\/]+/).some((segment) => segment === "..");
}

function normalizeCanonicalInput(
	input: Parameters<GovernedCommandEvidenceStore["persistCanonicalInput"]>[0],
): {
	readonly runId: string;
	readonly actionId: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
} {
	if (!input || typeof input !== "object") {
		throw new TypeError("canonical governed command input must be an object.");
	}
	const runId = requireOpaqueIdentifier(input.runId, "runId");
	const actionId = requireOpaqueIdentifier(input.actionId, "actionId");
	const command = requireBoundedString(
		input.command,
		"command",
		MAX_COMMAND_LENGTH,
		true,
	);
	if (!Array.isArray(input.args) || input.args.length > MAX_ARGUMENT_COUNT) {
		throw new TypeError("args must be a bounded array of command arguments.");
	}
	let argumentBytes = 0;
	const args = input.args.map((value, index) => {
		const argument = requireBoundedString(
			value,
			`args[${index}]`,
			MAX_ARGUMENT_LENGTH,
			false,
		);
		argumentBytes += Buffer.byteLength(argument, "utf8");
		if (argumentBytes > MAX_TOTAL_ARGUMENT_BYTES) {
			throw new TypeError(
				"args exceed the bounded aggregate command input size.",
			);
		}
		return argument;
	});
	const cwd =
		input.cwd === undefined
			? undefined
			: requireBoundedString(input.cwd, "cwd", MAX_COMMAND_LENGTH, false);
	return {
		runId,
		actionId,
		command,
		args,
		...(cwd === undefined ? {} : { cwd }),
	};
}

function normalizeActionResult(
	input: Parameters<GovernedCommandEvidenceStore["persistActionResult"]>[0],
): {
	readonly runId: string;
	readonly actionId: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
	readonly gatewayResult: {
		readonly outcome: "succeeded" | "failed" | "denied";
		readonly inputDigest: string;
		readonly resultDigest: string;
		readonly exitCode?: number;
	};
	readonly outputChecks: readonly SafeOutputCheck[];
} {
	if (!input || typeof input !== "object") {
		throw new TypeError("governed command action result must be an object.");
	}
	const runId = requireOpaqueIdentifier(input.runId, "runId");
	const actionId = requireOpaqueIdentifier(input.actionId, "actionId");
	const actionRequestRef = requireOpaqueReference(
		input.actionRequestRef,
		"actionRequestRef",
	);
	const actionRequestDigest = requireSha256Digest(
		input.actionRequestDigest,
		"actionRequestDigest",
	);
	if (!input.gatewayResult || typeof input.gatewayResult !== "object") {
		throw new TypeError("gatewayResult must be a closed result object.");
	}
	const outcome = input.gatewayResult.outcome;
	if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "denied") {
		throw new TypeError(
			"gatewayResult.outcome must be succeeded, failed, or denied.",
		);
	}
	const inputDigest = requireSha256Digest(
		input.gatewayResult.inputDigest,
		"gatewayResult.inputDigest",
	);
	const resultDigest = requireSha256Digest(
		input.gatewayResult.resultDigest,
		"gatewayResult.resultDigest",
	);
	const exitCode =
		input.gatewayResult.exitCode === undefined
			? undefined
			: requireExitCode(input.gatewayResult.exitCode);
	if (
		!Array.isArray(input.outputChecks) ||
		input.outputChecks.length > MAX_OUTPUT_CHECKS
	) {
		throw new TypeError("outputChecks must be a bounded array.");
	}
	let outputPathBytes = 0;
	const outputChecks = input.outputChecks
		.map((check, index) => {
			if (!check || typeof check !== "object") {
				throw new TypeError(`outputChecks[${index}] must be an object.`);
			}
			const path = requireBoundedString(
				check.path,
				`outputChecks[${index}].path`,
				MAX_COMMAND_LENGTH,
				false,
			);
			outputPathBytes += Buffer.byteLength(path, "utf8");
			if (outputPathBytes > MAX_TOTAL_OUTPUT_PATH_BYTES) {
				throw new TypeError(
					"outputChecks exceed the bounded aggregate output-path size.",
				);
			}
			if (typeof check.exists !== "boolean") {
				throw new TypeError(`outputChecks[${index}].exists must be boolean.`);
			}
			return { pathDigest: sha256Text(path), exists: check.exists };
		})
		.sort((left, right) => {
			if (left.pathDigest === right.pathDigest) return 0;
			return left.pathDigest < right.pathDigest ? -1 : 1;
		});
	for (let index = 1; index < outputChecks.length; index += 1) {
		if (
			outputChecks[index - 1]?.pathDigest === outputChecks[index]?.pathDigest
		) {
			throw new TypeError("outputChecks must not contain duplicate paths.");
		}
	}
	return {
		runId,
		actionId,
		actionRequestRef,
		actionRequestDigest,
		gatewayResult: {
			outcome,
			inputDigest,
			resultDigest,
			...(exitCode === undefined ? {} : { exitCode }),
		},
		outputChecks,
	};
}

function requireOpaqueIdentifier(value: unknown, label: string): string {
	return requireBoundedString(value, label, MAX_IDENTIFIER_LENGTH, true);
}

function requireOpaqueReference(value: unknown, label: string): string {
	return requireBoundedString(value, label, MAX_REFERENCE_LENGTH, true);
}

function requireBoundedString(
	value: unknown,
	label: string,
	maxLength: number,
	requireNonEmpty: boolean,
): string {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a string.`);
	}
	if (
		value.length > maxLength ||
		value.includes("\0") ||
		/[\r\n]/.test(value) ||
		(requireNonEmpty && value.trim().length === 0)
	) {
		throw new TypeError(`${label} is not a permitted bounded opaque string.`);
	}
	return value;
}

function requireSha256Digest(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
		throw new TypeError(`${label} must be a lowercase sha256 digest.`);
	}
	return value;
}

function requireExitCode(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < -2_147_483_648 ||
		value > 2_147_483_647
	) {
		throw new TypeError(
			"gatewayResult.exitCode must be a signed 32-bit integer.",
		);
	}
	return value;
}

function inputIdentity(runId: string, actionId: string): InputIdentity {
	return {
		runIdDigest: sha256Text(runId),
		actionIdDigest: sha256Text(actionId),
	};
}

function resultIdentity(input: {
	readonly runId: string;
	readonly actionId: string;
	readonly actionRequestRef: string;
	readonly actionRequestDigest: string;
}): ResultIdentity {
	return {
		...inputIdentity(input.runId, input.actionId),
		actionRequestRefDigest: sha256Text(input.actionRequestRef),
		actionRequestDigest: input.actionRequestDigest,
	};
}

function canonicalInputRecord(
	input: ReturnType<typeof normalizeCanonicalInput>,
	identity: InputIdentity,
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		recordKind: "governed_command_input_v1",
		runIdDigest: identity.runIdDigest,
		actionIdDigest: identity.actionIdDigest,
		commandDigest: sha256Text(input.command),
		argsDigest: sha256CanonicalValue(input.args),
		...(input.cwd === undefined ? {} : { cwdDigest: sha256Text(input.cwd) }),
	};
}

function resultCommonRecord(
	input: ReturnType<typeof normalizeActionResult>,
	identity: InputIdentity,
	requestIdentity: ResultIdentity,
	canonicalInput: Artifact,
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		runIdDigest: identity.runIdDigest,
		actionIdDigest: identity.actionIdDigest,
		actionRequestRefDigest: requestIdentity.actionRequestRefDigest,
		actionRequestDigest: requestIdentity.actionRequestDigest,
		canonicalInputDigest: canonicalInput.digest,
		canonicalInputRef: canonicalInput.ref,
		outcome: input.gatewayResult.outcome,
		gatewayInputDigest: input.gatewayResult.inputDigest,
		gatewayResultDigest: input.gatewayResult.resultDigest,
		...(input.gatewayResult.exitCode === undefined
			? {}
			: { exitCode: input.gatewayResult.exitCode }),
		outputChecks: input.outputChecks.map((check) => ({
			pathDigest: check.pathDigest,
			exists: check.exists,
		})),
	};
}

function inputRedactions(
	input: ReturnType<typeof normalizeCanonicalInput>,
): readonly ActionRedactionV2[] {
	return [
		{
			field: "command",
			reason: "host-owned command input is retained only as a digest",
			redactedDigest: sha256Text(input.command),
		},
		{
			field: "args",
			reason: "host-owned command arguments are retained only as a digest",
			redactedDigest: sha256CanonicalValue(input.args),
		},
		...(input.cwd === undefined
			? []
			: [
					{
						field: "cwd",
						reason: "host-owned working directory is retained only as a digest",
						redactedDigest: sha256Text(input.cwd),
					},
				]),
	];
}

function resultRedactions(
	input: ReturnType<typeof normalizeActionResult>,
): readonly ActionRedactionV2[] {
	return input.outputChecks.map((check, index) => ({
		field: `outputChecks[${index}].path`,
		reason: "output paths are retained only as digests",
		redactedDigest: check.pathDigest,
	}));
}

function inputIdentityBinding(
	identity: InputIdentity,
	artifact: Artifact,
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		recordKind: "governed_command_input_identity_v1",
		runIdDigest: identity.runIdDigest,
		actionIdDigest: identity.actionIdDigest,
		artifactDigest: artifact.digest,
		artifactRef: artifact.ref,
	};
}

function resultActionIdentityBinding(
	identity: InputIdentity,
	artifact: Artifact,
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		recordKind: "governed_command_result_action_identity_v1",
		runIdDigest: identity.runIdDigest,
		actionIdDigest: identity.actionIdDigest,
		artifactDigest: artifact.digest,
		artifactRef: artifact.ref,
	};
}

function resultRequestIdentityBinding(
	identity: ResultIdentity,
	artifact: Artifact,
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		recordKind: "governed_command_result_request_identity_v1",
		runIdDigest: identity.runIdDigest,
		actionIdDigest: identity.actionIdDigest,
		actionRequestRefDigest: identity.actionRequestRefDigest,
		actionRequestDigest: identity.actionRequestDigest,
		artifactDigest: artifact.digest,
		artifactRef: artifact.ref,
	};
}

async function requireInputBinding(
	root: string,
	identity: InputIdentity,
): Promise<Artifact> {
	const binding = inputIdentityBinding(identity, {
		digest: `sha256:${"0".repeat(64)}`,
		ref: `${CAS_REFERENCE_PREFIX}${"0".repeat(64)}`,
	});
	const path = identityPath(root, binding);
	const bytes = await readImmutableFile(path);
	if (bytes === undefined) {
		throw new GovernedCommandEvidenceConflictError(
			"governed command result has no durable canonical input for its run/action identity.",
		);
	}
	const artifact = parseInputIdentityBinding(bytes, identity);
	await requireCanonicalInputArtifact(root, artifact, identity);
	return artifact;
}

function parseInputIdentityBinding(
	bytes: Buffer,
	expected: InputIdentity,
): Artifact {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new GovernedCommandEvidenceConflictError(
			"canonical input identity binding is not valid JSON.",
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new GovernedCommandEvidenceConflictError(
			"canonical input identity binding has an invalid shape.",
		);
	}
	const record = value as Record<string, unknown>;
	if (
		record.schemaVersion !== 1 ||
		record.recordKind !== "governed_command_input_identity_v1" ||
		record.runIdDigest !== expected.runIdDigest ||
		record.actionIdDigest !== expected.actionIdDigest
	) {
		throw new GovernedCommandEvidenceConflictError(
			"canonical input identity binding does not match the requested run/action identity.",
		);
	}
	const digest = requireSha256Digest(
		record.artifactDigest,
		"input artifact digest",
	);
	const ref = requireCasReference(
		record.artifactRef,
		digest,
		"input artifact reference",
	);
	return { digest, ref };
}

async function requireCanonicalInputArtifact(
	root: string,
	artifact: Artifact,
	expected: InputIdentity,
): Promise<void> {
	const bytes = await readImmutableFile(
		contentAddressedPath(root, artifact.digest),
	);
	if (bytes === undefined || sha256Bytes(bytes) !== artifact.digest) {
		throw new GovernedCommandEvidenceConflictError(
			"canonical input identity binding does not resolve to its content-addressed blob.",
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new GovernedCommandEvidenceConflictError(
			"canonical input blob is not valid JSON.",
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new GovernedCommandEvidenceConflictError(
			"canonical input blob has an invalid shape.",
		);
	}
	const record = value as Record<string, unknown>;
	assertClosedKeys(record, [
		"schemaVersion",
		"recordKind",
		"runIdDigest",
		"actionIdDigest",
		"commandDigest",
		"argsDigest",
		"cwdDigest",
	]);
	if (
		record.schemaVersion !== 1 ||
		record.recordKind !== "governed_command_input_v1" ||
		record.runIdDigest !== expected.runIdDigest ||
		record.actionIdDigest !== expected.actionIdDigest
	) {
		throw new GovernedCommandEvidenceConflictError(
			"canonical input blob does not match the requested run/action identity.",
		);
	}
	requireSha256Digest(record.commandDigest, "canonical input command digest");
	requireSha256Digest(record.argsDigest, "canonical input args digest");
	if (record.cwdDigest !== undefined) {
		requireSha256Digest(record.cwdDigest, "canonical input cwd digest");
	}
}

function assertClosedKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
): void {
	if (Object.keys(record).some((key) => !allowed.includes(key))) {
		throw new GovernedCommandEvidenceConflictError(
			"immutable evidence record contains unsupported fields.",
		);
	}
}

async function bindIdentity(
	root: string,
	record: Record<string, unknown>,
): Promise<void> {
	const path = identityPath(root, record);
	await writeImmutableFile(path, canonicalRecordBytes(record));
}

function identityPath(root: string, record: Record<string, unknown>): string {
	const identityDigest = sha256CanonicalValue(identityLocator(record));
	const hex = digestHex(identityDigest);
	return safeDescendant(
		root,
		"identities",
		"sha256",
		hex.slice(0, 2),
		`${hex}.json`,
	);
}

function identityLocator(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const recordKind = record.recordKind;
	const runIdDigest = record.runIdDigest;
	const actionIdDigest = record.actionIdDigest;
	if (
		typeof recordKind !== "string" ||
		typeof runIdDigest !== "string" ||
		typeof actionIdDigest !== "string"
	) {
		throw new TypeError(
			"identity record is missing its immutable identity fields.",
		);
	}
	return {
		recordKind,
		runIdDigest,
		actionIdDigest,
		...(record.actionRequestRefDigest === undefined
			? {}
			: { actionRequestRefDigest: record.actionRequestRefDigest }),
		...(record.actionRequestDigest === undefined
			? {}
			: { actionRequestDigest: record.actionRequestDigest }),
	};
}

async function writeContentAddressedRecord(
	root: string,
	record: Record<string, unknown>,
): Promise<Artifact> {
	const bytes = canonicalRecordBytes(record);
	const digest = sha256Bytes(bytes);
	const path = contentAddressedPath(root, digest);
	await writeImmutableFile(path, bytes);
	return { digest, ref: `${CAS_REFERENCE_PREFIX}${digestHex(digest)}` };
}

function contentAddressedPath(root: string, digest: string): string {
	const hex = digestHex(digest);
	return safeDescendant(
		root,
		"blobs",
		"sha256",
		hex.slice(0, 2),
		`${hex}.json`,
	);
}

function canonicalRecordBytes(record: Record<string, unknown>): Buffer {
	const json = JSON.stringify(record);
	if (json === undefined) {
		throw new TypeError("evidence record must be JSON serializable.");
	}
	const bytes = Buffer.from(json, "utf8");
	if (bytes.length > MAX_RECORD_BYTES) {
		throw new TypeError("evidence record exceeds the bounded CAS record size.");
	}
	return bytes;
}

async function writeImmutableFile(path: string, bytes: Buffer): Promise<void> {
	const directory = dirname(path);
	await ensureSecureDirectory(directory);
	const existing = await readImmutableFile(path);
	if (existing !== undefined) {
		assertSameImmutableBytes(path, existing, bytes);
		return;
	}

	const temporary = safeDescendant(
		directory,
		`.tmp-${process.pid}-${randomUUID()}.json`,
	);
	let temporaryCreated = false;
	try {
		const handle = await open(temporary, "wx", 0o600);
		temporaryCreated = true;
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temporary, path);
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
		}
		const published = await readImmutableFile(path);
		if (published === undefined) {
			throw new GovernedCommandEvidenceConflictError(
				"immutable evidence publication did not produce a readable record.",
			);
		}
		assertSameImmutableBytes(path, published, bytes);
	} finally {
		if (temporaryCreated) {
			await unlink(temporary).catch((error: unknown) => {
				if (!isNotFoundError(error)) throw error;
			});
		}
	}
}

async function readImmutableFile(path: string): Promise<Buffer | undefined> {
	await ensureSecureDirectory(dirname(path));
	let before: Stats;
	try {
		before = await lstat(path);
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw error;
	}
	if (before.isSymbolicLink() || !before.isFile()) {
		throw new GovernedCommandEvidenceConflictError(
			"evidence store refused a symbolic-link or non-regular immutable record.",
		);
	}
	if (before.size > MAX_RECORD_BYTES) {
		throw new GovernedCommandEvidenceConflictError(
			"evidence store refused an oversized immutable record.",
		);
	}
	const bytes = await readFile(path);
	const after = await lstat(path);
	if (
		after.isSymbolicLink() ||
		!after.isFile() ||
		!sameFileIdentity(before, after) ||
		bytes.length !== after.size
	) {
		throw new GovernedCommandEvidenceConflictError(
			"evidence store detected an immutable record replacement while reading.",
		);
	}
	return bytes;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function assertSameImmutableBytes(
	path: string,
	existing: Buffer,
	expected: Buffer,
): void {
	if (!existing.equals(expected)) {
		throw new GovernedCommandEvidenceConflictError(
			`immutable evidence conflict at ${path}; an identity or digest is already bound to different content.`,
		);
	}
}

async function ensureSecureDirectory(path: string): Promise<void> {
	const absolute = resolve(path);
	const parsed = parse(absolute);
	const parts = relative(parsed.root, absolute)
		.split(/[\\/]+/)
		.filter(Boolean);
	let current = parsed.root;
	for (const part of parts) {
		current = resolve(current, part);
		let stat: Stats;
		try {
			stat = await lstat(current);
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
			await mkdir(current, { mode: 0o700 });
			stat = await lstat(current);
		}
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new GovernedCommandEvidenceConflictError(
				"evidence store refused a symbolic-link or non-directory path component.",
			);
		}
	}
}

function safeDescendant(root: string, ...segments: readonly string[]): string {
	const target = resolve(root, ...segments);
	const relation = relative(root, target);
	if (
		relation.length === 0 ||
		relation === ".." ||
		relation.startsWith(`..\\`) ||
		relation.startsWith("../") ||
		isAbsolute(relation)
	) {
		throw new TypeError("evidence store path escaped its configured root.");
	}
	return target;
}

function digestHex(digest: string): string {
	return requireSha256Digest(digest, "digest").slice("sha256:".length);
}

function requireCasReference(
	value: unknown,
	digest: string,
	label: string,
): string {
	if (
		typeof value !== "string" ||
		value !== `${CAS_REFERENCE_PREFIX}${digestHex(digest)}`
	) {
		throw new GovernedCommandEvidenceConflictError(
			`${label} does not match its immutable CAS digest.`,
		);
	}
	return value;
}

function sha256Text(value: string): string {
	return sha256Bytes(Buffer.from(value, "utf8"));
}

function sha256CanonicalValue(value: unknown): string {
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new TypeError("canonical evidence value must be JSON serializable.");
	}
	return sha256Text(json);
}

function sha256Bytes(value: Uint8Array): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "ENOENT"
	);
}

function isAlreadyExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "EEXIST"
	);
}
