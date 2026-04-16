import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const REQUIRED_BUILD_OUTPUTS = [
	"apps/cli/dist/index.js",
	"apps/cli/dist/run-cli.js",
	"apps/cli/dist/version-guard.js",
	"packages/kernel/dist/index.js",
	"packages/runtime/dist/index.js",
	"packages/policy/dist/index.js",
	"packages/storage/dist/index.js",
	"packages/adapters-git/dist/index.js",
] as const;

function ensureWorkspaceBuildOutputs() {
	const missing = REQUIRED_BUILD_OUTPUTS.filter(
		(relativePath) => !existsSync(join(root, relativePath)),
	);
	if (missing.length === 0) {
		return;
	}
	const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
	execFileSync(npxCommand, ["pnpm", "build"], { cwd: root, stdio: "pipe" });
}

describe("published bootstrap installer shim", () => {
	let stagePublishedPackage: () => { stagingRoot: string; packageRoot: string };
	let createSanitizedEnvironment: (
		npmPrefix: string,
		options?: Record<string, unknown>,
	) => NodeJS.ProcessEnv;
	let resolveInstalledCliPath: (
		npmPrefix: string,
		platform?: NodeJS.Platform,
	) => string;
	let resolveCommandOnPath: (
		commandName: string,
		pathValue?: string,
		platform?: NodeJS.Platform,
	) => string | undefined;

	beforeAll(async () => {
		ensureWorkspaceBuildOutputs();
		const stageModule = await import(
			"../../scripts/published-bootstrap/stage-package.mjs"
		);
		stagePublishedPackage = stageModule.stagePublishedPackage;
		const verifyLib = await import(
			"../../scripts/published-bootstrap/verify-positive-lib.mjs"
		);
		createSanitizedEnvironment = verifyLib.createSanitizedEnvironment;
		resolveInstalledCliPath = verifyLib.resolveInstalledCliPath;
		resolveCommandOnPath = verifyLib.resolveCommandOnPath;
	});

	it("installs a packed tarball through the installer shim into an isolated prefix", () => {
		const installerPath = join(
			root,
			"scripts",
			"published-bootstrap",
			"install.sh",
		);
		const staged = stagePublishedPackage();
		const npmCommand = resolveCommandOnPath("npm", process.env.PATH);
		const gitCommand = resolveCommandOnPath("git", process.env.PATH);
		if (!npmCommand || !gitCommand) {
			throw new Error("npm and git must be available for installer test");
		}
		const packed = JSON.parse(
			execFileSync(npmCommand, ["pack", "--json"], {
				cwd: staged.packageRoot,
				encoding: "utf8",
			}),
		) as Array<{ filename: string }>;
		const tarballPath = join(staged.packageRoot, packed[0]?.filename ?? "");
		const npmPrefix = mkdtempSync(
			join(tmpdir(), "buildplane-installer-prefix-"),
		);
		const npmHome = mkdtempSync(join(tmpdir(), "buildplane-installer-home-"));
		writeFileSync(join(npmHome, ".npmrc"), "");
		const installEnv = createSanitizedEnvironment(npmPrefix, {
			baseEnv: process.env,
			requiredCommandNames: [],
			requiredPathEntries: [dirname(process.execPath)],
			extra: {
				HOME: npmHome,
				USERPROFILE: npmHome,
				XDG_CONFIG_HOME: npmHome,
				npm_config_userconfig: join(npmHome, ".npmrc"),
				npm_config_cache: join(npmPrefix, "npm-cache"),
				BUILDPLANE_INSTALL_SPEC: tarballPath,
				BUILDPLANE_INSTALL_PREFIX: npmPrefix,
				BUILDPLANE_INSTALL_NPM: npmCommand,
				BUILDPLANE_INSTALL_GIT: gitCommand,
			},
		}) as NodeJS.ProcessEnv;

		const bashCommand = process.platform === "win32" ? "bash" : "/bin/bash";
		execFileSync(bashCommand, [installerPath], {
			cwd: root,
			env: installEnv,
			encoding: "utf8",
		});

		const installedCliPath = resolveInstalledCliPath(npmPrefix);
		expect(existsSync(installedCliPath)).toBe(true);
		const runEnv = createSanitizedEnvironment(npmPrefix, {
			baseEnv: process.env,
			requiredCommandNames: [],
			requiredPathEntries: [dirname(process.execPath)],
		}) as NodeJS.ProcessEnv;
		const helpCheck = () =>
			execFileSync(installedCliPath, ["--help"], {
				cwd: root,
				env: runEnv,
				encoding: "utf8",
			});
		if (process.versions.node === "24.13.1") {
			expect(helpCheck()).toContain("Buildplane by SollanSystems");
		} else {
			expect(helpCheck).toThrow(/Buildplane requires Node 24\.13\.1/i);
		}
	});
});
