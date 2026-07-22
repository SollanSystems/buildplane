/**
 * Read-only operational preflight for a protected Trust Spine release host or
 * release runner. It never creates keys, edits the pinned root, fetches a
 * bundle, publishes a package, or grants execution authority.
 */

import { isAbsolute } from "node:path";
import {
	type GovernedSandboxProbeResult,
	probeGovernedSandbox,
} from "../packages/runtime/src/governed-sandbox.js";
import {
	readPinnedTrustSpineReleaseTrustRoot,
	runTrustSpineReleaseGateCli,
	type TrustSpineReleaseGateCliIO,
	type TrustSpineReleaseTrustRootV1,
} from "./trust-spine-release-gate-cli.js";

const PREFLIGHT_SCHEMA_VERSION = 1 as const;
const CANONICAL_RELEASE_REF = "refs/heads/main";
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

type PreflightStage = "host" | "runner";

export interface TrustSpineReleasePreflightCheckV1 {
	readonly id:
		| "pinned_host_enrollment"
		| "tape_signer_enrollment"
		| "checkpoint_signer_enrollment"
		| "release_policy"
		| "rootless_oci_feasibility"
		| "campaign_bundle_and_evidence";
	readonly state: "ready" | "blocked";
	readonly message: string;
}

export interface TrustSpineReleasePreflightResultV1 {
	readonly schemaVersion: typeof PREFLIGHT_SCHEMA_VERSION;
	readonly stage: PreflightStage;
	readonly ready: boolean;
	readonly checks: readonly TrustSpineReleasePreflightCheckV1[];
	readonly limitations: readonly string[];
}

export interface TrustSpineReleasePreflightCliIO {
	readonly stdout?: (line: string) => void;
	readonly stderr?: (line: string) => void;
	/** Test-only seam; production always reads the checked-in pinned root. */
	readonly readPinnedTrustRoot?: () => TrustSpineReleaseTrustRootV1;
	/** Test-only seam; production always invokes the existing release gate. */
	readonly runReleaseGate?: (
		argv: readonly string[],
		io: TrustSpineReleaseGateCliIO,
	) => number;
	/** Test-only seam; production runs the read-only local OCI probe. */
	readonly probeOci?: () => GovernedSandboxProbeResult;
}

class PreflightUsageError extends Error {}

interface HostArguments {
	readonly stage: "host";
	readonly realm: string;
	readonly keyId: string;
	readonly actorId: string;
	readonly publicKeyHash: string;
}

interface RunnerArguments {
	readonly stage: "runner";
	readonly bundlePath: string;
	readonly releaseCommit: string;
	readonly releaseRef: string;
}

type PreflightArguments = HostArguments | RunnerArguments;

/**
 * Run a public configuration check before asking a protected host to run a
 * campaign, or verify that an already-provisioned runner can see and validate
 * the final immutable campaign bundle.
 */
export function runTrustSpineReleasePreflightCli(
	argv: readonly string[],
	io: TrustSpineReleasePreflightCliIO = {},
): number {
	const stdout = io.stdout ?? ((line: string) => console.log(line));
	const stderr = io.stderr ?? ((line: string) => console.error(line));
	try {
		const args = parseArguments(stripPnpmArgumentDelimiter(argv));
		const result =
			args.stage === "host"
				? evaluateHostPreflight(
						args,
						(io.readPinnedTrustRoot ?? readPinnedTrustSpineReleaseTrustRoot)(),
						(io.probeOci ?? probeGovernedSandbox)(),
					)
				: evaluateRunnerPreflight(
						args,
						io.runReleaseGate ?? runTrustSpineReleaseGateCli,
					);
		const rendered = JSON.stringify(result, null, 2);
		if (result.ready) {
			stdout(rendered);
			return 0;
		}
		stderr(rendered);
		return 1;
	} catch (error) {
		stderr(`trust-spine-release-preflight: ${errorMessage(error)}`);
		return error instanceof PreflightUsageError ? 2 : 1;
	}
}

/** pnpm forwards an optional command delimiter as a literal argv entry. */
function stripPnpmArgumentDelimiter(
	argv: readonly string[],
): readonly string[] {
	return argv[0] === "--" ? argv.slice(1) : argv;
}

