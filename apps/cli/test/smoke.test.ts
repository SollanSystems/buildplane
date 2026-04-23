import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBootstrapBanner } from "../src/index";

const root = resolve(import.meta.dirname, "../../..");
const cliSourceEntrypoint = resolve(root, "apps/cli/src/index.ts");
const cliDistEntrypoint = resolve(root, "apps/cli/dist/index.js");
const tsxLoaderEntrypoint = resolve(root, "node_modules/tsx/dist/loader.mjs");
const cleanupPaths: string[] = [];

function sourceCliArgs(entrypoint: string, ...args: string[]): string[] {
	return [
		"--conditions",
		"source",
		"--import",
		tsxLoaderEntrypoint,
		entrypoint,
		...args,
	];
}

function ensureBuiltCliDist(): void {
	execFileSync("pnpm", ["--filter", "buildplane", "build"], {
		cwd: root,
		encoding: "utf8",
	});
	expect(existsSync(cliDistEntrypoint)).toBe(true);
}

function writeNativeStub(path: string, which: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`#!/bin/sh\nprintf '{"ok":true,"which":"${which}","argv":"%s"}\\n' "$*"\n`,
	);
	spawnSync("chmod", ["+x", path], { encoding: "utf8" });
}

function runSourceMemoryDoctor(
	workspaceRoot: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	return spawnSync(
		process.execPath,
		sourceCliArgs(cliSourceEntrypoint, "memory", "doctor", "--json"),
		{
			cwd: workspaceRoot,
			encoding: "utf8",
			env,
		},
	);
}

function runSourcePackShow(
	workspaceRoot: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	return spawnSync(
		process.execPath,
		sourceCliArgs(cliSourceEntrypoint, "pack", "show", "superclaude"),
		{
			cwd: workspaceRoot,
			encoding: "utf8",
			env,
		},
	);
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { force: true, recursive: true });
	}
});

