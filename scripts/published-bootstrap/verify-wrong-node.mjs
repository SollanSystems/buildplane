#!/usr/bin/env node
/**
 * CI-only wrong-Node guard verifier.
 *
 * This script MUST run under an intentionally unsupported Node version.
 * It requires BUILDPLANE_EXPECT_UNSUPPORTED_NODE=1 so accidental local runs
 * on a supported Node 24 runtime fail immediately with a clear message.
 *
 * What it proves:
 *   - pnpm build succeeds on the current runtime
 *   - the staged publish artifact can be packed from compiled output
 *   - the packed buildplane binary exits non-zero under the wrong-Node runtime
 *   - the error message includes ">=24.13.1 <25" (the supported range)
 *   - the error message includes the detected wrong version
 *   - failure happens before any normal CLI execution begins
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveSafeStagingParentDirectory } from "./stage-package.mjs";
import {
	fail,
	parseJson,
	REPO_ROOT,
	resolveCommandOnPath,
	resolveInstalledCliPath,
	resolveInstalledCommandDirectory,
} from "./verify-positive-lib.mjs";

const SUPPORTED_NODE_BASELINE = readFileSync(
	join(REPO_ROOT, ".node-version"),
	"utf8",
).trim();
const SUPPORTED_NODE_RANGE = ">=24.13.1 <25";
const CURRENT_NODE_VERSION = process.versions.node;

function parseNodeVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
	if (!match) {
		return null;
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

function compareNodeVersions(a, b) {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

function isSupportedNodeVersion(version) {
	const parsed = parseNodeVersion(version);
	if (!parsed) {
		return false;
	}
	return (
		compareNodeVersions(parsed, { major: 24, minor: 13, patch: 1 }) >= 0 &&
		parsed.major < 25
	);
}

function guardExpectedUnsupportedNode() {
	if (!process.env.BUILDPLANE_EXPECT_UNSUPPORTED_NODE) {
		fail(
			`verify-wrong-node.mjs requires BUILDPLANE_EXPECT_UNSUPPORTED_NODE=1.\n` +
				`This script must only run under an intentionally unsupported Node version.\n` +
				`Current Node version: ${CURRENT_NODE_VERSION}`,
		);
	}

	if (isSupportedNodeVersion(CURRENT_NODE_VERSION)) {
		fail(
			`verify-wrong-node.mjs is running on supported range ${SUPPORTED_NODE_RANGE}.\n` +
				`This script must run under a Node runtime outside ${SUPPORTED_NODE_RANGE} to prove the guard.\n` +
				`Current Node version: ${CURRENT_NODE_VERSION}; tested baseline: ${SUPPORTED_NODE_BASELINE}`,
		);
	}
}

function getErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function resolveRequiredCommandOnPath(commandName) {
	const resolved = resolveCommandOnPath(commandName, process.env.PATH);
	if (!resolved) {
		fail(`Unable to resolve required command on PATH: ${commandName}`);
	}

	return resolved;
}

function formatCommand(command, args) {
	return [command, ...args]
		.map((part) =>
			/^[A-Za-z0-9_./:@=-]+$/.test(part) ? part : JSON.stringify(part),
		)
		.join(" ");
}

function runCommand(command, args, options = {}) {
	const { cwd = REPO_ROOT, env = process.env } = options;
	const formattedCommand = formatCommand(command, args);
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env,
		shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
	});

	if (result.error) {
		fail(
			`Command failed to start: ${formattedCommand} (cwd: ${cwd})\n${getErrorMessage(result.error)}`,
		);
	}

	if (result.status !== 0) {
		const combinedOutput = [result.stdout, result.stderr]
			.filter(Boolean)
			.join("")
			.trim();
		fail(
			combinedOutput
				? `Command failed: ${formattedCommand} (cwd: ${cwd})\n${combinedOutput}`
				: `Command failed: ${formattedCommand} (cwd: ${cwd})`,
		);
	}

	return {
		stderr: result.stderr ?? "",
		stdout: result.stdout ?? "",
	};
}

function runCommandCapture(command, args, options = {}) {
	const { cwd = REPO_ROOT, env = process.env } = options;
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env,
		shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
	});

	return {
		exitCode: result.status ?? 1,
		stderr: result.stderr ?? "",
		stdout: result.stdout ?? "",
	};
}

function assertFile(path, description) {
	if (!existsSync(path) || !statSync(path).isFile()) {
		fail(`Missing ${description}: ${path}`);
	}
}

function main() {
	const tempPaths = [];

	try {
		guardExpectedUnsupportedNode();

		const PNPM_COMMAND = resolveRequiredCommandOnPath("pnpm");
		const NPM_COMMAND = resolveRequiredCommandOnPath("npm");

		console.log(
			`Running wrong-Node guard verification under Node ${CURRENT_NODE_VERSION} (supported: ${SUPPORTED_NODE_RANGE}; baseline: ${SUPPORTED_NODE_BASELINE})`,
		);

		console.log("== build ==");
		runCommand(PNPM_COMMAND, ["build"], { cwd: REPO_ROOT });

		console.log("== stage and pack ==");
		const { stdout: stageStdout } = runCommand(
			process.execPath,
			["./scripts/published-bootstrap/stage-package.mjs"],
			{ cwd: REPO_ROOT },
		);
		const staged = parseJson(stageStdout.trim(), "stage-package.mjs output");
		tempPaths.push(staged.stagingRoot);

		const { stdout: packStdout } = runCommand(NPM_COMMAND, ["pack", "--json"], {
			cwd: staged.packageRoot,
		});
		const packResult = parseJson(packStdout.trim(), "npm pack --json output");
		const tarballFilename = packResult?.[0]?.filename;
		if (typeof tarballFilename !== "string" || tarballFilename.length === 0) {
			fail("npm pack --json did not return a tarball filename");
		}

		const tarballPath = join(staged.packageRoot, tarballFilename);
		assertFile(tarballPath, "packed tarball");

		console.log("== install packed tarball ==");
		const npmPrefix = mkdtempSync(
			join(
				resolveSafeStagingParentDirectory(),
				"buildplane-wrong-node-prefix-",
			),
		);
		tempPaths.push(npmPrefix);

		const npmHome = mkdtempSync(
			join(resolveSafeStagingParentDirectory(), "buildplane-wrong-node-home-"),
		);
		tempPaths.push(npmHome);
		const npmUserConfig = join(npmHome, ".npmrc");
		writeFileSync(npmUserConfig, "");

		const installEnv = {
			...process.env,
			HOME: npmHome,
			USERPROFILE: npmHome,
			npm_config_cache: join(npmPrefix, "npm-cache"),
			npm_config_prefix: npmPrefix,
			npm_config_userconfig: npmUserConfig,
		};
		runCommand(
			NPM_COMMAND,
			["install", "-g", "--prefix", npmPrefix, tarballPath],
			{ cwd: REPO_ROOT, env: installEnv },
		);

		const buildplanePath = resolveInstalledCliPath(npmPrefix);
		assertFile(buildplanePath, "installed buildplane binary");

		console.log("== invoke under wrong-Node runtime ==");
		const runEnv = {
			...process.env,
			PATH: [
				resolveInstalledCommandDirectory(npmPrefix),
				process.env.PATH ?? "",
			]
				.filter(Boolean)
				.join(process.platform === "win32" ? ";" : ":"),
			HOME: npmHome,
			USERPROFILE: npmHome,
		};

		const result = runCommandCapture(buildplanePath, [], { env: runEnv });

		if (result.exitCode === 0) {
			fail(
				`Expected non-zero exit from buildplane under Node ${CURRENT_NODE_VERSION} but it exited 0`,
			);
		}

		const combinedOutput = [result.stdout, result.stderr]
			.filter(Boolean)
			.join("\n");

		if (!combinedOutput.includes(SUPPORTED_NODE_RANGE)) {
			fail(
				`Expected error output to mention supported range ${SUPPORTED_NODE_RANGE}\nGot: ${combinedOutput}`,
			);
		}

		if (!combinedOutput.includes(CURRENT_NODE_VERSION)) {
			fail(
				`Expected error output to mention detected version ${CURRENT_NODE_VERSION}\nGot: ${combinedOutput}`,
			);
		}

		console.log(
			`Wrong-Node guard verification passed: buildplane correctly rejected Node ${CURRENT_NODE_VERSION}.`,
		);
	} catch (error) {
		process.stderr.write(`${getErrorMessage(error)}\n`);
		process.exitCode = 1;
	} finally {
		for (const path of [...tempPaths].reverse()) {
			try {
				rmSync(path, { force: true, recursive: true });
			} catch {
				// best-effort cleanup
			}
		}
	}
}

main();
