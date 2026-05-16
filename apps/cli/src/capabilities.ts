import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_NODE_RANGE = ">=24.13.1 <25";

interface SemverParts {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
}

export interface CapabilityProbeResult {
	readonly ok: boolean;
	readonly available: boolean;
	readonly command?: string;
	readonly detected?: string;
	readonly message: string;
}

export interface CapabilityCheck {
	readonly id:
		| "node"
		| "node_sqlite"
		| "npm"
		| "git"
		| "published_run"
		| "native_binary"
		| "repo_local_memory"
		| "published_memory";
	readonly label: string;
	readonly ok: boolean;
	readonly required: boolean;
	readonly available: boolean;
	readonly expected?: string;
	readonly detected?: string;
	readonly command?: string;
	readonly message: string;
}

export interface CapabilityReport {
	readonly ok: boolean;
	readonly environment: {
		readonly detectedNodeVersion: string;
		readonly supportedNodeRange: string;
	};
	readonly capabilities: readonly CapabilityCheck[];
	readonly notes: readonly string[];
}

export interface InspectCapabilitiesOptions {
	readonly currentNodeVersion?: string;
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly probeCommand?: (
		command: string,
		args: readonly string[],
	) => CapabilityProbeResult;
	readonly detectNodeSqlite?: () => CapabilityProbeResult;
	readonly resolveNativeBinary?: (
		cwd: string,
		env: NodeJS.ProcessEnv,
	) => string | undefined;
	readonly resolvePackagedNativeBinary?: (
		env: NodeJS.ProcessEnv,
	) => string | undefined;
	readonly npmCommand?: string;
	readonly gitCommand?: string;
}

const requireFromHere = createRequire(import.meta.url);

function parseNodeVersion(version: string): SemverParts | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
	if (!match) {
		return null;
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

function compareSemver(a: SemverParts, b: SemverParts): number {
	if (a.major !== b.major) {
		return a.major - b.major;
	}
	if (a.minor !== b.minor) {
		return a.minor - b.minor;
	}
	return a.patch - b.patch;
}

export function isSupportedNodeVersion(version: string): boolean {
	const parsed = parseNodeVersion(version);
	if (!parsed) {
		return false;
	}
	return (
		compareSemver(parsed, { major: 24, minor: 13, patch: 1 }) >= 0 &&
		parsed.major < 25
	);
}

export function formatUnsupportedNodeVersionMessage(version: string): string {
	return `Buildplane requires Node ${SUPPORTED_NODE_RANGE}. Detected ${version}.`;
}

function defaultProbeCommand(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): CapabilityProbeResult {
	const invocation = [command, ...args].join(" ");
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		env,
	});

	if (result.error) {
		const error = result.error as NodeJS.ErrnoException;
		return {
			ok: false,
			available: false,
			command: invocation,
			message:
				error.code === "ENOENT" ? "command not available" : error.message,
		};
	}

	if (result.status !== 0) {
		const detected = result.stderr.trim() || result.stdout.trim() || undefined;
		const reason =
			result.status === null
				? result.signal
					? `terminated by signal ${result.signal}`
					: "terminated before exit status was available"
				: `exited with status ${result.status}`;
		return {
			ok: false,
			available: false,
			command: invocation,
			detected,
			message: reason,
		};
	}

	const detected = result.stdout.trim() || result.stderr.trim() || undefined;
	return {
		ok: true,
		available: true,
		command: invocation,
		detected,
		message: detected || `${command} is available`,
	};
}

export function detectNodeSqliteCapability(): CapabilityProbeResult {
	try {
		requireFromHere("node:sqlite");
		return {
			ok: true,
			available: true,
			message: "node:sqlite import available",
		};
	} catch (error) {
		return {
			ok: false,
			available: false,
			message:
				error instanceof Error ? error.message : "node:sqlite import failed",
		};
	}
}

export function isNodeSqliteAvailable(): boolean {
	return detectNodeSqliteCapability().ok;
}

function findExecutableOnPath(
	executable: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const pathValue = env.PATH ?? env.Path;
	if (!pathValue) {
		return undefined;
	}

	const extensions =
		process.platform === "win32"
			? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
			: [""];
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) {
			continue;
		}
		for (const extension of extensions) {
			const candidate = resolve(directory, `${executable}${extension}`);
			try {
				const stat = statSync(candidate);
				if (stat.isFile()) {
					if (process.platform === "win32") {
						return candidate;
					}
					if ((stat.mode & 0o111) !== 0) {
						return candidate;
					}
				}
			} catch {
				// Ignore missing or unreadable candidates.
			}
		}
	}
	return undefined;
}

function isExecutableFile(path: string): boolean {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) {
			return false;
		}
		if (process.platform === "win32") {
			return true;
		}
		return (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function currentPackagedNativeTarget():
	| { readonly binaryName: string; readonly platform: "linux-x64" }
	| undefined {
	if (process.platform !== "linux" || process.arch !== "x64") {
		return undefined;
	}

	return {
		binaryName: "buildplane-native",
		platform: "linux-x64",
	};
}

function packagedNativeUnavailableMessage(): string {
	if (process.platform === "linux" && process.arch === "x64") {
		return "packaged linux-x64 native binary not found in vendor/native";
	}

	return `packaged native memory unavailable for ${process.platform}-${process.arch}; linux-x64 is currently the only packaged native target`;
}

function defaultResolvePackagedNativeBinary(
	_env: NodeJS.ProcessEnv,
): string | undefined {
	const target = currentPackagedNativeTarget();
	if (!target) {
		return undefined;
	}

	const candidate = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"vendor",
		"native",
		target.platform,
		target.binaryName,
	);
	if (!isExecutableFile(candidate)) {
		return undefined;
	}

	return candidate;
}

