import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

// Behavior-preserving lift of the native-binary resolution + signed-ledger
// emit helpers out of run-cli.ts (GAP-10). run-cli.ts re-imports these so its
// admit/dispatch/resume emit paths are unchanged; the new
// `planforge authorize-envelope` command imports them here without a circular
// `run-cli.ts` dependency.

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

function resolvePackagedNativeBinary(): string | undefined {
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
	return isExecutableFile(candidate) ? candidate : undefined;
}

/**
 * The governed lane never resolves a native executable from the workspace,
 * PATH, or `BUILDPLANE_NATIVE_BIN`. Those sources remain useful for raw and
 * development commands, but a repository can control all of them. Governed
 * authority instead requires the binary shipped next to this CLI package and
 * an immutable checksum captured when that package was assembled.
 */
const GOVERNED_NATIVE_INTEGRITY_FILE = "buildplane-native.sha256";
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface TrustedGovernedLedgerBinary {
	readonly kind: "packaged-native-v1";
	readonly path: string;
	readonly digest: string;
}

function packagedGovernedNativeIntegrityPath(binary: string): string {
	return join(dirname(binary), GOVERNED_NATIVE_INTEGRITY_FILE);
}

/**
 * Verify one packaged native binary against a separately published checksum.
 * This is exported for release-pipeline tests; it does not itself make an
 * arbitrary path trusted. Only {@link resolveTrustedGovernedLedgerBinary}
 * admits the package-owned location.
 */
export function verifyGovernedNativeBinaryIntegrity(
	binary: string,
	integrityFile = packagedGovernedNativeIntegrityPath(binary),
): TrustedGovernedLedgerBinary {
	const normalizedBinary = resolve(binary);
	const normalizedIntegrityFile = resolve(integrityFile);
	const binaryStat = lstatSync(normalizedBinary);
	const integrityStat = lstatSync(normalizedIntegrityFile);
	if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) {
		throw new Error(
			"governed native binary must be a regular package-owned file, not a symbolic link.",
		);
	}
	if (!integrityStat.isFile() || integrityStat.isSymbolicLink()) {
		throw new Error(
			"governed native integrity manifest must be a regular package-owned file, not a symbolic link.",
		);
	}
	const expected = readFileSync(normalizedIntegrityFile, "utf8");
	if (
		expected.length !== "sha256:".length + 64 + 1 ||
		!expected.endsWith("\n") ||
		!SHA256_DIGEST.test(expected.slice(0, -1))
	) {
		throw new Error(
			"governed native integrity manifest must contain exactly one lowercase sha256 digest followed by a newline.",
		);
	}
	const expectedDigest = expected.slice(0, -1);
	const actualDigest = `sha256:${createHash("sha256")
		.update(readFileSync(normalizedBinary))
		.digest("hex")}`;
	if (actualDigest !== expectedDigest) {
		throw new Error(
			"governed native binary digest does not match its package integrity manifest.",
		);
	}
	return Object.freeze({
		kind: "packaged-native-v1" as const,
		path: normalizedBinary,
		digest: actualDigest,
	});
}

/**
 * Resolve the only native artifact allowed to act as governed ledger/replay
 * authority. In a source checkout this intentionally fails: a locally built
 * native executable is a development artifact and can power `--raw`, never a
 * target-branch-affecting governed effect.
 */
export function resolveTrustedGovernedLedgerBinary(): TrustedGovernedLedgerBinary {
	const binary = resolvePackagedNativeBinary();
	if (!binary) {
		throw new Error(
			"Governed execution requires a packaged buildplane-native with a pinned integrity manifest; BUILDPLANE_NATIVE_BIN, PATH, and workspace native targets are raw/development-only.",
		);
	}
	return verifyGovernedNativeBinaryIntegrity(binary);
}

/**
 * Re-check the artifact immediately before every governed native invocation.
 * Keeping the expected digest from session setup means a replacement after
 * startup (including replacement of the adjacent manifest) is detected.
 */
export function assertTrustedGovernedLedgerBinary(
	trusted: TrustedGovernedLedgerBinary,
): TrustedGovernedLedgerBinary {
	if (!trusted || trusted.kind !== "packaged-native-v1") {
		throw new TypeError(
			"governed ledger binary must be a packaged-native-v1 identity.",
		);
	}
	if (typeof trusted.path !== "string" || typeof trusted.digest !== "string") {
		throw new TypeError("governed ledger binary identity is malformed.");
	}
	const current = resolveTrustedGovernedLedgerBinary();
	if (current.path !== trusted.path || current.digest !== trusted.digest) {
		throw new Error(
			"governed native binary changed after trust initialization; governed effects are blocked.",
		);
	}
	return current;
}