describe("cli bootstrap", () => {
	it("returns the buildplane bootstrap banner", () => {
		expect(getBootstrapBanner()).toContain("Buildplane");
	});

	it("emits top-level help when invoked via the root script entrypoint", () => {
		const output = execFileSync(
			process.execPath,
			["--conditions", "source", "--import", "tsx", "./apps/cli/src/index.ts"],
			{ cwd: root, encoding: "utf8" },
		).trim();

		expect(output).toContain("Buildplane by SollanSystems");
		expect(output).toContain("Execute:");
		expect(output).toContain("init");
	});

	it("supports --help via the root script entrypoint", () => {
		const output = execFileSync(
			process.execPath,
			[
				"--conditions",
				"source",
				"--import",
				"tsx",
				"./apps/cli/src/index.ts",
				"--help",
			],
			{ cwd: root, encoding: "utf8" },
		).trim();

		expect(output).toContain("Execute:");
		expect(output).toContain("run --packet <path>");
	});

	it("runs init when the source CLI is invoked through a symlinked entrypoint", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "buildplane-cli-symlink-"));
		const workspaceRoot = join(tempRoot, "workspace");
		const symlinkPath = join(tempRoot, "buildplane");
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		symlinkSync(cliSourceEntrypoint, symlinkPath, "file");

		execFileSync(process.execPath, sourceCliArgs(symlinkPath, "init"), {
			cwd: workspaceRoot,
			encoding: "utf8",
		});

		expect(existsSync(join(workspaceRoot, ".buildplane", "state.db"))).toBe(
			true,
		);
	});

	it("keeps stderr clean for source init and status --json", () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "buildplane-cli-clean-"));
		cleanupPaths.push(workspaceRoot);

		const initResult = spawnSync(
			process.execPath,
			sourceCliArgs(cliSourceEntrypoint, "init"),
			{
				cwd: workspaceRoot,
				encoding: "utf8",
			},
		);
		expect(initResult.status).toBe(0);
		expect(initResult.stderr).toBe("");

		const statusResult = spawnSync(
			process.execPath,
			sourceCliArgs(cliSourceEntrypoint, "status", "--json"),
			{
				cwd: workspaceRoot,
				encoding: "utf8",
			},
		);
		expect(statusResult.status).toBe(0);
		expect(statusResult.stderr).toBe("");
		expect(JSON.parse(statusResult.stdout)).toMatchObject({
			initialized: true,
		});
	}, 10_000);

	it("delegates source CLI memory commands through BUILDPLANE_NATIVE_BIN", () => {
		const tempRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-smoke-"),
		);
		const workspaceRoot = join(tempRoot, "workspace");
		const nativeBin = join(tempRoot, "buildplane-native");
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		writeNativeStub(nativeBin, "env");

		const result = runSourceMemoryDoctor(workspaceRoot, {
			...process.env,
			BUILDPLANE_NATIVE_BIN: nativeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			which: "env",
			argv: "memory doctor --json",
		});
	});

	it("returns JSON when source CLI memory dispatch cannot start the native binary", () => {
		const tempRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-json-error-"),
		);
		const workspaceRoot = join(tempRoot, "workspace");
		const missingNativeBin = join(tempRoot, "missing-buildplane-native");
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });

		const result = runSourceMemoryDoctor(workspaceRoot, {
			...process.env,
			BUILDPLANE_NATIVE_BIN: missingNativeBin,
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toBe("");
		const payload = JSON.parse(result.stdout);
		expect(payload).toMatchObject({
			error: { code: "NATIVE_COMMAND_DISPATCH_FAILED" },
		});
		expect(payload.error.message).toContain(
			"Failed to dispatch to the native memory command runner.",
		);
		expect(payload.error.message).toContain("BUILDPLANE_NATIVE_BIN");
		expect(payload.error.message).toContain("buildplane-native");
	});

	it("delegates source CLI pack show through BUILDPLANE_NATIVE_BIN", () => {
		const tempRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pack-show-smoke-"),
		);
		const workspaceRoot = join(tempRoot, "workspace");
		const nativeBin = join(tempRoot, "buildplane-native");
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		writeNativeStub(nativeBin, "pack-show-source");

		const result = runSourcePackShow(workspaceRoot, {
			...process.env,
			BUILDPLANE_NATIVE_BIN: nativeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			which: "pack-show-source",
			argv: "pack show superclaude",
		});
	});

	it("uses a cwd-local debug native binary when BUILDPLANE_NATIVE_BIN is unset", () => {
		const tempRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-debug-"),
		);
		const workspaceRoot = join(tempRoot, "workspace");
		const debugNativeBin = join(
			workspaceRoot,
			"native",
			"target",
			"debug",
			"buildplane-native",
		);
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		writeNativeStub(debugNativeBin, "debug");

		const result = runSourceMemoryDoctor(workspaceRoot, {
			...process.env,
			BUILDPLANE_NATIVE_BIN: "",
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			which: "debug",
			argv: "memory doctor --json",
		});
	});

	it("falls back to a cwd-local release native binary when debug is absent", () => {
		const tempRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-release-"),
		);
		const workspaceRoot = join(tempRoot, "workspace");
		const releaseNativeBin = join(
			workspaceRoot,
			"native",
			"target",
			"release",
			"buildplane-native",
		);
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		writeNativeStub(releaseNativeBin, "release");

		const result = runSourceMemoryDoctor(workspaceRoot, {
			...process.env,
			BUILDPLANE_NATIVE_BIN: "",
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			which: "release",
			argv: "memory doctor --json",
		});
	});

	it("falls back to buildplane-native on PATH when no explicit or cwd-local binary exists", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "buildplane-cli-memory-path-"));
		const workspaceRoot = join(tempRoot, "workspace");
		const pathNativeBin = join(tempRoot, "buildplane-native");
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		writeNativeStub(pathNativeBin, "path");

		const result = runSourceMemoryDoctor(workspaceRoot, {
			...process.env,
			BUILDPLANE_NATIVE_BIN: "",
			PATH: `${tempRoot}:${process.env.PATH ?? ""}`,
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			which: "path",
			argv: "memory doctor --json",
		});
	});

	it("delegates built CLI memory commands through BUILDPLANE_NATIVE_BIN", () => {
		ensureBuiltCliDist();
		const tempRoot = mkdtempSync(join(tmpdir(), "buildplane-cli-memory-dist-"));
		const workspaceRoot = join(tempRoot, "workspace");
		const nativeBin = join(tempRoot, "buildplane-native");
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		writeNativeStub(nativeBin, "env-built");

		const result = spawnSync(
			process.execPath,
			[cliDistEntrypoint, "memory", "doctor", "--json"],
			{
				cwd: workspaceRoot,
				encoding: "utf8",
				env: {
					...process.env,
					BUILDPLANE_NATIVE_BIN: nativeBin,
				},
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			which: "env-built",
			argv: "memory doctor --json",
		});
	});

	it("delegates built CLI pack show through BUILDPLANE_NATIVE_BIN", () => {
		ensureBuiltCliDist();
		const tempRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pack-show-dist-"),
		);
		const workspaceRoot = join(tempRoot, "workspace");
		const nativeBin = join(tempRoot, "buildplane-native");
		cleanupPaths.push(tempRoot);
		mkdirSync(workspaceRoot, { recursive: true });
		writeNativeStub(nativeBin, "pack-show-built");

		const result = spawnSync(
			process.execPath,
			[cliDistEntrypoint, "pack", "show", "superclaude"],
			{
				cwd: workspaceRoot,
				encoding: "utf8",
				env: {
					...process.env,
					BUILDPLANE_NATIVE_BIN: nativeBin,
				},
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			which: "pack-show-built",
			argv: "pack show superclaude",
		});
	});
});
