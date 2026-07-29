/**
 * Fail-closed command boundary for the Trust Spine release campaign.
 *
 * This command accepts only a bundle file path and an explicit release SHA.
 * It derives the report and gate inputs from a canonical, host-signed payload;
 * it never accepts a precomputed report, result, or caller-supplied key.
 */

import {
	createHash,
	createPublicKey,
	verify as verifySignature,
} from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
	computeTrustSpineEvaluationReport,
	evaluateTrustSpineReleaseGate,
	type TrustSpineCapabilityBaselineV1,
	type TrustSpineEvaluationReportV1,
	type TrustSpineReleaseGateResultV1,
	type TrustSpineTrialV1,
} from "./trust-spine-release-gate.js";

const TRUST_ROOT_PATH = fileURLToPath(
	new URL("../config/trust-spine-release-trust-root.json", import.meta.url),
);
const TRUST_ROOT_FORMAT = "buildplane.trust-spine.release-trust-root.v1";
const BUNDLE_FORMAT = "buildplane.trust-spine.release-campaign-bundle.v1";
const CAMPAIGN_FORMAT = "buildplane.trust-spine.release-campaign.v2";
const SIGNED_TAPE_FORMAT = "buildplane.signed-tape.v1";
const TAPE_ROOT_ALGORITHM = "sha256_linear";
const RELEASE_POLICY_DIGEST_DOMAIN =
	"buildplane.trust-spine.release-policy.v1\0";
const RELEASE_EVALUATION_EVIDENCE_V1_DIGEST_DOMAIN =
	"buildplane.release-evaluation-evidence.v1\0";
const RELEASE_EVALUATION_EVIDENCE_V1_EVENT_KIND =
	"release_evaluation_evidence_v1";
const RELEASE_EVALUATION_EVIDENCE_V1_SCHEMA_VERSION = 1;
const ID_SEPARATOR = String.fromCharCode(0);

type JsonRecord = Record<string, unknown>;

export interface TrustSpineReleaseTrustedHostV1 {
	readonly realm: string;
	readonly keyId: string;
	readonly actorId: string;
	readonly publicKeyHash: string;
	/** Raw 32-byte Ed25519 key, base64url encoded. */
	readonly publicKeyB64: string;
}

export interface TrustSpineReleaseTrustedTapeSignerV1 {
	readonly actorId: string;
	readonly keyId: string;
	readonly publicKeyHash: string;
	/** Raw 32-byte Ed25519 key, base64url encoded. */
	readonly publicKeyB64: string;
}

export interface TrustSpineReleasePolicyV1 {
	readonly expectedProviders: readonly string[];
	readonly expectedTrustTiers: readonly string[];
	readonly targetRef: string;
	readonly minimumTasksPerGroup: number;
	readonly maxCapabilityRegression: number;
	readonly baselineByGroup: Readonly<
		Record<string, TrustSpineCapabilityBaselineV1 | undefined>
	>;
	readonly requiredCheckNames: readonly string[];
}

export interface TrustSpineReleaseTrustRootV1 {
	readonly format: typeof TRUST_ROOT_FORMAT;
	readonly schemaVersion: 1;
	readonly maxCampaignAgeHours: number;
	readonly trustedHosts: readonly TrustSpineReleaseTrustedHostV1[];
	readonly trustedTapeSigners: readonly TrustSpineReleaseTrustedTapeSignerV1[];
	readonly trustedCheckpointSigners: readonly TrustSpineReleaseTrustedTapeSignerV1[];
	readonly releasePolicy: TrustSpineReleasePolicyV1 | null;
}

export interface TrustSpineReleaseCampaignEvaluationV1
	extends TrustSpineReleaseGateResultV1 {
	readonly report: TrustSpineEvaluationReportV1;
}

export interface TrustSpineReleaseCampaignEvaluationOptionsV1 {
	readonly releaseCommit: string;
	readonly releaseRef: string;
	readonly now?: number;
}

export interface TrustSpineReleaseGateCliIO {
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
	readonly now?: number;
}

class GateError extends Error {}
class UsageError extends GateError {}

interface HostBinding {
	readonly realm: string;
	readonly keyId: string;
	readonly actorId: string;
	readonly publicKeyHash: string;
}

interface TapeRoot {
	readonly tapeId: string;
	/**
	 * The run identifier carried inside the verified signed-tape export. This is
	 * deliberately distinct from the campaign-local label above: labels are
	 * convenient for presentation, but never create a new evidence namespace.
	 */
	readonly sourceRunId: string;
	readonly tapeRootHash: string;
	readonly verifiedEvents: ReadonlyMap<string, VerifiedTapeEvent>;
}

interface TapeSignerBinding {
	readonly actorId: string;
	readonly keyId: string;
	readonly publicKeyHash: string;
}

interface VerifiedTapeEvent {
	readonly eventId: string;
	readonly canonicalEventHash: string;
	readonly kind: string;
	readonly payload: JsonRecord;
}

interface ParsedTapeCanonicalEvent extends VerifiedTapeEvent {
	readonly runId: string;
	readonly parentEventId: string | null;
	readonly payload: JsonRecord;
}

interface VerifiedTapeCheckpoint {
	readonly eventId: string;
	readonly parentEventId: string | null;
	readonly checkpointIndex: number;
	readonly previousCheckpointEventId: string | null;
	readonly throughEventId: string;
	readonly throughEventCount: number;
	readonly tapeRootHash: string;
}

interface VerifiedSignedTape {
	readonly runId: string;
	readonly events: readonly VerifiedTapeEvent[];
	readonly checkpoints: readonly VerifiedTapeCheckpoint[];
}

type CampaignPolicy = TrustSpineReleasePolicyV1;

// These are the two GA worker/provider contracts. A release-policy signer may
// require additional providers later, but cannot silently omit either GA
// population and still certify a Trust Spine release.
const REQUIRED_GA_PROVIDERS = Object.freeze(["anthropic", "openai"]);
const MINIMUM_GA_TASKS_PER_GROUP = 30;
const MAXIMUM_GA_CAPABILITY_REGRESSION = 0.05;

type ReleaseEvaluationClaimKindV1 =
	| "trial"
	| "target_branch_immutability"
	| "backward_replay_compatibility"
	| "required_check";

interface ReleaseEvaluationSourceEventRefV1 {
	readonly sourceEventId: string;
	readonly sourceCanonicalEventHash: string;
}

interface ReleaseEvaluationTrialClaimV1 {
	readonly taskId: string;
	readonly provider: string;
	readonly trustTier: string;
	readonly trial: 1 | 2 | 3;
	readonly governance: "governed" | "raw";
	readonly passed: boolean;
	readonly costUsdMicros: number;
	readonly latencyMs: number;
	readonly tokens: number;
	readonly toolCalls: number;
	readonly candidateCount: number;
	readonly reviewerDisagreed: boolean;
	readonly falseApproval: boolean;
	readonly unauthorizedEffects: number;
	readonly duplicateEffects: number;
	readonly safetyViolations: number;
	readonly recoveryCorrect: boolean;
	readonly illegitimateSuccess: boolean;
	readonly sources: Readonly<{
		modelRequest: ReleaseEvaluationSourceEventRefV1;
		candidate: ReleaseEvaluationSourceEventRefV1;
		acceptance: ReleaseEvaluationSourceEventRefV1;
		review: ReleaseEvaluationSourceEventRefV1;
		recovery: ReleaseEvaluationSourceEventRefV1;
		terminal: ReleaseEvaluationSourceEventRefV1;
	}>;
}

interface ReleaseEvaluationTargetBranchImmutabilityClaimV1 {
	readonly immutable: boolean;
	readonly source: ReleaseEvaluationSourceEventRefV1;
}

interface ReleaseEvaluationBackwardReplayCompatibilityClaimV1 {
	readonly compatible: boolean;
	readonly source: ReleaseEvaluationSourceEventRefV1;
}

interface ReleaseEvaluationRequiredCheckClaimV1 {
	readonly name: string;
	readonly conclusion:
		| "success"
		| "failure"
		| "cancelled"
		| "skipped"
		| "timed_out"
		| "neutral"
		| "action_required";
	readonly source: ReleaseEvaluationSourceEventRefV1;
}

type ReleaseEvaluationClaimV1 =
	| ReleaseEvaluationTrialClaimV1
	| ReleaseEvaluationTargetBranchImmutabilityClaimV1
	| ReleaseEvaluationBackwardReplayCompatibilityClaimV1
	| ReleaseEvaluationRequiredCheckClaimV1;

interface ReleaseEvaluationEvidenceV1 {
	readonly schemaVersion: 1;
	readonly releaseCommit: string;
	readonly releaseRef: string;
	readonly policyDigest: string;
	readonly claimKind: ReleaseEvaluationClaimKindV1;
	readonly claim: ReleaseEvaluationClaimV1;
	readonly claimDigest: string;
}

interface ReleaseEvidenceBindings {
	readonly releaseCommit: string;
	readonly releaseRef: string;
	readonly policyDigest: string;
}

/**
 * Verify a bundle against an explicit root. Tests use this seam with generated
 * test keys; the command-line boundary below always reads the checked-in root.
 */
