import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveSafeStagingParentDirectory } from "./stage-package.mjs";
import { extractTarballToDirectory } from "./tarball.mjs";
import {
	assertPackedInstallPathIsolation,
	createRepoStateGuard,
	createSanitizedEnvironment,
	createWorkspaceBuildArtifactGuard,
	fail,
	parseJson,
	REPO_ROOT,
	resolveCommandOnPath,
	resolveInstalledCliPath,
} from "./verify-positive-lib.mjs";

const PACKET_FIXTURE_RELATIVE_PATH =
	"test/fixtures/published-bootstrap/packet.json";
const INSTALLER_SHIM_PATH = join(
	REPO_ROOT,
	"scripts",
	"published-bootstrap",
	"install.sh",
);
const INSTALLER_ONE_LINER =
	'tmp="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/SollanSystems/buildplane/main/scripts/published-bootstrap/install.sh -o "$tmp" && bash "$tmp"';
const PACKET_FIXTURE_PATH = join(REPO_ROOT, PACKET_FIXTURE_RELATIVE_PATH);
const REQUIRED_STAGED_README_SNIPPETS = Object.freeze([
	INSTALLER_ONE_LINER,
	"npm install -g buildplane",
	"buildplane init",
	"buildplane run --packet",
	"buildplane status --json",
	"buildplane inspect <run-id> --json",
	"Published/global installs do not yet include a verified `buildplane memory ...` contract.",
]);
const PUBLISHED_SMOKE_UNIT_ID = "unit-published-bootstrap-smoke";
const FORBIDDEN_STAGED_README_PATTERNS = Object.freeze([
	/\bpnpm buildplane\b/i,
]);
const NPM_COMMAND = resolveRequiredCommand("npm");
const PNPM_COMMAND = resolveRequiredCommand("pnpm");
const GIT_COMMAND = resolveRequiredCommand("git");

function getErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function resolveRequiredCommand(commandName) {
	const resolvedCommand = resolveCommandOnPath(commandName, process.env.PATH);
	if (!resolvedCommand) {
		fail(`Unable to resolve required command on PATH: ${commandName}`);
	}

	return resolvedCommand;
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

function runJsonCommand(command, args, options = {}, description) {
	const { stdout, stderr } = runCommand(command, args, options);
	if (stderr.trim().length > 0) {
		fail(
			`JSON command produced stderr: ${description ?? formatCommand(command, args)}\n${stderr.trim()}`,
		);
	}
	return parseJson(stdout.trim(), description ?? formatCommand(command, args));
}

function parseRunId(stdout, commandDescription) {
	const match = stdout.match(/^run-id: (.+)$/m);
	if (!match?.[1]) {
		fail(`Missing run-id token in ${commandDescription} output`);
	}

	return match[1].trim();
}

function assertMinimumRunContract({ inspect, label, runId, status }) {
	if (status?.initialized !== true) {
		fail(`${label}: expected status.initialized === true`);
	}

	if (status?.latestRun?.id !== runId) {
		fail(`${label}: expected status.latestRun.id === ${runId}`);
	}

	if (status?.latestRun?.unitId !== PUBLISHED_SMOKE_UNIT_ID) {
		fail(
			`${label}: expected status.latestRun.unitId === ${PUBLISHED_SMOKE_UNIT_ID}`,
		);
	}

	if (status?.latestRun?.status !== "passed") {
		fail(`${label}: expected status.latestRun.status === "passed"`);
	}

	if (inspect?.kind !== "run") {
		fail(`${label}: expected inspect.kind === "run"`);
	}

	if (inspect?.unit?.id !== PUBLISHED_SMOKE_UNIT_ID) {
		fail(`${label}: expected inspect.unit.id === ${PUBLISHED_SMOKE_UNIT_ID}`);
	}

	if (inspect?.run?.id !== runId) {
		fail(`${label}: expected inspect.run.id === ${runId}`);
	}

	if (inspect?.run?.unitId !== PUBLISHED_SMOKE_UNIT_ID) {
		fail(
			`${label}: expected inspect.run.unitId === ${PUBLISHED_SMOKE_UNIT_ID}`,
		);
	}

	if (inspect?.run?.status !== "passed") {
		fail(`${label}: expected inspect.run.status === "passed"`);
	}

	if (!Array.isArray(inspect?.evidence)) {
		fail(`${label}: expected inspect.evidence to be an array`);
	}

	if (!Array.isArray(inspect?.decisions)) {
		fail(`${label}: expected inspect.decisions to be an array`);
	}
}

function assertNoCommandStderr(label, commandDescription, stderr) {
	if (stderr.trim().length > 0) {
		fail(
			`${label}: command produced unexpected stderr for ${commandDescription}\n${stderr.trim()}`,
		);
	}
}

function createCliRunner(command, prefixArgs = []) {
	return (args, options = {}) =>
		runCommand(command, [...prefixArgs, ...args], options);
}

function cliCommandName(cli) {
	return cli.command;
}

function cliCommandArgs(cli, args) {
	return [...cli.prefixArgs, ...args];
}

function makeInspectableCli(command, prefixArgs = []) {
	const runner = createCliRunner(command, prefixArgs);
	runner.command = command;
	runner.prefixArgs = prefixArgs;
	return runner;
}

function runSmokePhase(label, cli, options) {
	const { cwd, env, packetPath } = options;
	console.log(`== ${label} ==`);
	const initArgs = ["init"];
	const initResult = cli(initArgs, { cwd, env });
	assertNoCommandStderr(
		label,
		formatCommand(cliCommandName(cli), cliCommandArgs(cli, initArgs)),
		initResult.stderr,
	);
	const runArgs = ["run", "--raw", "--packet", packetPath];
	const runResult = cli(runArgs, { cwd, env });
	assertNoCommandStderr(
		label,
		formatCommand(cliCommandName(cli), cliCommandArgs(cli, runArgs)),
		runResult.stderr,
	);
	const runId = parseRunId(
		runResult.stdout,
		formatCommand(cliCommandName(cli), cliCommandArgs(cli, runArgs)),
	);
	const status = runJsonCommand(
		cliCommandName(cli),
		cliCommandArgs(cli, ["status", "--json"]),
		{ cwd, env },
		`${label} status`,
	);
	const inspect = runJsonCommand(
		cliCommandName(cli),
		cliCommandArgs(cli, ["inspect", runId, "--json"]),
		{ cwd, env },
		`${label} inspect`,
	);
	assertMinimumRunContract({ inspect, label, runId, status });
	console.log(`${label}: captured run-id ${runId}`);
	return runId;
}

function createGitRepo(tempPaths) {
	const root = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			"buildplane-published-bootstrap-repo-",
		),
	);
	const gitConfigRoot = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			"buildplane-published-bootstrap-git-config-",
		),
	);
	tempPaths.push(gitConfigRoot);
	const globalConfigPath = join(gitConfigRoot, "config");
	writeFileSync(globalConfigPath, "");
	console.log(`Created external git repo: ${root}`);
	const gitEnv = {
		...process.env,
		GIT_CONFIG_GLOBAL: globalConfigPath,
		GIT_CONFIG_NOSYSTEM: "1",
	};
	delete gitEnv.GIT_DIR;
	delete gitEnv.GIT_WORK_TREE;
	delete gitEnv.GIT_INDEX_FILE;
	delete gitEnv.GIT_OBJECT_DIRECTORY;
	delete gitEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	const git = (args) =>
		runCommand(GIT_COMMAND, args, { cwd: root, env: gitEnv });

	try {
		git(["-c", "commit.gpgSign=false", "init"]);
		git(["config", "user.name", "Buildplane Verifier"]);
		git(["config", "user.email", "verifier@example.com"]);
		writeFileSync(join(root, "tracked.txt"), "baseline\n");
		git(["add", "tracked.txt"]);
		git(["-c", "commit.gpgSign=false", "commit", "-m", "baseline"]);
		git(["rev-parse", "HEAD"]);
		return root;
	} catch (error) {
		rmSync(root, { force: true, recursive: true });
		throw error;
	}
}