function resolveNativeBinary(cwd: string): string {
	const explicit = process.env.BUILDPLANE_NATIVE_BIN;
	if (explicit) {
		return explicit;
	}
	const packaged = resolvePackagedNativeBinary();
	if (packaged) {
		return packaged;
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
				return candidate;
			}
		}
	}
	return "buildplane-native";
}

export function resolveLedgerBinary(cwd: string): string {
	// The ledger binary is the same `buildplane-native` — just invoke with a
	// different subcommand. Reuse the existing resolution chain.
	return resolveNativeBinary(cwd);
}

export interface LedgerChild {
	child: ChildProcess;
	stdin: Writable;
	stderr: Readable;
	exit: Promise<number>;
}

/**
 * The only explicit configuration which enables native ActivityClaim V1
 * controls. These are actor/key identities, never key material. The native
 * process loads the configured key locally and derives the matching trusted
 * public-key hash before it admits a claim.
 */
export interface LedgerActivityClaimAuthorityOptions {
	readonly dispatchActorId: string;
	readonly dispatchKeyId: string;
	readonly actionRequestActorId: string;
	readonly actionRequestKeyId: string;
}

export interface SpawnLedgerSubprocessOptions {
	readonly sign?: boolean;
	readonly signingKeyId?: string;
	readonly signingActorId?: string;
	/**
	 * Governed V3-only capability. Its presence is intentionally fatal without
	 * signed append; an unsigned or partially configured child can never become
	 * an authority fallback.
	 */
	readonly activityClaimAuthority?: LedgerActivityClaimAuthorityOptions;
}

/**
 * Derive a suitable cwd for the ledger subprocess so the native binary can
 * resolve its default native-root. The binary looks for `native/Cargo.toml`
 * and `native/packs` relative to its cwd.
 *
 * Resolution order:
 *  1. If the binary lives inside a `.../native/target/{debug,release}/` tree,
 *     the project root is 4 directories up — use that.
 *  2. Otherwise fall back to `workspace` (the user's project root).  In a
 *     production install the binary is on PATH and the workspace itself may
 *     not have a native subtree; the binary is expected to degrade gracefully
 *     in that configuration.
 */
export function deriveLedgerSpawnCwd(
	binary: string,
	workspace: string,
): string {
	// Walk up: debug/release → target → native → <project-root>
	const parts = binary.replace(/\\/g, "/").split("/");
	const nativeIdx = parts.lastIndexOf("native");
	if (
		nativeIdx >= 0 &&
		parts[nativeIdx + 1] === "target" &&
		(parts[nativeIdx + 2] === "debug" || parts[nativeIdx + 2] === "release")
	) {
		return parts.slice(0, nativeIdx).join("/") || workspace;
	}
	return workspace;
}

export function spawnLedgerSubprocess(
	binary: string,
	runId: string,
	workspace: string,
	options: SpawnLedgerSubprocessOptions = {},
): LedgerChild {
	if (options.activityClaimAuthority !== undefined) {
		throw new TypeError(
			"native activity claims are unavailable until the native same-ledger replay/authorize/claim endpoint is implemented; the generic ledger subprocess never admits governed claims.",
		);
	}
	return spawnLedgerSubprocessInternal(binary, runId, workspace, options);
}

function spawnLedgerSubprocessInternal(
	binary: string,
	runId: string,
	workspace: string,
	options: SpawnLedgerSubprocessOptions,
	override?: {
		readonly args: readonly string[];
		readonly cwd: string;
		readonly env?: NodeJS.ProcessEnv;
	},
): LedgerChild {
	const spawnCwd = override?.cwd ?? deriveLedgerSpawnCwd(binary, workspace);
	const serveArgs =
		override?.args ?? buildLedgerServeArgs(runId, workspace, options);
	const child = spawn(binary, serveArgs, {
		stdio: ["pipe", "inherit", "pipe"],
		cwd: spawnCwd,
		...(override?.env === undefined ? {} : { env: override.env }),
	});
	if (!child.stdin || !child.stderr) {
		throw new Error("ledger subprocess stdio unexpectedly missing");
	}
	const exit = new Promise<number>((resolveExit, reject) => {
		child.on("exit", (code) => resolveExit(code ?? -1));
		// Handle spawn errors (e.g. binary not found) so they surface as a
		// rejected promise rather than an unhandled 'error' event.
		child.on("error", (err) => reject(err));
	});
	// Suppress unhandled-rejection noise for consumers that only attach .then()
	// (e.g. createTapeEmitter adds .then but no .catch on childExit).
	exit.catch(() => {});
	return {
		child,
		stdin: child.stdin as Writable,
		stderr: child.stderr as Readable,
		exit,
	};
}