export function evaluateTrustSpineReleaseCampaignBundle(
	bundleValue: unknown,
	trustRootValue: unknown,
	options: TrustSpineReleaseCampaignEvaluationOptionsV1,
): TrustSpineReleaseCampaignEvaluationV1 {
	const releaseCommit = requireCommit(
		options.releaseCommit,
		"requested release",
	);
	const releaseRef = requireCanonicalReleaseRef(
		options.releaseRef,
		"requested release",
	);
	const root = parseTrustSpineReleaseTrustRoot(trustRootValue);
	const policy = root.releasePolicy;
	if (!policy) {
		throw new GateError("Pinned release policy is not configured.");
	}
	if (releaseRef !== policy.targetRef) {
		throw new GateError(
			"Requested release ref does not equal the pinned release policy target ref.",
		);
	}
	const payload = verifyBundle(bundleValue, root);
	verifyCampaignWindow(payload, root, options.now ?? Date.now());
	if (
		requireCommit(
			getString(payload, "releaseCommit", "campaign"),
			"campaign",
		) !== releaseCommit
	) {
		throw new GateError(
			"Campaign release commit does not equal the explicit requested release commit.",
		);
	}
	if (
		requireCanonicalReleaseRef(
			getString(payload, "releaseRef", "campaign"),
			"campaign",
		) !== releaseRef
	) {
		throw new GateError(
			"Campaign release ref does not equal the explicit requested release ref.",
		);
	}

	const policyDigest = computeTrustSpineReleasePolicyDigest(policy);
	if (getSha256(payload, "policyDigest", "campaign") !== policyDigest) {
		throw new GateError(
			"Campaign policy digest does not match the pinned release policy.",
		);
	}
	const bindings: ReleaseEvidenceBindings = Object.freeze({
		releaseCommit,
		releaseRef,
		policyDigest,
	});
	const roots = parseTapeRoots(
		getArray(payload, "tapeRoots", "campaign"),
		root,
	);
	const consumedEvidence = new Set<string>();
	const trials = deriveTrials(
		getArray(payload, "trials", "campaign"),
		roots,
		consumedEvidence,
		policy,
		bindings,
	);
	const invariants = deriveInvariants(
		getRecord(payload, "invariants", "campaign"),
		roots,
		consumedEvidence,
		policy,
		bindings,
	);
	const report = computeTrustSpineEvaluationReport(trials);
	const gate = evaluateTrustSpineReleaseGate(report, {
		expectedProviders: policy.expectedProviders,
		expectedTrustTiers: policy.expectedTrustTiers,
		minimumTasksPerGroup: policy.minimumTasksPerGroup,
		targetBranchImmutability: invariants.targetBranchImmutability,
		backwardReplayCompatible: invariants.backwardReplayCompatible,
		unresolvedRequiredChecks: invariants.unresolvedRequiredChecks,
		baselineByGroup: policy.baselineByGroup,
		maxCapabilityRegression: policy.maxCapabilityRegression,
	});
	return Object.freeze({ ...gate, report });
}

/**
 * Testable CLI facade. There is intentionally no --trust-root flag: a release
 * invocation can only use the source-controlled, checked-in root.
 */
export function runTrustSpineReleaseGateCli(
	argv: readonly string[],
	io: TrustSpineReleaseGateCliIO = {},
): number {
	const stdout = io.stdout ?? ((line: string) => console.log(line));
	const stderr = io.stderr ?? ((line: string) => console.error(line));
	try {
		const args = parseCliArgs(stripPnpmArgumentDelimiter(argv));
		const bundle = readBundleAtImmutablePath(args.bundlePath);
		const root = readPinnedTrustSpineReleaseTrustRoot();
		const result = evaluateTrustSpineReleaseCampaignBundle(bundle, root, {
			releaseCommit: args.releaseCommit,
			releaseRef: args.releaseRef,
			now: io.now,
		});
		const rendered = JSON.stringify(result, null, 2);
		if (!result.ready) {
			stderr(rendered);
			return 1;
		}
		stdout(rendered);
		return 0;
	} catch (error) {
		stderr(`trust-spine-release-gate: ${errorMessage(error)}`);
		return error instanceof UsageError ? 2 : 1;
	}
}

/** pnpm forwards an optional command delimiter as a literal argv entry. */
function stripPnpmArgumentDelimiter(
	argv: readonly string[],
): readonly string[] {
	return argv[0] === "--" ? argv.slice(1) : argv;
}

function parseCliArgs(argv: readonly string[]): {
	readonly bundlePath: string;
	readonly releaseCommit: string;
	readonly releaseRef: string;
} {
	let bundlePath: string | undefined;
	let releaseCommit: string | undefined;
	let releaseRef: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--bundle") {
			if (bundlePath !== undefined || !argv[index + 1]) {
				throw usage();
			}
			bundlePath = argv[++index];
			continue;
		}
		if (argument === "--commit") {
			if (releaseCommit !== undefined || !argv[index + 1]) {
				throw usage();
			}
			releaseCommit = argv[++index];
			continue;
		}
		if (argument === "--ref") {
			if (releaseRef !== undefined || !argv[index + 1]) {
				throw usage();
			}
			releaseRef = argv[++index];
			continue;
		}
		throw usage();
	}
	if (!bundlePath || !releaseCommit || !releaseRef) {
		throw usage();
	}
	if (!isAbsolute(bundlePath)) {
		throw new UsageError("--bundle must be an absolute immutable bundle path.");
	}
	return {
		bundlePath,
		releaseCommit: requireCommit(releaseCommit, "requested release"),
		releaseRef: requireCanonicalReleaseRef(releaseRef, "requested release"),
	};
}

function usage(): UsageError {
	return new UsageError(
		"usage: trust-spine-release-gate --bundle <absolute-path> --commit <exact-sha> --ref <canonical-ref>",
	);
}

function readBundleAtImmutablePath(path: string): unknown {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		throw new UsageError(
			`Unable to read campaign bundle: ${errorMessage(error)}`,
		);
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new UsageError("--bundle must name a regular, non-symlinked file.");
	}
	return readJson(path, "campaign bundle");
}

function readJson(path: string, label: string): unknown {
	try {
		const source = readFileSync(path, "utf8");
		assertNoDuplicateJsonKeys(source, label);
		return JSON.parse(source);
	} catch (error) {
		throw new GateError(`Unable to read ${label}: ${errorMessage(error)}`);
	}
}

/**
 * JSON.parse retains only the last occurrence of a duplicate object key. Reject
 * duplicates before parsing so the signer, reviewer, and gate all see the same
 * artifact.
 */
function assertNoDuplicateJsonKeys(source: string, label: string): void {
	let index = 0;
	const fail = (message: string): never => {
		throw new GateError(`${label} ${message} at byte ${index}.`);
	};
	const skipWhitespace = (): void => {
		while (index < source.length && " \t\r\n".includes(source[index])) {
			index += 1;
		}
	};
	const parseString = (): string => {
		const start = index;
		if (source[index] !== '"') {
			return fail("expected a JSON string");
		}
		index += 1;
		while (index < source.length) {
			const character = source[index++];
			if (character === '"') {
				try {
					const parsed = JSON.parse(source.slice(start, index));
					if (typeof parsed !== "string") {
						return fail("contains an invalid JSON string");
					}
					return parsed;
				} catch {
					return fail("contains an invalid JSON string");
				}
			}
			if (character === "\\") {
				if (index >= source.length) {
					return fail("contains an unterminated JSON escape");
				}
				const escaped = source[index++];
				if (escaped === "u") {
					for (let offset = 0; offset < 4; offset += 1) {
						const hex = source[index++];
						if (!hex || !/[0-9a-fA-F]/.test(hex)) {
							return fail("contains an invalid unicode escape");
						}
					}
				}
			} else if (character < " ") {
				return fail("contains an invalid control character");
			}
		}
		return fail("contains an unterminated JSON string");
	};
	const parseLiteral = (literal: string): void => {
		if (source.slice(index, index + literal.length) !== literal) {
			fail("contains invalid JSON");
		}
		index += literal.length;
	};
	const parseNumber = (): void => {
		const start = index;
		while (index < source.length && "0123456789+-.eE".includes(source[index])) {
			index += 1;
		}
		if (start === index) {
			fail("contains invalid JSON");
		}
	};
	const parseValue = (): void => {
		skipWhitespace();
		const character = source[index];
		if (character === "{") {
			index += 1;
			skipWhitespace();
			const keys = new Set<string>();
			if (source[index] === "}") {
				index += 1;
				return;
			}
			while (true) {
				skipWhitespace();
				const key = parseString();
				if (keys.has(key)) {
					throw new GateError(
						`${label} contains duplicate JSON key ${JSON.stringify(key)}.`,
					);
				}
				keys.add(key);
				skipWhitespace();
				if (source[index] !== ":") {
					fail("contains invalid JSON");
				}
				index += 1;
				parseValue();
				skipWhitespace();
				if (source[index] === "}") {
					index += 1;
					return;
				}
				if (source[index] !== ",") {
					fail("contains invalid JSON");
				}
				index += 1;
			}
		}
		if (character === "[") {
			index += 1;
			skipWhitespace();
			if (source[index] === "]") {
				index += 1;
				return;
			}
			while (true) {
				parseValue();
				skipWhitespace();
				if (source[index] === "]") {
					index += 1;
					return;
				}
				if (source[index] !== ",") {
					fail("contains invalid JSON");
				}
				index += 1;
			}
		}
		if (character === '"') {
			parseString();
			return;
		}
		if (character === "t") {
			parseLiteral("true");
			return;
		}
		if (character === "f") {
			parseLiteral("false");
			return;
		}
		if (character === "n") {
			parseLiteral("null");
			return;
		}
		parseNumber();
	};

	parseValue();
	skipWhitespace();
	if (index !== source.length) {
		fail("contains trailing JSON data");
	}
}

/**
 * Reads and closes the source-controlled release root used by every campaign
 * verification. Operator tooling may inspect this public projection, but can
 * never select a different root for a release decision.
 */
export function readPinnedTrustSpineReleaseTrustRoot(): TrustSpineReleaseTrustRootV1 {
	return parseTrustSpineReleaseTrustRoot(
		readJson(TRUST_ROOT_PATH, "pinned trust root"),
	);
}