function assertFile(path, description) {
	if (!existsSync(path) || !statSync(path).isFile()) {
		fail(`Missing ${description}: ${path}`);
	}
}

function extractTopLevelSection(markdown, heading) {
	const lines = markdown.split(/\r?\n/);
	let inCodeFence = false;
	let collecting = false;
	const collected = [];

	for (const line of lines) {
		if (/^```/.test(line)) {
			inCodeFence = !inCodeFence;
		}

		if (!inCodeFence && /^## /.test(line)) {
			if (collecting) {
				break;
			}

			collecting = line === heading;
		}

		if (collecting) {
			collected.push(line);
		}
	}

	return collected.join("\n");
}

function assertStageReadmeContract(readmePath) {
	const readme = readFileSync(readmePath, "utf8");
	const distributionSection = extractTopLevelSection(readme, "## Distribution");

	for (const snippet of REQUIRED_STAGED_README_SNIPPETS) {
		if (!distributionSection.includes(snippet)) {
			fail(
				`Staged README.md Distribution section is missing required snippet ${JSON.stringify(snippet)}: ${readmePath}`,
			);
		}
	}

	for (const pattern of FORBIDDEN_STAGED_README_PATTERNS) {
		if (pattern.test(distributionSection)) {
			fail(
				`Staged README.md Distribution section must omit repo-dev-only pnpm guidance: ${readmePath}`,
			);
		}
	}

	if (!/clean git working tree/i.test(distributionSection)) {
		fail(
			`Staged README.md Distribution section must mention the clean git working tree precondition: ${readmePath}`,
		);
	}
}

function createPackedInstallArtifacts(tarballPath) {
	const extractionRoot = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			"buildplane-published-bootstrap-pack-",
		),
	);

	try {
		extractTarballToDirectory(tarballPath, extractionRoot);
		assertFile(
			join(extractionRoot, "package", "package.json"),
			"packed tarball package.json",
		);
		return extractionRoot;
	} catch (error) {
		rmSync(extractionRoot, { force: true, recursive: true });
		throw error;
	}
}

function createCommandShimDirectory(tempPaths, commandName, targetPath) {
	const shimRoot = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			`buildplane-published-bootstrap-${commandName}-shim-`,
		),
	);
	tempPaths.push(shimRoot);

	if (process.platform === "win32") {
		const shimPath = join(shimRoot, `${commandName}.cmd`);
		writeFileSync(shimPath, `@echo off\r\n"${targetPath}" %*\r\n`);
		return shimRoot;
	}

	const shimPath = join(shimRoot, commandName);
	writeFileSync(shimPath, `#!/bin/sh\nexec "${targetPath}" "$@"\n`);
	chmodSync(shimPath, 0o755);
	return shimRoot;
}

function createNodeShimDirectory(tempPaths) {
	return createCommandShimDirectory(tempPaths, "node", process.execPath);
}

function runExternalPackedInstallSmoke(tarballPath, tempPaths) {
	const externalRepoRoot = createGitRepo(tempPaths);
	tempPaths.push(externalRepoRoot);

	const packetRoot = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			"buildplane-published-bootstrap-packet-",
		),
	);
	tempPaths.push(packetRoot);
	const packetPath = join(packetRoot, "packet.json");
	cpSync(PACKET_FIXTURE_PATH, packetPath);

	const npmPrefix = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			"buildplane-published-bootstrap-prefix-",
		),
	);
	tempPaths.push(npmPrefix);
	const npmHome = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			"buildplane-published-bootstrap-home-",
		),
	);
	tempPaths.push(npmHome);
	const npmUserConfig = join(npmHome, ".npmrc");
	writeFileSync(npmUserConfig, "");
	const nodeShimDir = createNodeShimDirectory(tempPaths);
	const gitShimDir = createCommandShimDirectory(tempPaths, "git", GIT_COMMAND);
	const npmCache = join(npmPrefix, "npm-cache");
	const installEnv = createSanitizedEnvironment(npmPrefix, {
		baseEnv: process.env,
		extra: {
			HOME: npmHome,
			USERPROFILE: npmHome,
			XDG_CONFIG_HOME: npmHome,
			npm_config_cache: npmCache,
			npm_config_prefix: npmPrefix,
			npm_config_userconfig: npmUserConfig,
		},
		repoRoot: REPO_ROOT,
		requiredCommandNames: [],
		requiredPathEntries: [nodeShimDir],
	});

	console.log(`Installing packed CLI into isolated npm prefix: ${npmPrefix}`);
	runCommand(
		process.platform === "win32" ? "bash" : "/bin/bash",
		[INSTALLER_SHIM_PATH],
		{
			cwd: externalRepoRoot,
			env: {
				...installEnv,
				BUILDPLANE_INSTALL_SPEC: tarballPath,
				BUILDPLANE_INSTALL_PREFIX: npmPrefix,
				BUILDPLANE_INSTALL_NPM: NPM_COMMAND,
				BUILDPLANE_INSTALL_GIT: GIT_COMMAND,
			},
		},
	);
	assertFile(resolveInstalledCliPath(npmPrefix), "published buildplane binary");

	const runEnv = createSanitizedEnvironment(npmPrefix, {
		baseEnv: process.env,
		extra: {
			HOME: npmHome,
			USERPROFILE: npmHome,
			XDG_CONFIG_HOME: npmHome,
			npm_config_userconfig: npmUserConfig,
		},
		repoRoot: REPO_ROOT,
		requiredCommandNames: [],
		requiredPathEntries: [nodeShimDir, gitShimDir],
	});
	const { buildplanePath } = assertPackedInstallPathIsolation({
		env: runEnv,
		npmPrefix,
		repoRoot: REPO_ROOT,
	});
	console.log(
		`external packed-install smoke: buildplane resolves to ${buildplanePath}`,
	);

	const publishedCli = makeInspectableCli(buildplanePath, []);
	runSmokePhase("external packed-install smoke", publishedCli, {
		cwd: externalRepoRoot,
		env: runEnv,
		packetPath,
	});
}

