import { spawnSync } from "node:child_process";
import { platform as detectPlatform, release as detectRelease } from "node:os";

/**
 * This module deliberately probes only the prerequisites for a future governed
 * OCI worker. It never creates a container, pulls an image, starts a worker, or
 * authorizes a host fallback.
 */
export const GOVERNED_SANDBOX_PROBE_SCHEMA_VERSION = 1 as const;

/** The rootless OCI runtime supported by the initial governed feasibility lane. */
export type SupportedOciRuntime = "podman";

export type GovernedSandboxHostEnvironment =
	| "linux"
	| "wsl"
	| "windows"
	| "unsupported";

export type GovernedSandboxFailureCode =
	| "NON_LINUX_HOST"
	| "OCI_RUNTIME_UNAVAILABLE"
	| "OCI_RUNTIME_UNSUPPORTED"
	| "OCI_ROOTLESS_NOT_PROVEN"
	| "OCI_USER_NAMESPACE_UNAVAILABLE"
	| "OCI_ISOLATION_FLAGS_UNAVAILABLE";

export interface GovernedSandboxFailure {
	readonly code: GovernedSandboxFailureCode;
	readonly stage:
		| "host"
		| "runtime"
		| "rootless"
		| "user_namespace"
		| "isolation_flags";
	readonly message: string;
	readonly runtime?: SupportedOciRuntime;
	readonly exitCode?: number | null;
}

export interface GovernedSandboxProbeChecks {
	readonly linuxHost: boolean;
	readonly ociRuntime: boolean;
	readonly rootless: boolean;
	readonly userNamespace: boolean;
	readonly isolationFlags: boolean;
}

export interface GovernedSandboxRuntimeEvidence {
	readonly binary: SupportedOciRuntime;
	readonly version: string;
	readonly rootless: true;
	readonly userNamespace: true;
	readonly isolationFlags: true;
}

/**
 * A feasibility result is intentionally not an execution authorization. The
 * worker path remains unavailable until an ActionGateway and OCI executor are
 * wired to this probe.
 */
export interface GovernedSandboxProbeResult {
	readonly schemaVersion: typeof GOVERNED_SANDBOX_PROBE_SCHEMA_VERSION;
	readonly state: "feasible" | "blocked";
	readonly governedWorkerExecution: "not_implemented";
	readonly host: {
		readonly platform: string;
		readonly environment: GovernedSandboxHostEnvironment;
		readonly isWsl: boolean;
	};
	readonly runtime?: GovernedSandboxRuntimeEvidence;
	readonly checks: GovernedSandboxProbeChecks;
	readonly failures: readonly GovernedSandboxFailure[];
}

/** Minimal, injectable result shape for non-shell OCI prerequisite checks. */
export interface SandboxCommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}

/** Commands are fixed by the probe; callers never provide shell text. */
export type SandboxCommandRunner = (
	binary: SupportedOciRuntime,
	args: readonly string[],
) => SandboxCommandResult;

export interface GovernedSandboxProbeOptions {
	readonly platform?: string;
	readonly release?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly runCommand?: SandboxCommandRunner;
}

/**
 * Provider-neutral contract for the future API/SDK workers. It deliberately
 * exposes only signed identifiers and digest references: an implementation
 * must ask the host ActionGateway to perform effects rather than receive an
 * ambient shell, filesystem, network, or credentials.
 */
export type ProviderNeutralWorkerRole =
	| "implementer"
	| "reviewer"
	| "adversary"
	| "judge"
	| "candidate";

export interface ProviderNeutralWorkerRequest {
	readonly schemaVersion: 1;
	readonly requestId: string;
	readonly role: ProviderNeutralWorkerRole;
	readonly inputDigest: string;
	readonly outputSchemaDigest: string;
	readonly actionGatewayId: string;
}

export interface ProviderNeutralWorkerResult {
	readonly requestId: string;
	readonly outcome: "completed" | "failed" | "blocked";
	readonly outputDigest?: string;
	readonly actionReceiptDigests: readonly string[];
}

export interface ProviderNeutralWorker {
	readonly provider: string;
	readonly workerId: string;
	execute(
		request: ProviderNeutralWorkerRequest,
	): Promise<ProviderNeutralWorkerResult>;
}

const REQUIRED_PODMAN_ISOLATION_FLAGS = [
	"--read-only",
	"--network",
	"--cap-drop",
	"--security-opt",
	"--userns",
] as const;

/**
 * Determines whether this process can safely proceed to governed-sandbox
 * integration. A `feasible` result is not permission to execute a worker and
 * is intentionally returned only after Linux/WSL, Podman rootless mode, user
 * namespaces, and the required isolation flags have each been proven.
 */