export function parseTrustSpineReleaseTrustRoot(
	value: unknown,
): TrustSpineReleaseTrustRootV1 {
	const root = asRecord(value, "trust root");
	validateKeys(
		root,
		[
			"format",
			"schemaVersion",
			"maxCampaignAgeHours",
			"trustedHosts",
			"trustedTapeSigners",
			"trustedCheckpointSigners",
			"releasePolicy",
		],
		"trust root",
	);
	if (getString(root, "format", "trust root") !== TRUST_ROOT_FORMAT) {
		throw new GateError("Pinned trust root format is not recognized.");
	}
	if (getInteger(root, "schemaVersion", "trust root") !== 1) {
		throw new GateError("Pinned trust root schema version is not supported.");
	}
	const maxCampaignAgeHours = getFiniteNumber(
		root,
		"maxCampaignAgeHours",
		"trust root",
	);
	if (maxCampaignAgeHours <= 0) {
		throw new GateError(
			"Pinned trust root maxCampaignAgeHours must be positive.",
		);
	}
	const identities = new Set<string>();
	const trustedHosts = getArray(root, "trustedHosts", "trust root").map(
		(entry, index) => {
			const host = parseTrustedHost(entry, `trust root trustedHosts[${index}]`);
			const identity = hostIdentity(host);
			if (identities.has(identity)) {
				throw new GateError(
					"Pinned trust root contains a duplicate host binding.",
				);
			}
			identities.add(identity);
			return host;
		},
	);
	const tapeSignerIdentities = new Set<string>();
	const trustedTapeSigners = getArray(
		root,
		"trustedTapeSigners",
		"trust root",
	).map((entry, index) => {
		const signer = parseTrustedTapeSigner(
			entry,
			`trust root trustedTapeSigners[${index}]`,
		);
		const identity = tapeSignerIdentity(signer);
		if (tapeSignerIdentities.has(identity)) {
			throw new GateError(
				"Pinned trust root contains a duplicate tape signer binding.",
			);
		}
		tapeSignerIdentities.add(identity);
		return signer;
	});
	const checkpointSignerIdentities = new Set<string>();
	const tapeSignerPublicKeyHashes = new Set(
		trustedTapeSigners.map((signer) => signer.publicKeyHash),
	);
	const trustedCheckpointSigners = getArray(
		root,
		"trustedCheckpointSigners",
		"trust root",
	).map((entry, index) => {
		const signer = parseTrustedTapeSigner(
			entry,
			`trust root trustedCheckpointSigners[${index}]`,
		);
		const identity = tapeSignerIdentity(signer);
		if (checkpointSignerIdentities.has(identity)) {
			throw new GateError(
				"Pinned trust root contains a duplicate checkpoint signer binding.",
			);
		}
		if (tapeSignerPublicKeyHashes.has(signer.publicKeyHash)) {
			throw new GateError(
				"Pinned trust root may not share a raw key between tape and checkpoint signer roles.",
			);
		}
		checkpointSignerIdentities.add(identity);
		return signer;
	});
	const releasePolicy =
		root.releasePolicy === null
			? null
			: parseReleasePolicy(
					asRecord(root.releasePolicy, "pinned release policy"),
					"pinned release policy",
				);
	return Object.freeze({
		format: TRUST_ROOT_FORMAT,
		schemaVersion: 1,
		maxCampaignAgeHours,
		trustedHosts: Object.freeze(trustedHosts),
		trustedTapeSigners: Object.freeze(trustedTapeSigners),
		trustedCheckpointSigners: Object.freeze(trustedCheckpointSigners),
		releasePolicy,
	});
}

function parseTrustedHost(
	value: unknown,
	label: string,
): TrustSpineReleaseTrustedHostV1 {
	const host = asRecord(value, label);
	validateKeys(
		host,
		["realm", "keyId", "actorId", "publicKeyHash", "publicKeyB64"],
		label,
	);
	const binding = parseHostBinding(host, label);
	const publicKeyB64 = getString(host, "publicKeyB64", label);
	const raw = decodeBase64url(publicKeyB64, `${label}.publicKeyB64`);
	if (raw.length !== 32) {
		throw new GateError(
			`${label}.publicKeyB64 must encode a 32-byte Ed25519 key.`,
		);
	}
	if (sha256Hex(raw) !== binding.publicKeyHash) {
		throw new GateError(
			`${label}.publicKeyHash does not bind the configured key.`,
		);
	}
	return Object.freeze({ ...binding, publicKeyB64 });
}

function parseTrustedTapeSigner(
	value: unknown,
	label: string,
): TrustSpineReleaseTrustedTapeSignerV1 {
	const signer = asRecord(value, label);
	validateKeys(
		signer,
		["actorId", "keyId", "publicKeyHash", "publicKeyB64"],
		label,
	);
	const binding = parseTapeSignerBinding(signer, label);
	const publicKeyB64 = getString(signer, "publicKeyB64", label);
	const raw = decodeBase64url(publicKeyB64, `${label}.publicKeyB64`);
	if (raw.length !== 32) {
		throw new GateError(
			`${label}.publicKeyB64 must encode a 32-byte Ed25519 key.`,
		);
	}
	if (sha256Hex(raw) !== binding.publicKeyHash) {
		throw new GateError(
			`${label}.publicKeyHash does not bind the configured key.`,
		);
	}
	return Object.freeze({ ...binding, publicKeyB64 });
}

function verifyBundle(
	value: unknown,
	root: TrustSpineReleaseTrustRootV1,
): JsonRecord {
	const bundle = asRecord(value, "campaign bundle");
	validateKeys(
		bundle,
		["format", "schemaVersion", "payload", "attestation"],
		"campaign bundle",
	);
	if (getString(bundle, "format", "campaign bundle") !== BUNDLE_FORMAT) {
		throw new GateError("Campaign bundle format is not recognized.");
	}
	if (getInteger(bundle, "schemaVersion", "campaign bundle") !== 1) {
		throw new GateError("Campaign bundle schema version is not supported.");
	}
	const payload = getRecord(bundle, "payload", "campaign bundle");
	validateKeys(
		payload,
		[
			"format",
			"schemaVersion",
			"campaignId",
			"issuedAt",
			"expiresAt",
			"releaseCommit",
			"releaseRef",
			"policyDigest",
			"host",
			"tapeRoots",
			"trials",
			"invariants",
		],
		"campaign payload",
	);
	if (getString(payload, "format", "campaign payload") !== CAMPAIGN_FORMAT) {
		throw new GateError("Campaign payload format is not recognized.");
	}
	if (getInteger(payload, "schemaVersion", "campaign payload") !== 2) {
		throw new GateError("Campaign payload schema version is not supported.");
	}
	getString(payload, "campaignId", "campaign payload");
	const payloadHostValue = getRecord(payload, "host", "campaign payload");
	validateKeys(
		payloadHostValue,
		["realm", "keyId", "actorId", "publicKeyHash"],
		"campaign payload host",
	);
	const payloadHost = parseHostBinding(
		payloadHostValue,
		"campaign payload host",
	);
	const attestation = getRecord(bundle, "attestation", "campaign bundle");
	validateKeys(
		attestation,
		[
			"realm",
			"keyId",
			"actorId",
			"publicKeyHash",
			"algorithm",
			"payloadSha256",
			"signature",
		],
		"campaign attestation",
	);
	const attestationHost = parseHostBinding(attestation, "campaign attestation");
	if (!sameHostBinding(payloadHost, attestationHost)) {
		throw new GateError(
			"Campaign attestation host does not match the signed campaign host binding.",
		);
	}
	const trustedHost = root.trustedHosts.find((host) =>
		sameHostBinding(host, payloadHost),
	);
	if (!trustedHost) {
		throw new GateError(
			"Campaign host is not a trusted host in the pinned trust root.",
		);
	}
	if (
		getString(attestation, "algorithm", "campaign attestation") !== "ed25519"
	) {
		throw new GateError("Campaign attestation algorithm must be ed25519.");
	}
	const signedDocument = {
		format: BUNDLE_FORMAT,
		schemaVersion: 1,
		payload,
	};
	const canonical = Buffer.from(canonicalJson(signedDocument), "utf8");
	if (
		getSha256(attestation, "payloadSha256", "campaign attestation") !==
		sha256Hex(canonical)
	) {
		throw new GateError("Campaign attestation payload hash does not match.");
	}
	const signature = decodeBase64url(
		getString(attestation, "signature", "campaign attestation"),
		"campaign attestation signature",
	);
	if (signature.length !== 64) {
		throw new GateError("Campaign attestation signature must be 64 bytes.");
	}
	let verified = false;
	try {
		verified = verifySignature(
			null,
			canonical,
			createPublicKey({
				key: {
					kty: "OKP",
					crv: "Ed25519",
					x: trustedHost.publicKeyB64,
				},
				format: "jwk",
			}),
			signature,
		);
	} catch {
		verified = false;
	}
	if (!verified) {
		throw new GateError(
			"Campaign attestation signature does not verify against the pinned host key.",
		);
	}
	return payload;
}

function verifyCampaignWindow(
	payload: JsonRecord,
	root: TrustSpineReleaseTrustRootV1,
	now: number,
): void {
	if (!Number.isFinite(now)) {
		throw new GateError("Release gate clock is invalid.");
	}
	const issuedAt = parseIsoTimestamp(
		getString(payload, "issuedAt", "campaign"),
		"issuedAt",
	);
	const expiresAt = parseIsoTimestamp(
		getString(payload, "expiresAt", "campaign"),
		"expiresAt",
	);
	if (issuedAt > now || expiresAt <= now) {
		throw new GateError("Campaign bundle is stale or not currently valid.");
	}
	if (expiresAt <= issuedAt) {
		throw new GateError("Campaign expiresAt must be after issuedAt.");
	}
	if (now - issuedAt > root.maxCampaignAgeHours * 60 * 60 * 1000) {
		throw new GateError("Campaign bundle exceeds the pinned maximum age.");
	}
}

