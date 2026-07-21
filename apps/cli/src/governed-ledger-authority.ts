import { isAbsolute } from "node:path";
import type {
	GovernedDispatchLineageV3,
	GovernedLedgerAuthorityRealmPort,
} from "@buildplane/kernel";
import type { TrustedGovernedLedgerBinary } from "./ledger-emit.js";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * A same-UID local process cannot safely host governed signing material. This
 * stable failure is intentionally shared by every production wrapper until a
 * separately authenticated authority-broker client replaces them.
 */
export const GOVERNED_AUTHORITY_BROKER_REQUIRED_CODE =
	"GOVERNED_AUTHORITY_BROKER_REQUIRED";

export const GOVERNED_AUTHORITY_BROKER_REQUIRED = `${GOVERNED_AUTHORITY_BROKER_REQUIRED_CODE}: local native authority subprocesses are disabled; governed execution requires an isolated external authority broker.`;

export interface TrustedGovernedLedgerAuthorityRealmV1 {
	readonly kind: "host-governed-ledger-authority-v1";
	readonly realmDigest: string;
	readonly ledgerWorkspace: string;
	readonly kernelActorId: string;
	readonly kernelKeyId: string;
	readonly kernelPublicKeyHash: string;
}

export interface GovernedLedgerAuthorityCommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}

export type GovernedLedgerAuthorityCommandRunner = (
	binary: string,
	args: readonly string[],
) => GovernedLedgerAuthorityCommandResult;

/**
 * Reserved shape for the broker-backed production resolver. A package-pinned
 * local binary is deliberately not a substitute for a broker with a distinct
 * authority identity, so this option is normalized but never spawned.
 */
export interface ResolveTrustedGovernedLedgerAuthorityRealmOptions {
	readonly trustedBinary?: TrustedGovernedLedgerBinary;
}

/**
 * Test seam only. This factory is deliberately named with the `__testOnly`
 * prefix and is not used by any production constructor; its runner output is
 * useful for parser tests but is never a production authority source.
 */
export interface TestOnlyGovernedLedgerAuthorityRealmOptions {
	readonly binary: string;
	readonly runner: GovernedLedgerAuthorityCommandRunner;
}

/**
 * Production resolution is fail-closed until an isolated authority-broker
 * client exists. In particular, it never spawns a local native binary under
 * the controller/raw-worker user identity.
 */
export function resolveTrustedGovernedLedgerAuthorityRealm(
	options: ResolveTrustedGovernedLedgerAuthorityRealmOptions = {},
): TrustedGovernedLedgerAuthorityRealmV1 {
	normalizeProductionAuthorityOptions(options);
	throw new Error(GOVERNED_AUTHORITY_BROKER_REQUIRED);
}

/** @internal Test-only parser/spawn seam; never use in production code. */
export function __testOnlyResolveGovernedLedgerAuthorityRealm(
	options: TestOnlyGovernedLedgerAuthorityRealmOptions,
): TrustedGovernedLedgerAuthorityRealmV1 {
	if (!options || typeof options !== "object") {
		throw new TypeError(
			"__testOnlyResolveGovernedLedgerAuthorityRealm requires a test configuration.",
		);
	}
	assertClosedOptionFields(options, "test governed ledger authority", [
		"binary",
		"runner",
	]);
	if (
		typeof options.binary !== "string" ||
		options.binary.trim().length === 0
	) {
		throw new TypeError(
			"test governed ledger authority binary must be a non-empty fixture label.",
		);
	}
	if (typeof options.runner !== "function") {
		throw new TypeError(
			"test governed ledger authority runner must be a function.",
		);
	}
	return resolveAuthorityRealmWithRunner(options.binary, options.runner);
}

function resolveAuthorityRealmWithRunner(
	binary: string,
	runner: GovernedLedgerAuthorityCommandRunner,
): TrustedGovernedLedgerAuthorityRealmV1 {
	const result = runner(binary, ["ledger", "governed-authority-v1"]);
	if (result.error || result.status !== 0) {
		const detail = [result.error, result.stderr, result.stdout]
			.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
			.join("\n")
			.slice(0, 8_192);
		throw new Error(
			`resolving host governed ledger authority failed${
				detail ? `: ${detail}` : ""
			}`,
		);
	}
	return parseAuthorityRealm(result.stdout);
}

/**
 * Construct the production kernel port from a freshly resolved native realm.
 * No caller-supplied realm object is accepted, because a structural realm
 * value is not proof that native replay actually verified it.
 */
export function createTrustedGovernedLedgerAuthorityRealmPort(
	options: ResolveTrustedGovernedLedgerAuthorityRealmOptions = {},
): GovernedLedgerAuthorityRealmPort {
	const captured = resolveTrustedGovernedLedgerAuthorityRealm(options);
	return createRealmPortFromVerifiedResolution(captured);
}