export function probeGovernedSandbox(
	options: GovernedSandboxProbeOptions = {},
): GovernedSandboxProbeResult {
	const platform = options.platform ?? detectPlatform();
	const release = options.release ?? detectRelease();
	const environment = options.environment ?? process.env;
	const isWsl =
		platform === "linux" &&
		(/microsoft|wsl/i.test(release) ||
			environment.WSL_DISTRO_NAME !== undefined ||
			environment.WSL_INTEROP !== undefined);
	const hostEnvironment = classifyHostEnvironment(platform, isWsl);
	const host = {
		platform,
		environment: hostEnvironment,
		isWsl,
	};
	const checks = {
		linuxHost: platform === "linux",
		ociRuntime: false,
		rootless: false,
		userNamespace: false,
		isolationFlags: false,
	};

	// Windows and other non-Linux hosts cannot enter a governed lane through a
	// host-shell fallback. Do not even invoke the OCI runtime probe there.
	if (!checks.linuxHost) {
		return blocked(host, checks, {
			code: "NON_LINUX_HOST",
			stage: "host",
			message:
				"Governed execution requires a Linux or WSL Linux process with rootless OCI; host fallback is disabled.",
		});
	}

	const runCommand = options.runCommand ?? defaultSandboxCommandRunner;
	const versionResult = safelyRun(runCommand, "podman", ["--version"]);
	if (!commandSucceeded(versionResult)) {
		return blocked(host, checks, {
			code: "OCI_RUNTIME_UNAVAILABLE",
			stage: "runtime",
			runtime: "podman",
			exitCode: versionResult.status,
			message:
				"The supported rootless OCI runtime (podman) is unavailable; governed execution remains blocked.",
		});
	}
	const version = parsePodmanVersion(versionResult.stdout);
	if (version === null) {
		return blocked(host, checks, {
			code: "OCI_RUNTIME_UNSUPPORTED",
			stage: "runtime",
			runtime: "podman",
			exitCode: versionResult.status,
			message:
				"Podman did not report a parseable version, so governed isolation cannot be established.",
		});
	}
	checks.ociRuntime = true;

	const infoResult = safelyRun(runCommand, "podman", [
		"info",
		"--format",
		"json",
	]);
	if (!commandSucceeded(infoResult) || !podmanRootless(infoResult.stdout)) {
		return blocked(host, checks, {
			code: "OCI_ROOTLESS_NOT_PROVEN",
			stage: "rootless",
			runtime: "podman",
			exitCode: infoResult.status,
			message:
				"Podman rootless mode could not be proven; governed execution will not use a rootful runtime.",
		});
	}
	checks.rootless = true;

	const userNamespaceResult = safelyRun(runCommand, "podman", [
		"unshare",
		"true",
	]);
	if (!commandSucceeded(userNamespaceResult)) {
		return blocked(host, checks, {
			code: "OCI_USER_NAMESPACE_UNAVAILABLE",
			stage: "user_namespace",
			runtime: "podman",
			exitCode: userNamespaceResult.status,
			message:
				"Podman could not establish a rootless user namespace; governed execution remains blocked.",
		});
	}
	checks.userNamespace = true;

	const helpResult = safelyRun(runCommand, "podman", ["run", "--help"]);
	if (
		!commandSucceeded(helpResult) ||
		!hasRequiredIsolationFlags(helpResult.stdout)
	) {
		return blocked(host, checks, {
			code: "OCI_ISOLATION_FLAGS_UNAVAILABLE",
			stage: "isolation_flags",
			runtime: "podman",
			exitCode: helpResult.status,
			message:
				"Podman does not expose all required read-only, network, capability, security, and user-namespace flags.",
		});
	}
	checks.isolationFlags = true;

	return {
		schemaVersion: GOVERNED_SANDBOX_PROBE_SCHEMA_VERSION,
		state: "feasible",
		governedWorkerExecution: "not_implemented",
		host,
		runtime: {
			binary: "podman",
			version,
			rootless: true,
			userNamespace: true,
			isolationFlags: true,
		},
		checks,
		failures: [],
	};
}

function blocked(
	host: GovernedSandboxProbeResult["host"],
	checks: GovernedSandboxProbeChecks,
	failure: GovernedSandboxFailure,
): GovernedSandboxProbeResult {
	return {
		schemaVersion: GOVERNED_SANDBOX_PROBE_SCHEMA_VERSION,
		state: "blocked",
		governedWorkerExecution: "not_implemented",
		host,
		checks,
		failures: [failure],
	};
}

function classifyHostEnvironment(
	platform: string,
	isWsl: boolean,
): GovernedSandboxHostEnvironment {
	if (platform === "linux") return isWsl ? "wsl" : "linux";
	if (platform === "win32") return "windows";
	return "unsupported";
}

function defaultSandboxCommandRunner(
	binary: SupportedOciRuntime,
	args: readonly string[],
): SandboxCommandResult {
	const result = spawnSync(binary, [...args], {
		encoding: "utf8",
		shell: false,
		windowsHide: true,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		...(result.error === undefined ? {} : { error: result.error.message }),
	};
}

function safelyRun(
	runCommand: SandboxCommandRunner,
	binary: SupportedOciRuntime,
	args: readonly string[],
): SandboxCommandResult {
	try {
		return runCommand(binary, args);
	} catch (error) {
		return {
			status: null,
			stdout: "",
			stderr: "",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function commandSucceeded(result: SandboxCommandResult): boolean {
	return result.status === 0 && result.error === undefined;
}

function parsePodmanVersion(stdout: string): string | null {
	const version =
		/\bpodman\s+version\s+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)/i.exec(
			stdout,
		)?.[1];
	return version ?? null;
}

function podmanRootless(stdout: string): boolean {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (
			!isRecord(parsed) ||
			!isRecord(parsed.host) ||
			!isRecord(parsed.host.security)
		) {
			return false;
		}
		return parsed.host.security.rootless === true;
	} catch {
		return false;
	}
}

function hasRequiredIsolationFlags(help: string): boolean {
	return REQUIRED_PODMAN_ISOLATION_FLAGS.every((flag) => help.includes(flag));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