function parseReleasePolicy(value: JsonRecord, label: string): CampaignPolicy {
	validateKeys(
		value,
		[
			"expectedProviders",
			"expectedTrustTiers",
			"targetRef",
			"minimumTasksPerGroup",
			"maxCapabilityRegression",
			"baselineByGroup",
			"requiredCheckNames",
		],
		label,
	);
	const expectedProviders = getStringArray(value, "expectedProviders", label);
	const expectedTrustTiers = getStringArray(value, "expectedTrustTiers", label);
	for (const provider of REQUIRED_GA_PROVIDERS) {
		if (!expectedProviders.includes(provider)) {
			throw new GateError(
				`${label}.expectedProviders must include GA provider ${provider}.`,
			);
		}
	}
	for (const valuePart of [...expectedProviders, ...expectedTrustTiers]) {
		if (valuePart.includes("/")) {
			throw new GateError(
				`${label} provider and trust-tier names may not contain a slash.`,
			);
		}
	}
	const targetRef = requireCanonicalReleaseRef(
		getString(value, "targetRef", label),
		`${label} targetRef`,
	);
	const minimumTasksPerGroup = getInteger(value, "minimumTasksPerGroup", label);
	if (minimumTasksPerGroup < MINIMUM_GA_TASKS_PER_GROUP) {
		throw new GateError(
			`${label} minimumTasksPerGroup must be at least ${MINIMUM_GA_TASKS_PER_GROUP} for GA.`,
		);
	}
	const maxCapabilityRegression = getFiniteNumber(
		value,
		"maxCapabilityRegression",
		label,
	);
	if (
		maxCapabilityRegression < 0 ||
		maxCapabilityRegression > MAXIMUM_GA_CAPABILITY_REGRESSION
	) {
		throw new GateError(
			`${label} maxCapabilityRegression must be between zero and ${MAXIMUM_GA_CAPABILITY_REGRESSION} for GA.`,
		);
	}
	const expectedGroups = new Set<string>();
	for (const provider of expectedProviders) {
		for (const tier of expectedTrustTiers) {
			expectedGroups.add(groupKey(provider, tier));
		}
	}
	const baselineByGroup = parseBaselines(
		getRecord(value, "baselineByGroup", label),
		expectedGroups,
		label,
	);
	return Object.freeze({
		expectedProviders,
		expectedTrustTiers,
		targetRef,
		minimumTasksPerGroup,
		maxCapabilityRegression,
		baselineByGroup,
		requiredCheckNames: getStringArray(value, "requiredCheckNames", label),
	});
}

export function computeTrustSpineReleasePolicyDigest(
	policy: TrustSpineReleasePolicyV1,
): string {
	return sha256Hex(
		Buffer.from(
			`${RELEASE_POLICY_DIGEST_DOMAIN}${canonicalJson(policy)}`,
			"utf8",
		),
	);
}

function parseBaselines(
	value: JsonRecord,
	expectedGroups: ReadonlySet<string>,
	policyLabel: string,
): Readonly<Record<string, TrustSpineCapabilityBaselineV1 | undefined>> {
	const actualGroups = Object.keys(value);
	if (actualGroups.length !== expectedGroups.size) {
		throw new GateError(
			`${policyLabel} baselineByGroup must contain exactly one baseline for every expected group.`,
		);
	}
	const baselines: Record<string, TrustSpineCapabilityBaselineV1> = {};
	for (const group of actualGroups) {
		if (!expectedGroups.has(group)) {
			throw new GateError(
				`${policyLabel} baselineByGroup contains an unknown group.`,
			);
		}
		const baselineLabel = `${policyLabel} baseline ${group}`;
		const baseline = asRecord(value[group], baselineLabel);
		validateKeys(baseline, ["passAt1", "passAll3"], baselineLabel);
		const passAt1 = getFiniteNumber(baseline, "passAt1", baselineLabel);
		const passAll3 = getFiniteNumber(baseline, "passAll3", baselineLabel);
		if (passAt1 < 0 || passAt1 > 1 || passAll3 < 0 || passAll3 > 1) {
			throw new GateError(
				`${baselineLabel} rates must be between zero and one.`,
			);
		}
		baselines[group] = Object.freeze({ passAt1, passAll3 });
	}
	for (const group of expectedGroups) {
		if (!Object.hasOwn(baselines, group)) {
			throw new GateError(
				`${policyLabel} baselineByGroup is missing ${group}.`,
			);
		}
	}
	return Object.freeze(baselines);
}

function parseTapeRoots(
	value: readonly unknown[],
	trustRoot: TrustSpineReleaseTrustRootV1,
): ReadonlyMap<string, TapeRoot> {
	if (value.length === 0) {
		throw new GateError("Campaign bundle has no verified tape roots.");
	}
	const roots = new Map<string, TapeRoot>();
	const sourceRunIds = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const label = `campaign tapeRoots[${index}]`;
		const root = asRecord(entry, label);
		validateKeys(
			root,
			["tapeId", "tapeRootHash", "throughEventId", "throughEventCount", "tape"],
			label,
		);
		const tapeId = getString(root, "tapeId", label);
		if (roots.has(tapeId)) {
			throw new GateError(`Campaign repeats tape root ${tapeId}.`);
		}
		const tapeRootHash = getSha256(root, "tapeRootHash", label);
		const throughEventId = getString(root, "throughEventId", label);
		const throughEventCount = getInteger(root, "throughEventCount", label);
		if (throughEventCount < 1) {
			throw new GateError(
				`Campaign tape root ${tapeId} has no verified events.`,
			);
		}
		const signedTape = verifySignedTape(
			getRecord(root, "tape", label),
			trustRoot.trustedTapeSigners,
			trustRoot.trustedCheckpointSigners,
			`${label}.tape`,
		);
		if (sourceRunIds.has(signedTape.runId)) {
			throw new GateError(
				`Campaign reuses the same signed tape source run ${signedTape.runId} under multiple tape roots.`,
			);
		}
		sourceRunIds.add(signedTape.runId);
		const verifiedEvents = resolveDeclaredTapeCheckpoint(
			signedTape,
			{ throughEventId, throughEventCount, tapeRootHash },
			label,
		);
		roots.set(
			tapeId,
			Object.freeze({
				tapeId,
				sourceRunId: signedTape.runId,
				tapeRootHash,
				verifiedEvents,
			}),
		);
	}
	return roots;
}

function verifySignedTape(
	value: JsonRecord,
	trustedTapeSigners: readonly TrustSpineReleaseTrustedTapeSignerV1[],
	trustedCheckpointSigners: readonly TrustSpineReleaseTrustedTapeSignerV1[],
	label: string,
): VerifiedSignedTape {
	validateKeys(value, ["format", "run_id", "trusted_keys", "events"], label);
	if (getString(value, "format", label) !== SIGNED_TAPE_FORMAT) {
		throw new GateError(`${label}.format is not a signed tape export.`);
	}
	const runId = getString(value, "run_id", label);
	for (const [index, entry] of getArray(
		value,
		"trusted_keys",
		label,
	).entries()) {
		validateTapeExportKey(entry, `${label}.trusted_keys[${index}]`);
	}
	const entries = getArray(value, "events", label);
	if (entries.length === 0) {
		throw new GateError(`${label}.events must not be empty.`);
	}
	const events: VerifiedTapeEvent[] = [];
	const checkpoints: VerifiedTapeCheckpoint[] = [];
	const eventIds = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		const eventLabel = `${label}.events[${index}]`;
		const parsed = verifyStoredTapeEvent(
			entry,
			runId,
			trustedTapeSigners,
			trustedCheckpointSigners,
			eventLabel,
		);
		if (eventIds.has(parsed.eventId)) {
			throw new GateError(`${label} contains a duplicate tape event id.`);
		}
		eventIds.add(parsed.eventId);
		events.push(parsed);
		if (parsed.kind === "tape_checkpoint") {
			checkpoints.push(parseTapeCheckpoint(parsed, eventLabel));
		}
	}
	const coveredEvents = events.filter(
		(event) => event.kind !== "tape_checkpoint",
	);
	for (const checkpoint of checkpoints) {
		verifyTapeCheckpoint(checkpoint, coveredEvents, label);
	}
	verifyTapeCheckpointChain(checkpoints, label);
	return Object.freeze({
		runId,
		events: Object.freeze(events),
		checkpoints: Object.freeze(checkpoints),
	});
}

function validateTapeExportKey(value: unknown, label: string): void {
	const key = asRecord(value, label);
	validateKeys(key, ["public_key_hash", "public_key_b64"], label);
	const publicKeyHash = getSha256(key, "public_key_hash", label);
	const raw = decodeBase64(getString(key, "public_key_b64", label), label);
	if (raw.length !== 32 || sha256Hex(raw) !== publicKeyHash) {
		throw new GateError(`${label} does not bind a raw Ed25519 public key.`);
	}
}