/** Kernel seam from one internally verified host realm handle. */
function createRealmPortFromVerifiedResolution(
	realm: TrustedGovernedLedgerAuthorityRealmV1,
): GovernedLedgerAuthorityRealmPort {
	const captured = assertRealm(realm);
	return Object.freeze({
		assertDispatchLedgerAuthorityRealm({
			dispatch,
		}: Parameters<
			GovernedLedgerAuthorityRealmPort["assertDispatchLedgerAuthorityRealm"]
		>[0]): void {
			if (
				!dispatch ||
				dispatch.schemaVersion !== 3 ||
				dispatch.ledgerAuthorityRealmDigest !== captured.realmDigest
			) {
				throw new Error(
					"governed dispatch does not bind the current host ledger authority realm; effects are blocked.",
				);
			}
		},
	});
}

export function assertDispatchUsesTrustedLedgerAuthorityRealm(
	dispatch: GovernedDispatchLineageV3,
	options: ResolveTrustedGovernedLedgerAuthorityRealmOptions = {},
): void {
	createTrustedGovernedLedgerAuthorityRealmPort(
		options,
	).assertDispatchLedgerAuthorityRealm({ dispatch });
}

function normalizeProductionAuthorityOptions(
	input: ResolveTrustedGovernedLedgerAuthorityRealmOptions,
): ResolveTrustedGovernedLedgerAuthorityRealmOptions {
	if (!input || typeof input !== "object") {
		throw new TypeError(
			"resolveTrustedGovernedLedgerAuthorityRealm requires an options object.",
		);
	}
	assertClosedOptionFields(input, "trusted governed ledger authority", [
		"trustedBinary",
	]);
	return input;
}

function assertClosedOptionFields(
	value: object,
	label: string,
	allowedFields: readonly string[],
): void {
	const allowed = new Set(allowedFields);
	for (const field of Object.getOwnPropertyNames(value)) {
		if (!allowed.has(field)) {
			throw new TypeError(`${label} contains unsupported field ${field}.`);
		}
	}
}

function parseAuthorityRealm(
	text: string,
): TrustedGovernedLedgerAuthorityRealmV1 {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new TypeError(
			`host governed ledger authority returned invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const record = closedRecord(raw, "host governed ledger authority", [
		"schema_version",
		"realm_digest",
		"ledger_workspace",
		"kernel_signer",
	]);
	if (record.schema_version !== 1) {
		throw new TypeError(
			"host governed ledger authority schema_version must be 1.",
		);
	}
	const signer = closedRecord(record.kernel_signer, "realm kernel_signer", [
		"actor_id",
		"key_id",
		"public_key_hash",
	]);
	const realm = Object.freeze({
		kind: "host-governed-ledger-authority-v1" as const,
		realmDigest: requireDigest(record.realm_digest, "realm_digest"),
		ledgerWorkspace: requireAbsolutePath(
			record.ledger_workspace,
			"ledger_workspace",
		),
		kernelActorId: requireNonEmpty(signer.actor_id, "kernel_signer.actor_id"),
		kernelKeyId: requireNonEmpty(signer.key_id, "kernel_signer.key_id"),
		kernelPublicKeyHash: requireDigest(
			signer.public_key_hash,
			"kernel_signer.public_key_hash",
		),
	});
	return assertRealm(realm);
}

function assertRealm(
	realm: TrustedGovernedLedgerAuthorityRealmV1,
): TrustedGovernedLedgerAuthorityRealmV1 {
	if (!realm || realm.kind !== "host-governed-ledger-authority-v1") {
		throw new TypeError(
			"governed ledger authority realm identity is malformed.",
		);
	}
	if (!SHA256_DIGEST.test(realm.realmDigest)) {
		throw new TypeError(
			"governed ledger authority realm digest must be canonical sha256.",
		);
	}
	requireAbsolutePath(realm.ledgerWorkspace, "ledgerWorkspace");
	requireNonEmpty(realm.kernelActorId, "kernelActorId");
	requireNonEmpty(realm.kernelKeyId, "kernelKeyId");
	if (!SHA256_DIGEST.test(realm.kernelPublicKeyHash)) {
		throw new TypeError(
			"governed ledger authority kernel public-key hash must be canonical sha256.",
		);
	}
	return realm;
}

function closedRecord(
	value: unknown,
	label: string,
	fields: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set(fields);
	for (const key of Object.getOwnPropertyNames(record)) {
		if (!allowed.has(key)) {
			throw new TypeError(`${label} contains unknown field ${key}.`);
		}
	}
	for (const field of fields) {
		if (!(field in record)) {
			throw new TypeError(`${label} is missing required field ${field}.`);
		}
	}
	return record;
}

function requireDigest(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
		throw new TypeError(`${label} must be a canonical sha256 digest.`);
	}
	return value;
}

function requireAbsolutePath(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		!isAbsolute(value)
	) {
		throw new TypeError(`${label} must be a non-empty absolute path.`);
	}
	return value;
}

function requireNonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be non-empty.`);
	}
	return value;
}