function createCleanupRunner({
	buildArtifactGuard,
	repoStateGuard,
	tempPaths,
}) {
	let cleaned = false;

	return () => {
		if (cleaned) {
			return;
		}

		cleaned = true;
		const cleanupErrors = [];

		try {
			repoStateGuard.restore();
		} catch (error) {
			cleanupErrors.push(
				`repo state restore failed: ${getErrorMessage(error)}`,
			);
		}

		try {
			buildArtifactGuard.restore();
		} catch (error) {
			cleanupErrors.push(
				`workspace build artifact restore failed: ${getErrorMessage(error)}`,
			);
		}

		for (const path of [...tempPaths].reverse()) {
			try {
				rmSync(path, { force: true, recursive: true });
			} catch (error) {
				cleanupErrors.push(
					`temporary path cleanup failed for ${path}: ${getErrorMessage(error)}`,
				);
			}
		}

		if (cleanupErrors.length > 0) {
			fail(`Cleanup failed\n${cleanupErrors.join("\n")}`);
		}
	};
}

function createSignalCleanupController(cleanup) {
	const handleSignal = (signal, exitCode) => {
		try {
			cleanup();
		} catch (error) {
			process.stderr.write(
				`Cleanup failed after ${signal}: ${getErrorMessage(error)}\n`,
			);
		}
		process.stderr.write(`Interrupted by ${signal}\n`);
		process.exit(exitCode);
	};

	const handleSigint = () => handleSignal("SIGINT", 130);
	const handleSigterm = () => handleSignal("SIGTERM", 143);
	process.once("SIGINT", handleSigint);
	process.once("SIGTERM", handleSigterm);

	return {
		dispose() {
			process.off("SIGINT", handleSigint);
			process.off("SIGTERM", handleSigterm);
		},
	};
}