function verifyStoredTapeEvent(
	value: unknown,
	runId: string,
	trustedTapeSigners: readonly TrustSpineReleaseTrustedTapeSignerV1[],
	trustedCheckpointSigners: readonly TrustSpineReleaseTrustedTapeSignerV1[],
	label: string,
): ParsedTapeCanonicalEvent {
	const entry = asRecord(value, label);
	validateKeys(entry, ["canonical_event_b64", "signature"], label);
	const canonicalBytes = decodeBase64(
		getString(entry, "canonical_event_b64", label),
		`${label}.canonical_event_b64`,
	);
	const canonicalEvent = parseCanonicalTapeEvent(canonicalBytes, label);
	if (canonicalEvent.runId !== runId) {
		throw new GateError(
			`${label} canonical event run id does not match the tape.`,
		);
	}
	const signature = getRecord(entry, "signature", label);
	validateKeys(
		signature,
		[
			"event_id",
			"canonical_event_hash",
			"signer",
			"algorithm",
			"signature",
			"signed_at",
		],
		`${label}.signature`,
	);
	if (
		getString(signature, "event_id", `${label}.signature`) !==
		canonicalEvent.eventId
	) {
		throw new GateError(
			`${label} signature event id does not match canonical bytes.`,
		);
	}
	const canonicalEventHash = getSha256(
		signature,
		"canonical_event_hash",
		`${label}.signature`,
	);
	if (canonicalEventHash !== sha256Hex(canonicalBytes)) {
		throw new GateError(
			`${label} canonical event hash does not match stored canonical bytes.`,
		);
	}
	if (getString(signature, "algorithm", `${label}.signature`) !== "ed25519") {
		throw new GateError(`${label} signature algorithm must be ed25519.`);
	}
	getString(signature, "signed_at", `${label}.signature`);
	const signer = parseTapeEventSigner(
		getRecord(signature, "signer", `${label}.signature`),
		`${label}.signature.signer`,
	);
	const isCheckpoint = canonicalEvent.kind === "tape_checkpoint";
	const authorizedSigners = isCheckpoint
		? trustedCheckpointSigners
		: trustedTapeSigners;
	const signerRole = isCheckpoint ? "checkpoint" : "tape";
	const pinnedSigner = authorizedSigners.find((candidate) =>
		sameTapeSignerBinding(candidate, signer),
	);
	if (!pinnedSigner) {
		throw new GateError(
			`${label} ${signerRole} signer is not pinned in the trust root.`,
		);
	}
	const signatureBytes = decodeBase64url(
		getString(signature, "signature", `${label}.signature`),
		`${label}.signature.signature`,
	);
	if (signatureBytes.length !== 64) {
		throw new GateError(`${label} signature must be 64 bytes.`);
	}
	let verified = false;
	try {
		verified = verifySignature(
			null,
			canonicalBytes,
			createPublicKey({
				key: {
					kty: "OKP",
					crv: "Ed25519",
					x: pinnedSigner.publicKeyB64,
				},
				format: "jwk",
			}),
			signatureBytes,
		);
	} catch {
		verified = false;
	}
	if (!verified) {
		throw new GateError(
			`${label} signature does not verify against its root-pinned ${signerRole} signer.`,
		);
	}
	return Object.freeze({ ...canonicalEvent, canonicalEventHash });
}

function parseCanonicalTapeEvent(
	canonicalBytes: Buffer,
	label: string,
): Omit<ParsedTapeCanonicalEvent, "canonicalEventHash"> {
	const source = canonicalBytes.toString("utf8");
	if (!Buffer.from(source, "utf8").equals(canonicalBytes)) {
		throw new GateError(`${label} canonical event bytes are not valid UTF-8.`);
	}
	assertNoDuplicateJsonKeys(source, `${label} canonical event`);
	let decoded: unknown;
	try {
		decoded = JSON.parse(source);
	} catch {
		throw new GateError(`${label} canonical event bytes are not valid JSON.`);
	}
	const event = asRecord(decoded, `${label} canonical event`);
	validateKeys(
		event,
		[
			"id",
			"run_id",
			"parent_event_id",
			"schema_version",
			"kind",
			"occurred_at",
			"payload",
		],
		`${label} canonical event`,
	);
	if (getInteger(event, "schema_version", `${label} canonical event`) !== 1) {
		throw new GateError(
			`${label} canonical event schema version is not supported.`,
		);
	}
	const parentEventId = event.parent_event_id;
	if (
		parentEventId !== null &&
		(typeof parentEventId !== "string" || parentEventId.length === 0)
	) {
		throw new GateError(
			`${label} canonical event parent_event_id must be null or a non-empty string.`,
		);
	}
	getString(event, "occurred_at", `${label} canonical event`);
	return Object.freeze({
		eventId: getString(event, "id", `${label} canonical event`),
		runId: getString(event, "run_id", `${label} canonical event`),
		parentEventId: parentEventId as string | null,
		kind: getString(event, "kind", `${label} canonical event`),
		payload: getRecord(event, "payload", `${label} canonical event`),
	});
}

function parseTapeEventSigner(
	value: JsonRecord,
	label: string,
): TapeSignerBinding {
	validateKeys(value, ["actor_id", "key_id", "public_key_hash"], label);
	return Object.freeze({
		actorId: getString(value, "actor_id", label),
		keyId: getString(value, "key_id", label),
		publicKeyHash: getSha256(value, "public_key_hash", label),
	});
}

function parseTapeCheckpoint(
	event: Omit<ParsedTapeCanonicalEvent, "canonicalEventHash">,
	label: string,
): VerifiedTapeCheckpoint {
	validateKeys(
		event.payload,
		["TapeCheckpointV1"],
		`${label} checkpoint payload`,
	);
	const checkpoint = getRecord(
		event.payload,
		"TapeCheckpointV1",
		`${label} checkpoint payload`,
	);
	validateKeys(
		checkpoint,
		[
			"run_id",
			"checkpoint_index",
			"through_event_id",
			"through_event_count",
			"previous_checkpoint_event_id",
			"tape_root_hash",
			"algorithm",
		],
		`${label} checkpoint`,
	);
	if (getString(checkpoint, "run_id", `${label} checkpoint`) !== event.runId) {
		throw new GateError(`${label} checkpoint run id does not match its event.`);
	}
	const checkpointIndex = getInteger(
		checkpoint,
		"checkpoint_index",
		`${label} checkpoint`,
	);
	if (checkpointIndex < 0) {
		throw new GateError(`${label} checkpoint_index must be non-negative.`);
	}
	const previousCheckpointEventId = checkpoint.previous_checkpoint_event_id;
	if (
		previousCheckpointEventId !== null &&
		(typeof previousCheckpointEventId !== "string" ||
			previousCheckpointEventId.length === 0)
	) {
		throw new GateError(
			`${label} checkpoint previous_checkpoint_event_id must be null or a non-empty string.`,
		);
	}
	if (
		getString(checkpoint, "algorithm", `${label} checkpoint`) !==
		TAPE_ROOT_ALGORITHM
	) {
		throw new GateError(`${label} checkpoint root algorithm is not supported.`);
	}
	const throughEventCount = getInteger(
		checkpoint,
		"through_event_count",
		`${label} checkpoint`,
	);
	if (throughEventCount < 1) {
		throw new GateError(`${label} checkpoint has no covered events.`);
	}
	return Object.freeze({
		eventId: event.eventId,
		parentEventId: event.parentEventId,
		checkpointIndex,
		previousCheckpointEventId: previousCheckpointEventId as string | null,
		throughEventId: getString(
			checkpoint,
			"through_event_id",
			`${label} checkpoint`,
		),
		throughEventCount,
		tapeRootHash: getSha256(
			checkpoint,
			"tape_root_hash",
			`${label} checkpoint`,
		),
	});
}

function verifyTapeCheckpoint(
	checkpoint: VerifiedTapeCheckpoint,
	events: readonly VerifiedTapeEvent[],
	label: string,
): void {
	if (checkpoint.parentEventId !== checkpoint.throughEventId) {
		throw new GateError(
			`${label} checkpoint parent does not equal its through event.`,
		);
	}
	const covered = events
		.filter((event) => event.eventId <= checkpoint.throughEventId)
		.sort((left, right) => left.eventId.localeCompare(right.eventId));
	if (
		covered.length === 0 ||
		covered.at(-1)?.eventId !== checkpoint.throughEventId
	) {
		throw new GateError(
			`${label} checkpoint through-event boundary is not a verified tape event.`,
		);
	}
	if (covered.length !== checkpoint.throughEventCount) {
		throw new GateError(
			`${label} checkpoint event count does not match its boundary.`,
		);
	}
	const recomputedRoot = sha256Hex(
		Buffer.from(
			covered.map((event) => event.canonicalEventHash).join("\n"),
			"utf8",
		),
	);
	if (recomputedRoot !== checkpoint.tapeRootHash) {
		throw new GateError(
			`${label} checkpoint root hash does not match verified events.`,
		);
	}
}

function verifyTapeCheckpointChain(
	checkpoints: readonly VerifiedTapeCheckpoint[],
	label: string,
): void {
	let previousCheckpoint: VerifiedTapeCheckpoint | undefined;
	for (const checkpoint of checkpoints) {
		if (!previousCheckpoint) {
			if (checkpoint.checkpointIndex !== 0) {
				throw new GateError(`${label} first checkpoint index must be zero.`);
			}
			if (checkpoint.previousCheckpointEventId !== null) {
				throw new GateError(
					`${label} first checkpoint previous checkpoint link must be null.`,
				);
			}
		} else {
			if (
				checkpoint.checkpointIndex !==
				previousCheckpoint.checkpointIndex + 1
			) {
				throw new GateError(
					`${label} checkpoint indexes must be monotonic without duplicates.`,
				);
			}
			if (checkpoint.previousCheckpointEventId !== previousCheckpoint.eventId) {
				throw new GateError(
					`${label} checkpoint chain previous checkpoint link is invalid.`,
				);
			}
		}
		previousCheckpoint = checkpoint;
	}
}

function resolveDeclaredTapeCheckpoint(
	tape: VerifiedSignedTape,
	declared: Pick<
		VerifiedTapeCheckpoint,
		"throughEventId" | "throughEventCount" | "tapeRootHash"
	>,
	label: string,
): ReadonlyMap<string, VerifiedTapeEvent> {
	const matches = tape.checkpoints.filter(
		(checkpoint) =>
			checkpoint.throughEventId === declared.throughEventId &&
			checkpoint.throughEventCount === declared.throughEventCount &&
			checkpoint.tapeRootHash === declared.tapeRootHash,
	);
	if (matches.length !== 1) {
		throw new GateError(
			`${label} does not name exactly one verified signed tape checkpoint.`,
		);
	}
	const covered = tape.events
		.filter(
			(event) =>
				event.kind !== "tape_checkpoint" &&
				event.eventId <= declared.throughEventId,
		)
		.sort((left, right) => left.eventId.localeCompare(right.eventId));
	if (covered.length !== declared.throughEventCount) {
		throw new GateError(
			`${label} checkpoint count does not match covered events.`,
		);
	}
	return new Map(covered.map((event) => [event.eventId, event]));
}

