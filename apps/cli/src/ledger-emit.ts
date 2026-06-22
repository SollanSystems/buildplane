import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
	options: { sign?: boolean; signingKeyId?: string } = {},
): LedgerChild {
	const spawnCwd = deriveLedgerSpawnCwd(binary, workspace);
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
			"--signing-key-id",
			options.signingKeyId ?? "kernel-main",
		);
	}
	const child = spawn(binary, serveArgs, {
		stdio: ["pipe", "inherit", "pipe"],
		cwd: spawnCwd,
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