function evaluateHostPreflight(
	args: HostArguments,
	root: TrustSpineReleaseTrustRootV1,
	oci: GovernedSandboxProbeResult,
): TrustSpineReleasePreflightResultV1 {
	const checks: TrustSpineReleasePreflightCheckV1[] = [
		{
			id: "pinned_host_enrollment",
			state: root.trustedHosts.some(
				(host) =>
					host.realm === args.realm &&
					host.keyId === args.keyId &&
					host.actorId === args.actorId &&
					host.publicKeyHash === args.publicKeyHash,
			)
				? "ready"
				: "blocked",
			message:
				"The supplied public host binding must be enrolled in the pinned trust root.",
		},
		{
			id: "tape_signer_enrollment",
			state: root.trustedTapeSigners.length > 0 ? "ready" : "blocked",
			message:
				"The pinned trust root must authorize at least one ordinary tape signer.",
		},
		{
			id: "checkpoint_signer_enrollment",
			state: root.trustedCheckpointSigners.length > 0 ? "ready" : "blocked",
			message:
				"The pinned trust root must authorize a distinct checkpoint signer role.",
		},
		{
			id: "release_policy",
			state: root.releasePolicy === null ? "blocked" : "ready",
			message: "The pinned trust root must contain the closed release policy.",
		},
		{
			id: "rootless_oci_feasibility",
			state: oci.state === "feasible" ? "ready" : "blocked",
			message:
				oci.state === "feasible"
					? "The read-only host probe proved Linux/WSL, rootless Podman, user namespaces, and required isolation options."
					: (oci.failures[0]?.message ??
						"Rootless OCI feasibility could not be proven."),
		},
	];
	return Object.freeze({
		schemaVersion: PREFLIGHT_SCHEMA_VERSION,
		stage: "host",
		ready: checks.every((check) => check.state === "ready"),
		checks: Object.freeze(checks),
		limitations: Object.freeze([
			"This public preflight does not prove private-key custody, protected-host separation, provider access, or campaign evidence.",
			"The production executor performs a separate no-network isolated canary before it emits an OCI attestation; only a signed campaign bundle can satisfy the release gate.",
		]),
	});
}

function evaluateRunnerPreflight(
	args: RunnerArguments,
	runGate: TrustSpineReleasePreflightCliIO["runReleaseGate"],
): TrustSpineReleasePreflightResultV1 {
	if (runGate === undefined) {
		throw new Error("Trust Spine release gate runner is unavailable.");
	}
	const gateErrors: string[] = [];
	const exitCode = runGate(
		[
			"--bundle",
			args.bundlePath,
			"--commit",
			args.releaseCommit,
			"--ref",
			args.releaseRef,
		],
		{
			stdout: () => undefined,
			stderr: (line) => gateErrors.push(line),
		},
	);
	const ready = exitCode === 0;
	return Object.freeze({
		schemaVersion: PREFLIGHT_SCHEMA_VERSION,
		stage: "runner",
		ready,
		checks: Object.freeze([
			{
				id: "campaign_bundle_and_evidence",
				state: ready ? "ready" : "blocked",
				message: ready
					? "The pinned-root release gate accepted the immutable campaign bundle."
					: (gateErrors[0] ??
						"The pinned-root release gate rejected the campaign bundle."),
			},
		]),
		limitations: Object.freeze([
			"Runner preflight performs no artifact delivery or publication; the bundle must already be mounted as a regular, non-symlinked file.",
		]),
	});
}

function parseArguments(argv: readonly string[]): PreflightArguments {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (
			argument !== "--stage" &&
			argument !== "--realm" &&
			argument !== "--key-id" &&
			argument !== "--actor-id" &&
			argument !== "--public-key-hash" &&
			argument !== "--bundle" &&
			argument !== "--commit" &&
			argument !== "--ref"
		) {
			throw usage();
		}
		const value = argv[++index];
		if (!value || values.has(argument)) throw usage();
		values.set(argument, value);
	}
	const stage = values.get("--stage");
	if (stage === "host") {
		assertOnly(values, [
			"--stage",
			"--realm",
			"--key-id",
			"--actor-id",
			"--public-key-hash",
		]);
		const publicKeyHash = required(values, "--public-key-hash");
		if (!SHA256_DIGEST.test(publicKeyHash)) {
			throw new PreflightUsageError(
				"--public-key-hash must be a lowercase sha256 digest.",
			);
		}
		return Object.freeze({
			stage,
			realm: required(values, "--realm"),
			keyId: required(values, "--key-id"),
			actorId: required(values, "--actor-id"),
			publicKeyHash,
		});
	}
	if (stage === "runner") {
		assertOnly(values, ["--stage", "--bundle", "--commit", "--ref"]);
		const bundlePath = required(values, "--bundle");
		const releaseCommit = required(values, "--commit");
		const releaseRef = required(values, "--ref");
		if (!isAbsolute(bundlePath)) {
			throw new PreflightUsageError("--bundle must be an absolute path.");
		}
		if (!FULL_COMMIT.test(releaseCommit)) {
			throw new PreflightUsageError(
				"--commit must be a full lowercase hexadecimal SHA.",
			);
		}
		if (releaseRef !== CANONICAL_RELEASE_REF) {
			throw new PreflightUsageError(`--ref must be ${CANONICAL_RELEASE_REF}.`);
		}
		return Object.freeze({ stage, bundlePath, releaseCommit, releaseRef });
	}
	throw usage();
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
	const value = values.get(flag);
	if (!value) throw usage();
	return value;
}

function assertOnly(
	values: ReadonlyMap<string, string>,
	allowed: readonly string[],
): void {
	if ([...values.keys()].some((flag) => !allowed.includes(flag))) {
		throw usage();
	}
}

function usage(): PreflightUsageError {
	return new PreflightUsageError(
		"usage: trust-spine-release-preflight --stage host --realm <realm> --key-id <key-id> --actor-id <actor-id> --public-key-hash <sha256> | --stage runner --bundle <absolute-path> --commit <exact-sha> --ref refs/heads/main",
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const entrypoint = process.argv[1];
if (entrypoint?.endsWith("trust-spine-release-preflight-cli.ts")) {
	process.exitCode = runTrustSpineReleasePreflightCli(process.argv.slice(2));
}