function deriveTrials(
	value: readonly unknown[],
	roots: ReadonlyMap<string, TapeRoot>,
	consumedEvidence: Set<string>,
	policy: CampaignPolicy,
	bindings: ReleaseEvidenceBindings,
): readonly TrustSpineTrialV1[] {
	if (value.length === 0) {
		throw new GateError("Campaign bundle has no trial evidence.");
	}
	return Object.freeze(
		value.map((entry, index) => {
			const label = `campaign trials[${index}]`;
			const evidence = readReleaseEvaluationEvidence(
				useCampaignEvidenceRef(entry, label, roots, consumedEvidence),
				label,
				bindings,
			);
			if (evidence.claimKind !== "trial") {
				throw new GateError(`${label} must select a trial claim event.`);
			}
			const claim = evidence.claim as ReleaseEvaluationTrialClaimV1;
			for (const [sourceLabel, source] of Object.entries(claim.sources)) {
				useReleaseEvaluationSource(
					source,
					`${label} claim.sources.${sourceLabel}`,
					roots,
					consumedEvidence,
				);
			}
			if (!policy.expectedProviders.includes(claim.provider)) {
				throw new GateError(
					`${label} provider is not in the pinned release policy.`,
				);
			}
			if (!policy.expectedTrustTiers.includes(claim.trustTier)) {
				throw new GateError(
					`${label} trust tier is not in the pinned release policy.`,
				);
			}
			if (claim.governance !== "governed") {
				throw new GateError(`${label} must be in the governed lane.`);
			}
			return Object.freeze({
				taskId: claim.taskId,
				provider: claim.provider,
				trustTier: claim.trustTier,
				trial: claim.trial,
				governance: "governed",
				passed: claim.passed,
				costUsd: claim.costUsdMicros / 1_000_000,
				latencyMs: claim.latencyMs,
				tokens: claim.tokens,
				toolCalls: claim.toolCalls,
				candidateCount: claim.candidateCount,
				reviewerDisagreed: claim.reviewerDisagreed,
				falseApproval: claim.falseApproval,
				unauthorizedEffects: claim.unauthorizedEffects,
				duplicateEffects: claim.duplicateEffects,
				safetyViolations: claim.safetyViolations,
				recoveryCorrect: claim.recoveryCorrect,
				illegitimateSuccess: claim.illegitimateSuccess,
			});
		}),
	);
}

function deriveInvariants(
	value: JsonRecord,
	roots: ReadonlyMap<string, TapeRoot>,
	consumedEvidence: Set<string>,
	policy: CampaignPolicy,
	bindings: ReleaseEvidenceBindings,
): {
	readonly targetBranchImmutability: boolean;
	readonly backwardReplayCompatible: boolean;
	readonly unresolvedRequiredChecks: readonly string[];
} {
	validateKeys(
		value,
		[
			"targetBranchImmutability",
			"backwardReplayCompatibility",
			"requiredChecks",
		],
		"campaign invariants",
	);
	const branchEvidence = readReleaseEvaluationEvidence(
		useCampaignEvidenceRef(
			value.targetBranchImmutability,
			"campaign targetBranchImmutability",
			roots,
			consumedEvidence,
		),
		"campaign targetBranchImmutability",
		bindings,
	);
	if (branchEvidence.claimKind !== "target_branch_immutability") {
		throw new GateError(
			"Campaign targetBranchImmutability must select a target-branch claim event.",
		);
	}
	const branch =
		branchEvidence.claim as ReleaseEvaluationTargetBranchImmutabilityClaimV1;
	useReleaseEvaluationSource(
		branch.source,
		"campaign targetBranchImmutability claim.source",
		roots,
		consumedEvidence,
	);

	const replayEvidence = readReleaseEvaluationEvidence(
		useCampaignEvidenceRef(
			value.backwardReplayCompatibility,
			"campaign backwardReplayCompatibility",
			roots,
			consumedEvidence,
		),
		"campaign backwardReplayCompatibility",
		bindings,
	);
	if (replayEvidence.claimKind !== "backward_replay_compatibility") {
		throw new GateError(
			"Campaign backwardReplayCompatibility must select a replay claim event.",
		);
	}
	const replay =
		replayEvidence.claim as ReleaseEvaluationBackwardReplayCompatibilityClaimV1;
	useReleaseEvaluationSource(
		replay.source,
		"campaign backwardReplayCompatibility claim.source",
		roots,
		consumedEvidence,
	);

	const byName = new Map<string, boolean>();
	for (const [index, candidate] of getArray(
		value,
		"requiredChecks",
		"campaign invariants",
	).entries()) {
		const label = `campaign requiredChecks[${index}]`;
		const evidence = readReleaseEvaluationEvidence(
			useCampaignEvidenceRef(candidate, label, roots, consumedEvidence),
			label,
			bindings,
		);
		if (evidence.claimKind !== "required_check") {
			throw new GateError(`${label} must select a required-check claim event.`);
		}
		const claim = evidence.claim as ReleaseEvaluationRequiredCheckClaimV1;
		useReleaseEvaluationSource(
			claim.source,
			`${label} claim.source`,
			roots,
			consumedEvidence,
		);
		if (!policy.requiredCheckNames.includes(claim.name)) {
			throw new GateError(
				"Campaign includes evidence for an unknown required check.",
			);
		}
		if (byName.has(claim.name)) {
			throw new GateError(
				`Campaign repeats required check evidence for ${claim.name}.`,
			);
		}
		byName.set(claim.name, claim.conclusion === "success");
	}
	return Object.freeze({
		targetBranchImmutability: branch.immutable,
		backwardReplayCompatible: replay.compatible,
		unresolvedRequiredChecks: Object.freeze(
			policy.requiredCheckNames.filter((name) => byName.get(name) !== true),
		),
	});
}

function useCampaignEvidenceRef(
	value: unknown,
	label: string,
	roots: ReadonlyMap<string, TapeRoot>,
	consumedEvidence: Set<string>,
): VerifiedTapeEvent {
	const reference = asRecord(value, label);
	validateKeys(
		reference,
		["tapeId", "tapeRootHash", "eventId", "canonicalEventHash"],
		label,
	);
	const tapeId = getString(reference, "tapeId", label);
	const root = roots.get(tapeId);
	if (!root) {
		throw new GateError(
			`${label} references a tape absent from the campaign roots.`,
		);
	}
	assertMatches(
		getSha256(reference, "tapeRootHash", label),
		root.tapeRootHash,
		`${label} tape root`,
	);
	const eventId = getString(reference, "eventId", label);
	const canonicalEventHash = getSha256(reference, "canonicalEventHash", label);
	const event = root.verifiedEvents.get(eventId);
	if (!event || event.canonicalEventHash !== canonicalEventHash) {
		throw new GateError(
			`${label} does not name a verified event covered by its tape root.`,
		);
	}
	consumeEvidenceEvent(root, event, label, consumedEvidence);
	return event;
}

function consumeEvidenceEvent(
	root: TapeRoot,
	event: VerifiedTapeEvent,
	label: string,
	consumedEvidence: Set<string>,
): void {
	const identity = `${root.sourceRunId}${ID_SEPARATOR}${event.eventId}`;
	if (consumedEvidence.has(identity)) {
		throw new GateError(
			`${label} reuses evidence already consumed by the campaign.`,
		);
	}
	consumedEvidence.add(identity);
}

function useReleaseEvaluationSource(
	source: ReleaseEvaluationSourceEventRefV1,
	label: string,
	roots: ReadonlyMap<string, TapeRoot>,
	consumedEvidence: Set<string>,
): void {
	const matches: Array<{ root: TapeRoot; event: VerifiedTapeEvent }> = [];
	for (const root of roots.values()) {
		const event = root.verifiedEvents.get(source.sourceEventId);
		if (event && event.canonicalEventHash === source.sourceCanonicalEventHash) {
			matches.push({ root, event });
		}
	}
	if (matches.length === 0) {
		throw new GateError(
			`${label} does not name a verified source event covered by a campaign tape root.`,
		);
	}
	if (matches.length !== 1) {
		throw new GateError(
			`${label} is ambiguous across verified campaign tape roots.`,
		);
	}
	consumeEvidenceEvent(
		matches[0].root,
		matches[0].event,
		label,
		consumedEvidence,
	);
}

function readReleaseEvaluationEvidence(
	event: VerifiedTapeEvent,
	label: string,
	bindings: ReleaseEvidenceBindings,
): ReleaseEvaluationEvidenceV1 {
	if (event.kind !== RELEASE_EVALUATION_EVIDENCE_V1_EVENT_KIND) {
		throw new GateError(
			`${label} must reference a release_evaluation_evidence_v1 typed claim event.`,
		);
	}
	validateKeys(
		event.payload,
		["ReleaseEvaluationEvidenceV1"],
		`${label} release evaluation payload`,
	);
	const payload = getRecord(
		event.payload,
		"ReleaseEvaluationEvidenceV1",
		`${label} release evaluation payload`,
	);
	validateKeys(
		payload,
		[
			"schema_version",
			"release_commit",
			"release_ref",
			"policy_digest",
			"claim_kind",
			"claim",
			"claim_digest",
		],
		`${label} release evaluation claim`,
	);
	if (
		getInteger(
			payload,
			"schema_version",
			`${label} release evaluation claim`,
		) !== RELEASE_EVALUATION_EVIDENCE_V1_SCHEMA_VERSION
	) {
		throw new GateError(
			`${label} release evaluation claim schema version is not supported.`,
		);
	}
	const claimKind = getReleaseEvaluationClaimKind(
		payload,
		"claim_kind",
		`${label} release evaluation claim`,
	);
	const evidence: ReleaseEvaluationEvidenceV1 = Object.freeze({
		schemaVersion: 1,
		releaseCommit: requireCommit(
			getString(payload, "release_commit", `${label} release evaluation claim`),
			`${label} release evaluation claim release_commit`,
		),
		releaseRef: requireCanonicalReleaseRef(
			getString(payload, "release_ref", `${label} release evaluation claim`),
			`${label} release evaluation claim release_ref`,
		),
		policyDigest: getSha256(
			payload,
			"policy_digest",
			`${label} release evaluation claim`,
		),
		claimKind,
		claim: parseReleaseEvaluationClaim(
			getRecord(payload, "claim", `${label} release evaluation claim`),
			claimKind,
			`${label} release evaluation claim.claim`,
		),
		claimDigest: getSha256(
			payload,
			"claim_digest",
			`${label} release evaluation claim`,
		),
	});
	if (
		computeReleaseEvaluationEvidenceClaimDigest(evidence) !==
		evidence.claimDigest
	) {
		throw new GateError(
			`${label} release evaluation claim digest does not match its typed claim body.`,
		);
	}
	assertMatches(
		evidence.releaseCommit,
		bindings.releaseCommit,
		`${label} release evaluation claim release commit`,
	);
	assertMatches(
		evidence.releaseRef,
		bindings.releaseRef,
		`${label} release evaluation claim release ref`,
	);
	assertMatches(
		evidence.policyDigest,
		bindings.policyDigest,
		`${label} release evaluation claim policy digest`,
	);
	return evidence;
}