/**
 * The former generic governed tape launcher is intentionally unavailable.
 *
 * A trusted binary does not make a caller-controlled stdin stream trusted: the
 * retired native endpoint could sign a fabricated dispatch/action pair and
 * then claim it. Keep every governed effect blocked until the native process
 * exposes one same-ledger replay/authorize/claim operation with no generic
 * authority-bearing event ingestion.
 */
export function spawnTrustedGovernedLedgerSubprocess(
	_trustedBinary: TrustedGovernedLedgerBinary,
	_runId: string,
): LedgerChild {
	throw new Error(
		"GOVERNED_AUTHORITY_ENDPOINT_UNAVAILABLE: generic governed ledger ingestion is disabled until the native same-ledger replay/authorize/claim endpoint is implemented.",
	);
}

/**
 * A governed native child never inherits a job, repository, or worker
 * environment. In particular this drops HOME, dynamic-loader hooks, keyring
 * overrides, Git indirection, and PATH-prepended helpers. The native realm
 * derives its state root from the Linux account rather than this environment.
 */
export function governedNativeEnvironment(): NodeJS.ProcessEnv {
	if (process.platform !== "linux") {
		throw new Error(
			"governed native authority requires Linux/WSL; host fallback is forbidden.",
		);
	}
	return Object.freeze({
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TZ: "UTC",
	});
}

/**
 * Pure argv builder kept separate from spawning so callers and tests can
 * inspect the exact native authority surface. It refuses to construct a
 * governed-claim child from partial identities rather than relying on the
 * native process to discover the error after a worker is already configured.
 */
export function buildLedgerServeArgs(
	runId: string,
	workspace: string,
	options: SpawnLedgerSubprocessOptions = {},
): string[] {
	const serveArgs = [
		"ledger",
		"serve",
		"--run-id",
		runId,
		"--workspace",
		workspace,
		"--schema-version",
		"1",
	];
	if (options.sign) {
		serveArgs.push(
			"--sign",
			"--signing-actor-id",
			options.signingActorId ?? "kernel",
			"--signing-key-id",
			options.signingKeyId ?? "kernel-main",
		);
	}
	const authority = options.activityClaimAuthority;
	if (!authority) return serveArgs;
	if (!options.sign) {
		throw new TypeError(
			"ActivityClaim V1 requires a signed ledger subprocess; unsigned governed authority is not supported.",
		);
	}
	const entries = [
		["dispatchActorId", authority.dispatchActorId],
		["dispatchKeyId", authority.dispatchKeyId],
		["actionRequestActorId", authority.actionRequestActorId],
		["actionRequestKeyId", authority.actionRequestKeyId],
	] as const;
	for (const [name, value] of entries) {
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new TypeError(
				`ActivityClaim V1 authority ${name} must be a non-empty actor/key identity.`,
			);
		}
	}
	serveArgs.push(
		"--enable-activity-claims",
		"--activity-claim-dispatch-actor-id",
		authority.dispatchActorId,
		"--activity-claim-dispatch-key-id",
		authority.dispatchKeyId,
		"--activity-claim-action-request-actor-id",
		authority.actionRequestActorId,
		"--activity-claim-action-request-key-id",
		authority.actionRequestKeyId,
	);
	return serveArgs;
}

export const PLANFORGE_KERNEL_SIGNING_KEY_ID = "kernel-main";

/**
 * Resolve the per-machine kernel signing-key path the native `ledger serve --sign`
 * subprocess reads. Honors `HOME` (then `USERPROFILE`, then `os.homedir()`) so it
 * matches the test harness's temp-HOME injection and the Rust key resolver.
 */
export function kernelSigningKeyPath(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? "";
	return join(
		home,
		".buildplane",
		"keys",
		"kernel",
		`${PLANFORGE_KERNEL_SIGNING_KEY_ID}.ed25519`,
	);
}

/**
 * Fail-fast precondition for any signed-tape path (run / dispatch). When the
 * kernel signing key is absent, a `ledger serve --sign` subprocess would fail
 * opaquely mid-handshake; throw an actionable error here instead. We never
 * auto-generate signing-key material (operator decision, M2-S5 flag #2).
 */
export function assertKernelSigningKey(): void {
	const keyPath = kernelSigningKeyPath();
	if (!existsSync(keyPath)) {
		throw new Error(
			`signed ledger requires a kernel signing key at ${keyPath}. ` +
				'Provision a kernel ed25519 key (actor "kernel", key-id "kernel-main") before running a signed run/dispatch. ' +
				"Buildplane does not auto-generate signing-key material.",
		);
	}
}