function main() {
	const tempPaths = [];
	const repoStateGuard = createRepoStateGuard(REPO_ROOT);
	const buildArtifactGuard = createWorkspaceBuildArtifactGuard(REPO_ROOT);
	const cleanup = createCleanupRunner({
		buildArtifactGuard,
		repoStateGuard,
		tempPaths,
	});
	const signalCleanupController = createSignalCleanupController(cleanup);

	try {
		repoStateGuard.reset();
		const repoDevCli = makeInspectableCli(PNPM_COMMAND, [
			"--silent",
			"buildplane",
		]);
		runSmokePhase("repo-dev smoke", repoDevCli, {
			cwd: REPO_ROOT,
			env: process.env,
			packetPath: PACKET_FIXTURE_RELATIVE_PATH,
		});
		repoStateGuard.reset();

		console.log("== repo verification gate ==");
		runCommand(PNPM_COMMAND, ["lint"], { cwd: REPO_ROOT });
		runCommand(PNPM_COMMAND, ["typecheck"], { cwd: REPO_ROOT });
		runCommand(PNPM_COMMAND, ["test"], { cwd: REPO_ROOT });
		runCommand(PNPM_COMMAND, ["build"], { cwd: REPO_ROOT });
		repoStateGuard.reset();

		console.log("built-path: rebuilding dist for built-path smoke...");
		runCommand(PNPM_COMMAND, ["exec", "tsc", "--build", "--force"], {
			cwd: REPO_ROOT,
		});
		const distIndexPath = join(REPO_ROOT, "apps/cli/dist/index.js");
		if (!existsSync(distIndexPath)) {
			fail(
				`built-path smoke: dist/index.js was not created by pnpm build (expected at ${distIndexPath})`,
			);
		}
		const builtCli = makeInspectableCli(process.execPath, [
			"apps/cli/dist/index.js",
		]);
		runSmokePhase("built-path smoke", builtCli, {
			cwd: REPO_ROOT,
			env: process.env,
			packetPath: PACKET_FIXTURE_RELATIVE_PATH,
		});
		repoStateGuard.reset();

		console.log("== staged-package creation + inspection ==");
		const staged = runJsonCommand(
			process.execPath,
			["./scripts/published-bootstrap/stage-package.mjs"],
			{ cwd: REPO_ROOT },
			"stage-package.mjs output",
		);
		tempPaths.push(staged.stagingRoot);
		runJsonCommand(
			process.execPath,
			["./scripts/published-bootstrap/inspect-package.mjs", staged.packageRoot],
			{ cwd: REPO_ROOT },
			"inspect-package.mjs output",
		);

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
		runJsonCommand(
			process.execPath,
			["./scripts/published-bootstrap/inspect-package.mjs", tarballPath],
			{ cwd: REPO_ROOT },
			"inspect-package.mjs tarball output",
		);
		const tarballExtractionRoot = createPackedInstallArtifacts(tarballPath);
		tempPaths.push(tarballExtractionRoot);

		runExternalPackedInstallSmoke(tarballPath, tempPaths);

		console.log("== staged README check ==");
		assertStageReadmeContract(join(staged.packageRoot, "README.md"));

		console.log("Published bootstrap verification passed.");
	} catch (error) {
		process.stderr.write(`${getErrorMessage(error)}\n`);
		process.exitCode = 1;
	} finally {
		signalCleanupController.dispose();
		try {
			cleanup();
		} catch (error) {
			process.stderr.write(`Cleanup failed: ${getErrorMessage(error)}\n`);
			process.exitCode = 1;
		}
	}
}

main();