function getReleaseEvaluationClaimKind(
	parent: JsonRecord,
	field: string,
	label: string,
): ReleaseEvaluationClaimKindV1 {
	const value = getString(parent, field, label);
	if (
		value !== "trial" &&
		value !== "target_branch_immutability" &&
		value !== "backward_replay_compatibility" &&
		value !== "required_check"
	) {
		throw new GateError(`${label}.${field} is not a supported claim kind.`);
	}
	return value;
}

function parseReleaseEvaluationClaim(
	value: JsonRecord,
	claimKind: ReleaseEvaluationClaimKindV1,
	label: string,
): ReleaseEvaluationClaimV1 {
	switch (claimKind) {
		case "trial":
			return parseReleaseEvaluationTrialClaim(value, label);
		case "target_branch_immutability":
			return Object.freeze({
				immutable: getBooleanAfterKeys(
					value,
					["immutable", "source"],
					label,
					"immutable",
				),
				source: parseReleaseEvaluationSource(
					getRecord(value, "source", label),
					`${label}.source`,
				),
			});
		case "backward_replay_compatibility":
			return Object.freeze({
				compatible: getBooleanAfterKeys(
					value,
					["compatible", "source"],
					label,
					"compatible",
				),
				source: parseReleaseEvaluationSource(
					getRecord(value, "source", label),
					`${label}.source`,
				),
			});
		case "required_check":
			validateKeys(value, ["name", "conclusion", "source"], label);
			return Object.freeze({
				name: getReleaseEvaluationIdentifier(value, "name", label),
				conclusion: getReleaseEvaluationCheckConclusion(
					value,
					"conclusion",
					label,
				),
				source: parseReleaseEvaluationSource(
					getRecord(value, "source", label),
					`${label}.source`,
				),
			});
	}
}

function getBooleanAfterKeys(
	value: JsonRecord,
	keys: readonly string[],
	label: string,
	field: string,
): boolean {
	validateKeys(value, keys, label);
	return getBoolean(value, field, label);
}

function parseReleaseEvaluationTrialClaim(
	value: JsonRecord,
	label: string,
): ReleaseEvaluationTrialClaimV1 {
	validateKeys(
		value,
		[
			"task_id",
			"provider",
			"trust_tier",
			"trial",
			"governance",
			"passed",
			"cost_usd_micros",
			"latency_ms",
			"tokens",
			"tool_calls",
			"candidate_count",
			"reviewer_disagreed",
			"false_approval",
			"unauthorized_effects",
			"duplicate_effects",
			"safety_violations",
			"recovery_correct",
			"illegitimate_success",
			"sources",
		],
		label,
	);
	const sourcesValue = getRecord(value, "sources", label);
	validateKeys(
		sourcesValue,
		[
			"model_request",
			"candidate",
			"acceptance",
			"review",
			"recovery",
			"terminal",
		],
		`${label}.sources`,
	);
	const sources = Object.freeze({
		modelRequest: parseReleaseEvaluationSource(
			getRecord(sourcesValue, "model_request", `${label}.sources`),
			`${label}.sources.model_request`,
		),
		candidate: parseReleaseEvaluationSource(
			getRecord(sourcesValue, "candidate", `${label}.sources`),
			`${label}.sources.candidate`,
		),
		acceptance: parseReleaseEvaluationSource(
			getRecord(sourcesValue, "acceptance", `${label}.sources`),
			`${label}.sources.acceptance`,
		),
		review: parseReleaseEvaluationSource(
			getRecord(sourcesValue, "review", `${label}.sources`),
			`${label}.sources.review`,
		),
		recovery: parseReleaseEvaluationSource(
			getRecord(sourcesValue, "recovery", `${label}.sources`),
			`${label}.sources.recovery`,
		),
		terminal: parseReleaseEvaluationSource(
			getRecord(sourcesValue, "terminal", `${label}.sources`),
			`${label}.sources.terminal`,
		),
	});
	const sourceIds = new Set(
		Object.values(sources).map((source) => source.sourceEventId),
	);
	if (sourceIds.size !== 6) {
		throw new GateError(
			`${label}.sources must name six distinct source events.`,
		);
	}
	const governance = getString(value, "governance", label);
	if (governance !== "governed" && governance !== "raw") {
		throw new GateError(`${label}.governance must be governed or raw.`);
	}
	return Object.freeze({
		taskId: getReleaseEvaluationIdentifier(value, "task_id", label),
		provider: getReleaseEvaluationDimension(value, "provider", label),
		trustTier: getReleaseEvaluationDimension(value, "trust_tier", label),
		trial: getTrialNumber(value, "trial", label),
		governance,
		passed: getBoolean(value, "passed", label),
		costUsdMicros: getSafeNonNegativeInteger(value, "cost_usd_micros", label),
		latencyMs: getSafeNonNegativeInteger(value, "latency_ms", label),
		tokens: getSafeNonNegativeInteger(value, "tokens", label),
		toolCalls: getSafeNonNegativeInteger(
			value,
			"tool_calls",
			label,
			0xffff_ffff,
		),
		candidateCount: getSafeNonNegativeInteger(
			value,
			"candidate_count",
			label,
			0xffff_ffff,
		),
		reviewerDisagreed: getBoolean(value, "reviewer_disagreed", label),
		falseApproval: getBoolean(value, "false_approval", label),
		unauthorizedEffects: getSafeNonNegativeInteger(
			value,
			"unauthorized_effects",
			label,
			0xffff_ffff,
		),
		duplicateEffects: getSafeNonNegativeInteger(
			value,
			"duplicate_effects",
			label,
			0xffff_ffff,
		),
		safetyViolations: getSafeNonNegativeInteger(
			value,
			"safety_violations",
			label,
			0xffff_ffff,
		),
		recoveryCorrect: getBoolean(value, "recovery_correct", label),
		illegitimateSuccess: getBoolean(value, "illegitimate_success", label),
		sources,
	});
}

function parseReleaseEvaluationSource(
	value: JsonRecord,
	label: string,
): ReleaseEvaluationSourceEventRefV1 {
	validateKeys(
		value,
		["source_event_id", "source_canonical_event_hash"],
		label,
	);
	return Object.freeze({
		sourceEventId: getString(value, "source_event_id", label),
		sourceCanonicalEventHash: getSha256(
			value,
			"source_canonical_event_hash",
			label,
		),
	});
}

function getReleaseEvaluationIdentifier(
	parent: JsonRecord,
	field: string,
	label: string,
): string {
	const value = getString(parent, field, label);
	const containsControlCharacter = [...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return (
			codePoint !== undefined &&
			((codePoint >= 0 && codePoint <= 0x1f) ||
				(codePoint >= 0x7f && codePoint <= 0x9f))
		);
	});
	if (value.trim() !== value || containsControlCharacter) {
		throw new GateError(
			`${label}.${field} must be a non-empty, trimmed identifier.`,
		);
	}
	return value;
}

function getReleaseEvaluationDimension(
	parent: JsonRecord,
	field: string,
	label: string,
): string {
	const value = getReleaseEvaluationIdentifier(parent, field, label);
	if (value.includes("/")) {
		throw new GateError(`${label}.${field} must not contain '/'.`);
	}
	return value;
}

function getReleaseEvaluationCheckConclusion(
	parent: JsonRecord,
	field: string,
	label: string,
): ReleaseEvaluationRequiredCheckClaimV1["conclusion"] {
	const value = getString(parent, field, label);
	if (
		value !== "success" &&
		value !== "failure" &&
		value !== "cancelled" &&
		value !== "skipped" &&
		value !== "timed_out" &&
		value !== "neutral" &&
		value !== "action_required"
	) {
		throw new GateError(
			`${label}.${field} is not a supported check conclusion.`,
		);
	}
	return value;
}

function computeReleaseEvaluationEvidenceClaimDigest(
	evidence: ReleaseEvaluationEvidenceV1,
): string {
	const material = {
		schema_version: evidence.schemaVersion,
		release_commit: evidence.releaseCommit,
		release_ref: evidence.releaseRef,
		policy_digest: evidence.policyDigest,
		claim_kind: evidence.claimKind,
		claim: serializeReleaseEvaluationClaim(evidence),
	};
	return sha256Hex(
		Buffer.from(
			`${RELEASE_EVALUATION_EVIDENCE_V1_DIGEST_DOMAIN}${JSON.stringify(material)}`,
			"utf8",
		),
	);
}