function defaultResolveNativeBinary(
	cwd: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	if (env.BUILDPLANE_NATIVE_BIN) {
		return findExecutableOnPath(env.BUILDPLANE_NATIVE_BIN, env);
	}

	const packagedNative = defaultResolvePackagedNativeBinary(env);
	if (packagedNative) {
		return packagedNative;
	}

	const targets =
		process.platform === "win32"
			? ["buildplane-native.exe", "buildplane-native"]
			: ["buildplane-native"];
	for (const target of targets) {
		for (const candidate of [
			resolve(cwd, "native", "target", "debug", target),
			resolve(cwd, "native", "target", "release", target),
		]) {
			if (existsSync(candidate)) {
				return findExecutableOnPath(candidate, env) ?? candidate;
			}
		}
	}
	return findExecutableOnPath("buildplane-native", env);
}

function requiredCommandCapability(
	id: "npm" | "git",
	label: string,
	command: string,
	probeCommand: NonNullable<InspectCapabilitiesOptions["probeCommand"]>,
): CapabilityCheck {
	const probe = probeCommand(command, ["--version"]);
	return {
		id,
		label,
		ok: probe.ok,
		required: true,
		available: probe.available,
		command: probe.command,
		detected: probe.detected,
		message: probe.message,
	};
}

export function inspectCapabilities(
	options: InspectCapabilitiesOptions = {},
): CapabilityReport {
	const currentNodeVersion =
		options.currentNodeVersion ?? process.versions.node;
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const probeCommand =
		options.probeCommand ??
		((command: string, args: readonly string[]) =>
			defaultProbeCommand(command, args, env));
	const detectNodeSqlite =
		options.detectNodeSqlite ?? detectNodeSqliteCapability;
	const resolveNativeBinary =
		options.resolveNativeBinary ?? defaultResolveNativeBinary;
	const resolvePackagedNativeBinary =
		options.resolvePackagedNativeBinary ?? defaultResolvePackagedNativeBinary;
	const packagedNativeBinary = resolvePackagedNativeBinary(env);
	const nativeBinary = resolveNativeBinary(cwd, env);
	const nodeOk = isSupportedNodeVersion(currentNodeVersion);
	const nodeSqlite = detectNodeSqlite();

	const capabilities: CapabilityCheck[] = [
		{
			id: "node",
			label: "Node.js",
			ok: nodeOk,
			required: true,
			available: nodeOk,
			expected: SUPPORTED_NODE_RANGE,
			detected: currentNodeVersion,
			message: nodeOk
				? `detected ${currentNodeVersion}; supports ${SUPPORTED_NODE_RANGE}`
				: formatUnsupportedNodeVersionMessage(currentNodeVersion),
		},
		{
			id: "node_sqlite",
			label: "node:sqlite",
			ok: nodeSqlite.ok,
			required: true,
			available: nodeSqlite.available,
			detected: nodeSqlite.detected,
			command: nodeSqlite.command,
			message: nodeSqlite.message,
		},
		requiredCommandCapability(
			"npm",
			"npm",
			options.npmCommand ?? "npm",
			probeCommand,
		),
		requiredCommandCapability(
			"git",
			"git",
			options.gitCommand ?? "git",
			probeCommand,
		),
		{
			id: "published_run",
			label: "Published run contract",
			ok: true,
			required: true,
			available: true,
			message:
				"verified published/global run contract is available when required checks pass",
		},
		{
			id: "native_binary",
			label: "Native binary",
			ok: Boolean(nativeBinary),
			required: false,
			available: Boolean(nativeBinary),
			detected: nativeBinary,
			message: nativeBinary
				? `native binary found at ${nativeBinary}`
				: "native binary not found in BUILDPLANE_NATIVE_BIN, packaged vendor/native, native/target, or PATH",
		},
		{
			id: "repo_local_memory",
			label: "Repo-local memory",
			ok: Boolean(nativeBinary),
			required: false,
			available: Boolean(nativeBinary),
			message: nativeBinary
				? "repo-local/native memory commands can use the discovered native binary"
				: "repo-local memory requires a separately built or supplied native binary",
		},
		{
			id: "published_memory",
			label: "Published memory",
			ok: Boolean(packagedNativeBinary),
			required: false,
			available: Boolean(packagedNativeBinary),
			detected: packagedNativeBinary,
			message: packagedNativeBinary
				? `published memory can use packaged native binary at ${packagedNativeBinary}`
				: packagedNativeUnavailableMessage(),
		},
	];

	return {
		ok: capabilities.every(
			(capability) => capability.ok || !capability.required,
		),
		environment: {
			detectedNodeVersion: currentNodeVersion,
			supportedNodeRange: SUPPORTED_NODE_RANGE,
		},
		capabilities,
		notes: [
			".node-version pins the tested development baseline; the published CLI accepts compatible Node 24 runtimes.",
			"Published memory is available only when the installed package includes a packaged native binary for this platform.",
		],
	};
}
