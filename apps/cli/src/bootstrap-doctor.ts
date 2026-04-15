import { spawnSync } from "node:child_process";
import { SUPPORTED_NODE_VERSION } from "./version-guard.js";

const PUBLISHED_MEMORY_CONTRACT_NOTE =
	"Published/global installs do not yet include a verified `buildplane memory ...` contract.";

export interface BootstrapDoctorProbeResult {
	readonly ok: boolean;
	readonly command: string;
	readonly detected?: string;
	readonly message: string;
}

export interface BootstrapDoctorCheck {
	readonly id: "node" | "npm" | "git";
	readonly label: string;
	readonly ok: boolean;
	readonly required: true;
	readonly expected?: string;
	readonly detected?: string;
	readonly command?: string;
	readonly message: string;
}

export interface BootstrapDoctorReport {
	readonly ok: boolean;
	readonly checks: readonly BootstrapDoctorCheck[];
	readonly notes: readonly string[];
}

export interface BootstrapDoctorOptions {
	readonly currentNodeVersion?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly probeCommand?: (
		command: string,
		args: readonly string[],
	) => BootstrapDoctorProbeResult;
	readonly npmCommand?: string;
	readonly gitCommand?: string;
}

function defaultProbeCommand(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): BootstrapDoctorProbeResult {
	const invocation = [command, ...args].join(" ");
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		env,
	});

	if (result.error) {
		const error = result.error as NodeJS.ErrnoException;
		return {
			ok: false,
			command: invocation,
			message:
				error.code === "ENOENT" ? "command not available" : error.message,
		};
	}

	if (result.status !== 0) {
		const detected = result.stderr.trim() || result.stdout.trim() || undefined;
		return {
			ok: false,
			command: invocation,
			detected,
			message: `exited with status ${result.status}`,
		};
	}

	const detected = result.stdout.trim() || result.stderr.trim() || undefined;
	return {
		ok: true,
		command: invocation,
		detected,
		message: detected || `${command} is available`,
	};
}

function createNodeCheck(currentNodeVersion: string): BootstrapDoctorCheck {
	const ok = currentNodeVersion === SUPPORTED_NODE_VERSION;
	return {
		id: "node",
		label: "Node.js",
		ok,
		required: true,
		expected: SUPPORTED_NODE_VERSION,
		detected: currentNodeVersion,
		message: ok
			? `detected ${currentNodeVersion} (requires ${SUPPORTED_NODE_VERSION})`
			: `Buildplane requires Node ${SUPPORTED_NODE_VERSION}. Detected ${currentNodeVersion}.`,
	};
}

function createCommandCheck(
	id: "npm" | "git",
	label: string,
	command: string,
	args: readonly string[],
	probeCommand: NonNullable<BootstrapDoctorOptions["probeCommand"]>,
): BootstrapDoctorCheck {
	const probe = probeCommand(command, args);
	return {
		id,
		label,
		ok: probe.ok,
		required: true,
		command: probe.command,
		detected: probe.detected,
		message: probe.message,
	};
}

export function inspectBootstrapDoctor(
	options: BootstrapDoctorOptions = {},
): BootstrapDoctorReport {
	const currentNodeVersion =
		options.currentNodeVersion ?? process.versions.node;
	const env = options.env ?? process.env;
	const probeCommand =
		options.probeCommand ??
		((command: string, args: readonly string[]) =>
			defaultProbeCommand(command, args, env));

	const checks = [
		createNodeCheck(currentNodeVersion),
		createCommandCheck(
			"npm",
			"npm",
			options.npmCommand ?? "npm",
			["--version"],
			probeCommand,
		),
		createCommandCheck(
			"git",
			"git",
			options.gitCommand ?? "git",
			["--version"],
			probeCommand,
		),
	] as const;

	return {
		ok: checks.every((check) => check.ok),
		checks,
		notes: [PUBLISHED_MEMORY_CONTRACT_NOTE],
	};
}