function serializeReleaseEvaluationClaim(
	evidence: ReleaseEvaluationEvidenceV1,
): JsonRecord {
	switch (evidence.claimKind) {
		case "trial": {
			const claim = evidence.claim as ReleaseEvaluationTrialClaimV1;
			return {
				task_id: claim.taskId,
				provider: claim.provider,
				trust_tier: claim.trustTier,
				trial: claim.trial,
				governance: claim.governance,
				passed: claim.passed,
				cost_usd_micros: claim.costUsdMicros,
				latency_ms: claim.latencyMs,
				tokens: claim.tokens,
				tool_calls: claim.toolCalls,
				candidate_count: claim.candidateCount,
				reviewer_disagreed: claim.reviewerDisagreed,
				false_approval: claim.falseApproval,
				unauthorized_effects: claim.unauthorizedEffects,
				duplicate_effects: claim.duplicateEffects,
				safety_violations: claim.safetyViolations,
				recovery_correct: claim.recoveryCorrect,
				illegitimate_success: claim.illegitimateSuccess,
				sources: {
					model_request: serializeReleaseEvaluationSource(
						claim.sources.modelRequest,
					),
					candidate: serializeReleaseEvaluationSource(claim.sources.candidate),
					acceptance: serializeReleaseEvaluationSource(
						claim.sources.acceptance,
					),
					review: serializeReleaseEvaluationSource(claim.sources.review),
					recovery: serializeReleaseEvaluationSource(claim.sources.recovery),
					terminal: serializeReleaseEvaluationSource(claim.sources.terminal),
				},
			};
		}
		case "target_branch_immutability": {
			const claim =
				evidence.claim as ReleaseEvaluationTargetBranchImmutabilityClaimV1;
			return {
				immutable: claim.immutable,
				source: serializeReleaseEvaluationSource(claim.source),
			};
		}
		case "backward_replay_compatibility": {
			const claim =
				evidence.claim as ReleaseEvaluationBackwardReplayCompatibilityClaimV1;
			return {
				compatible: claim.compatible,
				source: serializeReleaseEvaluationSource(claim.source),
			};
		}
		case "required_check": {
			const claim = evidence.claim as ReleaseEvaluationRequiredCheckClaimV1;
			return {
				name: claim.name,
				conclusion: claim.conclusion,
				source: serializeReleaseEvaluationSource(claim.source),
			};
		}
	}
}

function serializeReleaseEvaluationSource(
	source: ReleaseEvaluationSourceEventRefV1,
): JsonRecord {
	return {
		source_event_id: source.sourceEventId,
		source_canonical_event_hash: source.sourceCanonicalEventHash,
	};
}

function parseHostBinding(value: JsonRecord, label: string): HostBinding {
	return Object.freeze({
		realm: getString(value, "realm", label),
		keyId: getString(value, "keyId", label),
		actorId: getString(value, "actorId", label),
		publicKeyHash: getSha256(value, "publicKeyHash", label),
	});
}

function parseTapeSignerBinding(
	value: JsonRecord,
	label: string,
): TapeSignerBinding {
	return Object.freeze({
		actorId: getString(value, "actorId", label),
		keyId: getString(value, "keyId", label),
		publicKeyHash: getSha256(value, "publicKeyHash", label),
	});
}

function sameHostBinding(left: HostBinding, right: HostBinding): boolean {
	return (
		left.realm === right.realm &&
		left.keyId === right.keyId &&
		left.actorId === right.actorId &&
		left.publicKeyHash === right.publicKeyHash
	);
}

function sameTapeSignerBinding(
	left: TapeSignerBinding,
	right: TapeSignerBinding,
): boolean {
	return (
		left.actorId === right.actorId &&
		left.keyId === right.keyId &&
		left.publicKeyHash === right.publicKeyHash
	);
}

function hostIdentity(host: HostBinding): string {
	return (
		host.realm +
		ID_SEPARATOR +
		host.keyId +
		ID_SEPARATOR +
		host.actorId +
		ID_SEPARATOR +
		host.publicKeyHash
	);
}

function tapeSignerIdentity(signer: TapeSignerBinding): string {
	return (
		signer.actorId +
		ID_SEPARATOR +
		signer.keyId +
		ID_SEPARATOR +
		signer.publicKeyHash
	);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new GateError("Campaign payload contains a non-finite number.");
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = asRecord(value, "campaign payload");
		return (
			"{" +
			Object.keys(record)
				.sort()
				.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
				.join(",") +
			"}"
		);
	}
	throw new GateError("Campaign payload contains a non-JSON value.");
}

function validateKeys(
	value: JsonRecord,
	allowed: readonly string[],
	label: string,
): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			throw new GateError(`${label} contains unknown field ${key}.`);
		}
	}
	for (const key of allowed) {
		if (!Object.hasOwn(value, key)) {
			throw new GateError(`${label} is missing required field ${key}.`);
		}
	}
}

function asRecord(value: unknown, label: string): JsonRecord {
	if (value === null || Array.isArray(value) || typeof value !== "object") {
		throw new GateError(`${label} must be an object.`);
	}
	return value as JsonRecord;
}

function getRecord(
	parent: JsonRecord,
	field: string,
	label: string,
): JsonRecord {
	return asRecord(parent[field], `${label}.${field}`);
}

function getArray(
	parent: JsonRecord,
	field: string,
	label: string,
): readonly unknown[] {
	const value = parent[field];
	if (!Array.isArray(value)) {
		throw new GateError(`${label}.${field} must be an array.`);
	}
	return value;
}

function getString(parent: JsonRecord, field: string, label: string): string {
	const value = parent[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new GateError(`${label}.${field} must be a non-empty string.`);
	}
	return value;
}

function getStringArray(
	parent: JsonRecord,
	field: string,
	label: string,
): readonly string[] {
	const values = getArray(parent, field, label);
	if (values.length === 0) {
		throw new GateError(`${label}.${field} must not be empty.`);
	}
	const seen = new Set<string>();
	return Object.freeze(
		values.map((value, index) => {
			if (typeof value !== "string" || value.length === 0) {
				throw new GateError(
					`${label}.${field}[${index}] must be a non-empty string.`,
				);
			}
			if (seen.has(value)) {
				throw new GateError(`${label}.${field} contains a duplicate value.`);
			}
			seen.add(value);
			return value;
		}),
	);
}

function getBoolean(parent: JsonRecord, field: string, label: string): boolean {
	const value = parent[field];
	if (typeof value !== "boolean") {
		throw new GateError(`${label}.${field} must be a boolean.`);
	}
	return value;
}

function getFiniteNumber(
	parent: JsonRecord,
	field: string,
	label: string,
): number {
	const value = parent[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new GateError(`${label}.${field} must be a finite number.`);
	}
	return value;
}

function getInteger(parent: JsonRecord, field: string, label: string): number {
	const value = getFiniteNumber(parent, field, label);
	if (!Number.isInteger(value)) {
		throw new GateError(`${label}.${field} must be an integer.`);
	}
	return value;
}

function getSafeNonNegativeInteger(
	parent: JsonRecord,
	field: string,
	label: string,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	const value = getInteger(parent, field, label);
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new GateError(
			`${label}.${field} must be a non-negative JavaScript-safe integer.`,
		);
	}
	return value;
}

function getTrialNumber(
	parent: JsonRecord,
	field: string,
	label: string,
): 1 | 2 | 3 {
	const value = getInteger(parent, field, label);
	if (value !== 1 && value !== 2 && value !== 3) {
		throw new GateError(`${label}.${field} must be 1, 2, or 3.`);
	}
	return value;
}

function getSha256(parent: JsonRecord, field: string, label: string): string {
	const value = getString(parent, field, label);
	if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw new GateError(`${label}.${field} must be a lowercase sha256 digest.`);
	}
	return value;
}

function requireCommit(value: string, label: string): string {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
		throw new GateError(
			`${label} commit must be a full lowercase hexadecimal SHA.`,
		);
	}
	return value;
}

function requireCanonicalReleaseRef(value: string, label: string): string {
	const prefix = "refs/heads/";
	const branch = value.startsWith(prefix) ? value.slice(prefix.length) : "";
	if (
		branch.length === 0 ||
		branch.endsWith("/") ||
		branch.endsWith(".") ||
		branch.endsWith(".lock") ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.includes("@{") ||
		!branch.split("/").every((component) => {
			return (
				component.length > 0 &&
				!component.startsWith(".") &&
				!component.endsWith(".") &&
				component !== "@" &&
				/^[A-Za-z0-9._@-]+$/.test(component)
			);
		})
	) {
		throw new GateError(
			`${label} ref must be a canonical refs/heads/<name> reference.`,
		);
	}
	return value;
}

function parseIsoTimestamp(value: string, label: string): number {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new GateError(`Campaign ${label} must be an ISO-8601 UTC timestamp.`);
	}
	return parsed;
}

function sha256Hex(value: Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function decodeBase64(value: string, label: string): Buffer {
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	) {
		throw new GateError(`${label} must be standard base64.`);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.length === 0 || decoded.toString("base64") !== value) {
		throw new GateError(`${label} must be canonical standard base64.`);
	}
	return decoded;
}

function decodeBase64url(value: string, label: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new GateError(`${label} must be base64url.`);
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length === 0 || decoded.toString("base64url") !== value) {
		throw new GateError(`${label} must be canonical base64url.`);
	}
	return decoded;
}

function assertMatches(
	actual: string | number | boolean,
	expected: string | number | boolean,
	label: string,
): void {
	if (actual !== expected) {
		throw new GateError(`${label} does not cross-check its evidence.`);
	}
}

function groupKey(provider: string, trustTier: string): string {
	return `${provider}/${trustTier}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const entrypoint = process.argv[1];
if (
	entrypoint?.endsWith("trust-spine-release-gate-cli.ts") ||
	entrypoint?.endsWith("trust-spine-release-gate-cli.js")
) {
	process.exitCode = runTrustSpineReleaseGateCli(process.argv.slice(2));
}
