import { createHash } from "node:crypto";

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_COMMAND_LENGTH = 64 * 1024;
const MAX_ARGUMENT_COUNT = 4096;
const MAX_ARGUMENT_LENGTH = 64 * 1024;
const MAX_TOTAL_ARGUMENT_BYTES = 1024 * 1024;

export const GOVERNED_COMMAND_INPUT_CAS_REFERENCE_PREFIX =
	"cas://governed-command-evidence/sha256/";

export interface GovernedCommandInputCommitmentInputV1 {
	readonly runId: string;
	readonly actionId: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
}

export interface NormalizedGovernedCommandInputV1 {
	readonly runId: string;
	readonly actionId: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

export interface GovernedCommandInputCommitmentV1 {
	readonly normalizedInput: NormalizedGovernedCommandInputV1;
	readonly record: Readonly<Record<string, unknown>>;
	readonly bytes: Uint8Array;
	readonly digest: string;
	readonly ref: string;
}

/**
 * Derive the exact immutable CAS record used by governed command evidence.
 * This is deliberately shared by the host evidence store and the action
 * gateway: a signed ActionRequestedV2 canonicalInputDigest therefore commits
 * to the same normalized executable command that OCI receives.
 */
export function deriveGovernedCommandInputCommitmentV1(
	input: GovernedCommandInputCommitmentInputV1,
): GovernedCommandInputCommitmentV1 {
	const normalizedInput = normalizeGovernedCommandInputCommitmentV1(input);
	const record = Object.freeze({
		schemaVersion: 1,
		recordKind: "governed_command_input_v1",
		runIdDigest: sha256Text(normalizedInput.runId),
		actionIdDigest: sha256Text(normalizedInput.actionId),
		commandDigest: sha256Text(normalizedInput.command),
		argsDigest: sha256CanonicalValue(normalizedInput.args),
		...(normalizedInput.cwd === undefined
			? {}
			: { cwdDigest: sha256Text(normalizedInput.cwd) }),
	});
	const bytes = new TextEncoder().encode(JSON.stringify(record));
	const digest = sha256Bytes(bytes);
	return Object.freeze({
		normalizedInput,
		record,
		bytes,
		digest,
		ref: `${GOVERNED_COMMAND_INPUT_CAS_REFERENCE_PREFIX}${digest.slice("sha256:".length)}`,
	});
}

export function normalizeGovernedCommandInputCommitmentV1(
	input: GovernedCommandInputCommitmentInputV1,
): NormalizedGovernedCommandInputV1 {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError("canonical governed command input must be an object.");
	}
	const runId = requireBoundedString(
		input.runId,
		"runId",
		MAX_IDENTIFIER_LENGTH,
		true,
	);
	const actionId = requireBoundedString(
		input.actionId,
		"actionId",
		MAX_IDENTIFIER_LENGTH,
		true,
	);
	const command = requireBoundedString(
		input.command,
		"command",
		MAX_COMMAND_LENGTH,
		true,
	);
	const sourceArgs = input.args === undefined ? [] : input.args;
	if (!Array.isArray(sourceArgs) || sourceArgs.length > MAX_ARGUMENT_COUNT) {
		throw new TypeError("args must be a bounded array of command arguments.");
	}
	let argumentBytes = 0;
	const args = sourceArgs.map((value, index) => {
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
	return Object.freeze({
		runId,
		actionId,
		command,
		args: Object.freeze(args),
		...(cwd === undefined ? {} : { cwd }),
	});
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

function sha256Text(value: string): string {
	return sha256Bytes(new TextEncoder().encode(value));
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
