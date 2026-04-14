import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGitWorktreeAdapter as createActualGitWorkspaceAdapter } from "@buildplane/adapters-git";
import {
	type BuildplaneOrchestrator,
	type BuildplaneWorkspacePort,
	createBuildplaneOrchestrator,
	type UnitPacket,
} from "@buildplane/kernel";
import { evaluateRun } from "@buildplane/policy";
import { executePacket } from "@buildplane/runtime";
import {
	createBuildplaneStorage,
	createLearningStore,
	resolveProjectLayout,
} from "@buildplane/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunCliDependencies, runCli } from "../src/run-cli";

async function runCliCapture(
	cwd: string,
	argv: string[],
	dependencies?: RunCliDependencies,
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = await runCli(argv, {
		cwd,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		dependencies,
	});

	return {
		exitCode,
		stdout,
		stderr,
	};
}

function createCliDependencies(
	projectRoot: string,
	options: {
		orchestrator?: BuildplaneOrchestrator;
		workspace?: BuildplaneWorkspacePort;
	} = {},
): RunCliDependencies {
	if (options.orchestrator) {
		return {
			createOrchestrator: () => options.orchestrator as BuildplaneOrchestrator,
		};
	}

	return {
		createOrchestrator: () =>
			createBuildplaneOrchestrator({
				projectRoot,
				storage: createBuildplaneStorage(projectRoot),
				runtime: { executePacket },
				policy: { evaluateRun },
				workspace: options.workspace ?? createGitWorktreeAdapter(),
			}),
	};
}

function createGitWorktreeAdapter(): BuildplaneWorkspacePort {
	return createActualGitWorkspaceAdapter();
}

function writePacket(root: string, name: string, packet: unknown): string {
	const packetPath = join(root, name);
	mkdirSync(dirname(packetPath), { recursive: true });
	writeFileSync(packetPath, JSON.stringify(packet));
	return packetPath;
}

function writeCommittedPacket(
	root: string,
	name: string,
	packet: unknown,
): string {
	const packetPath = writePacket(root, name, packet);
	git(root, ["add", name]);
	git(root, ["commit", "-m", `add ${name} fixture`]);
	return packetPath;
}

function extractRunId(lines: readonly string[]): string {
	return lines.find((line) => line.startsWith("run-id: "))?.slice(8) ?? "";
}

function git(root: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: root,
		env: isolatedGitEnv(),
		encoding: "utf8",
	});
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}
	return env;
}

function createGitRepo(options: { commitHead?: boolean } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "buildplane-cli-git-"));
	const commitHead = options.commitHead ?? true;

	git(root, ["init"]);
	git(root, ["config", "user.name", "Buildplane Tests"]);
	git(root, ["config", "user.email", "tests@example.com"]);
	writeFileSync(join(root, "tracked.txt"), "baseline\n");
	git(root, ["add", "tracked.txt"]);
	if (commitHead) {
		git(root, ["commit", "-m", "baseline"]);
	}

	return root;
}

function createPassingPacket(unitId = "unit-pass") {
	return {
		unit: {
			id: unitId,
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: ["tmp/pass.txt"],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		execution: {
			command: "node",
			args: [
				"-e",
				"const fs = require('node:fs'); fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/pass.txt', 'ok'); console.log('pass');",
			],
		},
		verification: {
			requiredOutputs: ["tmp/pass.txt"],
		},
	};
}

function createFailingPacket(unitId = "unit-fail") {
	return {
		unit: {
			id: unitId,
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: ["tmp/fail.txt"],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		execution: {
			command: "node",
			args: ["-e", "process.exit(1);"],
		},
		verification: {
			requiredOutputs: ["tmp/fail.txt"],
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("cli command surface", () => {
	it("shows top-level help when invoked without arguments", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-help-"));

		const result = await runCliCapture(root, []);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout.join("\n")).toContain("Buildplane by SollanSystems");
		expect(result.stdout.join("\n")).toContain("Execute:");
		expect(result.stdout.join("\n")).toContain("init");
	});

	it("shows top-level help for --help", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-help-flag-"));

		const result = await runCliCapture(root, ["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout.join("\n")).toContain("Execute:");
		expect(result.stdout.join("\n")).toContain("run --packet <path>");
	});

	it("returns machine-readable NOT_INITIALIZED errors before init and preflights run before packet loading", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-uninit-"));

		const status = await runCliCapture(root, ["status", "--json"]);
		const inspect = await runCliCapture(root, ["inspect", "run-1", "--json"]);
		const run = await runCliCapture(root, [
			"run",
			"--packet",
			"missing-packet.json",
		]);

		expect(status.exitCode).toBe(1);
		expect(JSON.parse(status.stdout.join("\n"))).toMatchObject({
			error: { code: "NOT_INITIALIZED" },
		});
		expect(inspect.exitCode).toBe(1);
		expect(JSON.parse(inspect.stdout.join("\n"))).toMatchObject({
			error: { code: "NOT_INITIALIZED" },
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr.join("\n")).toMatch(/buildplane init/i);
		expect(run.stderr.join("\n")).not.toMatch(/ENOENT|missing-packet/i);
	});

	it("initializes project state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-init-"));

		const result = await runCliCapture(root, ["init"]);

		expect(result.exitCode).toBe(0);
		expect(existsSync(join(root, ".buildplane", "state.db"))).toBe(true);
	});

	it("supports injected packet loading for run command tests", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-parse-packet-"));
		const loadedPacketPaths: string[] = [];
		const receivedPackets: unknown[] = [];
		const dependencies: RunCliDependencies = {
			createOrchestrator: () => ({
				initializeProject() {
					return {
						created: true,
						projectRoot: root,
						stateDbPath: join(root, ".buildplane", "state.db"),
					};
				},
				runPacket(packet) {
					receivedPackets.push(packet);
					return {
						run: {
							id: "run-parse-packet",
							status: "passed",
						},
					};
				},
				getStatus() {
					return {
						initialized: true,
						latestRunUsedWorkspace: false,
						actionableWorkspaces: [],
						runCounts: {
							pending: 0,
							running: 0,
							passed: 0,
							failed: 0,
							cancelled: 0,
						},
					};
				},
				inspect() {
					throw new Error("not used");
				},
			}),
			parsePacket(packetPath) {
				loadedPacketPaths.push(packetPath);
				return createPassingPacket("unit-parse-packet");
			},
		};

		const result = await runCliCapture(
			root,
			["run", "--raw", "--packet", "missing-packet.json"],
			dependencies,
		);

		expect(result.exitCode).toBe(0);
		// Lock the machine-readable run-id token the verifier parses via ^run-id: (.+)$
		expect(result.stdout[0]).toBe("run-id: run-parse-packet");
		expect(result.stdout).toEqual([
			"run-id: run-parse-packet",
			"status: passed",
		]);
		expect(result.stderr).toEqual([]);
		expect(loadedPacketPaths).toEqual([join(root, "missing-packet.json")]);
		expect(receivedPackets).toEqual([
			expect.objectContaining({
				unit: expect.objectContaining({ id: "unit-parse-packet" }),
			}),
		]);
	});

	it("persists injected structured memories and surfaces them in run and inspect output", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const storage = createBuildplaneStorage(root);
		storage.upsertRepoFact({
			factKey: "commands.typecheck",
			factValue: "npx pnpm typecheck",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
		});
		storage.createProcedure({
			name: "fix TypeScript build",
			taskType: "debug_failure",
			bodyMarkdown: "Run typecheck before touching imports.",
			createdBy: "worker",
		});

		const packetPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/injected-packet.json",
			{
				...createPassingPacket("unit-injected"),
				intent: {
					objective: "Fix the TypeScript build",
					taskType: "debug_failure",
					context: { files: ["apps/cli/src/run-cli.ts"] },
					constraints: {
						scope: ["apps/cli/src"],
						verification: ["npx pnpm typecheck"],
					},
					features: {
						ambiguity: "low",
						reversibility: "easy",
						verifierStrength: "strong",
					},
				},
			},
		);

		const runHuman = await runCliCapture(root, [
			"run",
			"--raw",
			"--packet",
			packetPath,
		]);
		const runId = extractRunId(runHuman.stdout);
		const runJson = await runCliCapture(root, [
			"run",
			"--raw",
			"--json",
			"--packet",
			packetPath,
		]);
		const inspectHuman = await runCliCapture(root, ["inspect", runId]);
		const inspectJson = await runCliCapture(root, ["inspect", runId, "--json"]);

		expect(runHuman.exitCode).toBe(0);
		expect(runHuman.stdout).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^run-id: /),
				"status: passed",
				"injected-memories: 2",
				"  - [repo-fact] commands.typecheck (fuzzy-fact-key)",
				"  - [procedure] fix TypeScript build (exact-task-type)",
			]),
		);

		const parsedRun = JSON.parse(runJson.stdout.join("\n"));
		expect(parsedRun).toMatchObject({
			run: { id: expect.any(String), status: "passed" },
			injectedMemories: [
				{
					memoryKind: "repo-fact",
					memoryId: expect.any(String),
					matchReason: "fuzzy-fact-key",
				},
				{
					memoryKind: "procedure",
					memoryId: expect.any(String),
					matchReason: "exact-task-type",
				},
			],
		});

		expect(inspectHuman.stdout).toEqual(
			expect.arrayContaining([
				`run-id: ${runId}`,
				"injected-memories:",
				"  [repo-fact] commands.typecheck: npx pnpm typecheck (fuzzy-fact-key)",
				"  [procedure] fix TypeScript build: Run typecheck before touching imports. (exact-task-type)",
			]),
		);

		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			run: { id: runId, status: "passed" },
			injectedMemories: [
				{
					memoryKind: "repo-fact",
					matchReason: "fuzzy-fact-key",
					displayText: "[repo-fact] commands.typecheck: npx pnpm typecheck",
				},
				{
					memoryKind: "procedure",
					matchReason: "exact-task-type",
				},
			],
		});
		const listedInjected = storage.listInjectedMemories(runId);
		expect(listedInjected).toHaveLength(2);
	});

	it("surfaces promoted procedure lineage in inspect human and json output", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const storage = createBuildplaneStorage(root);
		const packet = createPassingPacket("unit-promotion-lineage") as UnitPacket;
		const run = storage.createRun(packet);
		storage.completeRun(run.id, "passed");

		const firstProcedure = storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown:
				"Use an implement-then-review workflow for implement tasks.\n\nObserved learning: missing tests.",
			createdBy: "worker",
			sourceRunId: run.id,
			sourceTaskId: "task-implementer",
			metadata: {
				promotionRule: "multi-round-strategy-workflow->procedure",
				strategyMode: "implement-then-review",
			},
		});
		storage.supersedeProcedure(firstProcedure.id);
		storage.createProcedure({
			name: "implement-then-review workflow for implement tasks",
			taskType: "implement",
			bodyMarkdown:
				"Use an implement-then-review workflow for implement tasks.\n\nObserved learning: missing type guards.",
			createdBy: "worker",
			sourceRunId: run.id,
			sourceTaskId: "task-implementer",
			metadata: {
				promotionRule: "multi-round-strategy-workflow->procedure",
				strategyMode: "implement-then-review",
			},
		});

		const inspectHuman = await runCliCapture(root, ["inspect", run.id]);
		const inspectJson = await runCliCapture(root, [
			"inspect",
			run.id,
			"--json",
		]);

		expect(inspectHuman.exitCode).toBe(0);
		expect(inspectHuman.stdout).toEqual(
			expect.arrayContaining([
				`run-id: ${run.id}`,
				"promoted-memories:",
				expect.stringContaining(
					"[procedure] implement-then-review workflow for implement tasks:",
				),
				expect.stringContaining(
					"status=active, rule=multi-round-strategy-workflow->procedure, source-task=task-implementer",
				),
				expect.stringContaining("status=superseded"),
			]),
		);
		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			run: { id: run.id, status: "passed" },
			promotedStructuredMemories: expect.arrayContaining([
				expect.objectContaining({
					memoryKind: "procedure",
					status: "active",
					promotionRule: "multi-round-strategy-workflow->procedure",
					sourceRunId: run.id,
					sourceTaskId: "task-implementer",
				}),
				expect.objectContaining({
					memoryKind: "procedure",
					status: "superseded",
					promotionRule: "multi-round-strategy-workflow->procedure",
					sourceRunId: run.id,
				}),
			]),
		});
	});

	it("persists injected structured memories for run-graph nodes", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const storage = createBuildplaneStorage(root);
		storage.upsertRepoFact({
			factKey: "commands.typecheck",
			factValue: "npx pnpm typecheck",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
		});
		storage.createProcedure({
			name: "fix TypeScript build",
			taskType: "debug_failure",
			bodyMarkdown: "Run typecheck before touching imports.",
			createdBy: "worker",
		});

		const graphPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/injected-graph.json",
			{
				nodes: [
					{
						...createPassingPacket("graph-injected"),
						intent: {
							objective: "Fix the TypeScript build",
							taskType: "debug_failure",
							context: { files: ["apps/cli/src/run-cli.ts"] },
							constraints: {
								scope: ["apps/cli/src"],
								verification: ["npx pnpm typecheck"],
							},
							features: {
								ambiguity: "low",
								reversibility: "easy",
								verifierStrength: "strong",
							},
						},
					},
				],
				maxConcurrent: 1,
			},
		);

		const runGraph = await runCliCapture(root, [
			"run-graph",
			"--graph",
			graphPath,
		]);
		const inspectJson = await runCliCapture(root, [
			"inspect",
			"graph-injected",
			"--json",
		]);

		expect(runGraph.exitCode).toBe(0);
		expect(runGraph.stdout).toEqual(
			expect.arrayContaining([
				"Graph Outcome: passed",
				" - graph-injected: passed",
			]),
		);
		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			run: { unitId: "graph-injected", status: "passed" },
			injectedMemories: [
				{ memoryKind: "repo-fact", matchReason: "fuzzy-fact-key" },
				{ memoryKind: "procedure", matchReason: "exact-task-type" },
			],
		});
	});

	it("persists injected structured memories for custom run-strategy executions", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const storage = createBuildplaneStorage(root);
		storage.upsertRepoFact({
			factKey: "commands.typecheck",
			factValue: "npx pnpm typecheck",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
		});
		storage.createProcedure({
			name: "fix TypeScript build",
			taskType: "debug_failure",
			bodyMarkdown: "Run typecheck before touching imports.",
			createdBy: "worker",
		});

		const strategyPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/injected-strategy.json",
			{
				id: "strategy-injected",
				mode: "single",
				mergePolicy: "direct",
				children: [
					{
						role: "implementer",
						packet: {
							...createPassingPacket("strategy-injected-unit"),
							intent: {
								objective: "Fix the TypeScript build",
								taskType: "debug_failure",
								context: { files: ["apps/cli/src/run-cli.ts"] },
								constraints: {
									scope: ["apps/cli/src"],
									verification: ["npx pnpm typecheck"],
								},
								features: {
									ambiguity: "low",
									reversibility: "easy",
									verifierStrength: "strong",
								},
							},
						},
					},
				],
			},
		);

		const runStrategy = await runCliCapture(root, [
			"run-strategy",
			"--strategy",
			strategyPath,
		]);
		const inspectJson = await runCliCapture(root, [
			"inspect",
			"strategy-injected-unit",
			"--json",
		]);

		expect(runStrategy.exitCode).toBe(0);
		expect(runStrategy.stdout).toEqual(
			expect.arrayContaining([
				"strategy: strategy-injected",
				"mode: single",
				"outcome: passed",
				"injected-memories: 2",
			]),
		);
		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			run: { unitId: "strategy-injected-unit", status: "passed" },
			injectedMemories: [
				{ memoryKind: "repo-fact", matchReason: "fuzzy-fact-key" },
				{ memoryKind: "procedure", matchReason: "exact-task-type" },
			],
		});
	});

	it("delegates memory commands to the native runner dependency", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-memory-delegate-"));
		const calls: Array<{ cwd: string; argv: string[]; commandPath: string[] }> =
			[];
		const dependencies: RunCliDependencies = {
			runNativeCommand: async (argv, options) => {
				calls.push({
					cwd: options.cwd,
					argv,
					commandPath: options.commandPath,
				});
				options.stdout("memory-ok");
				options.stderr("memory-warn");
				return 7;
			},
		};

		const result = await runCliCapture(
			root,
			["memory", "doctor", "--json"],
			dependencies,
		);

		expect(result.exitCode).toBe(7);
		expect(result.stdout).toEqual(["memory-ok"]);
		expect(result.stderr).toEqual(["memory-warn"]);
		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["doctor", "--json"],
			},
		]);
	});

	it("delegates pack show to the native runner dependency", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pack-show-delegate-"),
		);
		const calls: Array<{ cwd: string; argv: string[]; commandPath: string[] }> =
			[];
		const dependencies: RunCliDependencies = {
			runNativeCommand: async (argv, options) => {
				calls.push({
					cwd: options.cwd,
					argv,
					commandPath: options.commandPath,
				});
				options.stdout("pack-show-ok");
				options.stderr("pack-show-warn");
				return 9;
			},
		};

		const result = await runCliCapture(
			root,
			["pack", "show", "superclaude"],
			dependencies,
		);

		expect(result.exitCode).toBe(9);
		expect(result.stdout).toEqual(["pack-show-ok"]);
		expect(result.stderr).toEqual(["pack-show-warn"]);
		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["pack", "show"],
				argv: ["superclaude"],
			},
		]);
	});

	it("returns machine-readable JSON when memory dispatch fails in --json mode", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-json-error-"),
		);
		const dependencies: RunCliDependencies = {
			runNativeCommand: async () => {
				throw new Error("spawnSync /tmp/buildplane-native ENOENT");
			},
		};

		const result = await runCliCapture(
			root,
			["memory", "doctor", "--json"],
			dependencies,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		const payload = JSON.parse(result.stdout.join("\n"));
		expect(payload).toMatchObject({
			error: { code: "NATIVE_COMMAND_DISPATCH_FAILED" },
		});
		expect(payload.error.message).toContain(
			"Failed to dispatch to the native memory command runner.",
		);
		expect(payload.error.message).toContain("BUILDPLANE_NATIVE_BIN");
		expect(payload.error.message).toContain("buildplane-native");
		expect(payload.error.message).toContain(
			"cargo build --manifest-path native/Cargo.toml -p bp-cli",
		);
	});

	it("emits remediation hints when memory dispatch fails in human mode", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-human-error-"),
		);
		const dependencies: RunCliDependencies = {
			runNativeCommand: async () => {
				throw new Error("spawnSync /tmp/buildplane-native ENOENT");
			},
		};

		const result = await runCliCapture(
			root,
			["memory", "doctor"],
			dependencies,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([]);
		expect(result.stderr.join("\n")).toContain(
			"Failed to dispatch to the native memory command runner.",
		);
		expect(result.stderr.join("\n")).toContain("BUILDPLANE_NATIVE_BIN");
		expect(result.stderr.join("\n")).toContain("buildplane-native");
		expect(result.stderr.join("\n")).toContain(
			"cargo build --manifest-path native/Cargo.toml -p bp-cli",
		);
	});

	it("returns machine-readable JSON when pack show dispatch fails in --json mode", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pack-show-json-error-"),
		);
		const dependencies: RunCliDependencies = {
			runNativeCommand: async () => {
				throw new Error("spawnSync /tmp/buildplane-native ENOENT");
			},
		};

		const result = await runCliCapture(
			root,
			["pack", "show", "superclaude", "--json"],
			dependencies,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		const payload = JSON.parse(result.stdout.join("\n"));
		expect(payload).toMatchObject({
			error: { code: "NATIVE_COMMAND_DISPATCH_FAILED" },
		});
		expect(payload.error.message).toContain(
			"Failed to dispatch to the native pack show command runner.",
		);
		expect(payload.error.message).toContain("BUILDPLANE_NATIVE_BIN");
		expect(payload.error.message).toContain("buildplane-native");
	});

	it("runs packets inside a git repo and surfaces retained workspaces in run, status, and inspect output", async () => {
		const root = createGitRepo();

		await runCliCapture(root, ["init"]);

		const passingPacketPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/passing-packet.json",
			createPassingPacket(),
		);
		const failingPacketPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/failing-packet.json",
			createFailingPacket("unit-fail"),
		);

		const passResult = await runCliCapture(root, [
			"run",
			"--raw",
			"--packet",
			passingPacketPath,
		]);
		const firstFailure = await runCliCapture(root, [
			"run",
			"--raw",
			"--packet",
			failingPacketPath,
		]);
		const secondFailure = await runCliCapture(root, [
			"run",
			"--raw",
			"--packet",
			failingPacketPath,
		]);
		const secondFailureRunId = extractRunId(secondFailure.stdout);
		const statusHuman = await runCliCapture(root, ["status"]);
		const statusJson = await runCliCapture(root, ["status", "--json"]);
		const inspectHuman = await runCliCapture(root, [
			"inspect",
			secondFailureRunId,
		]);
		const inspectJson = await runCliCapture(root, [
			"inspect",
			secondFailureRunId,
			"--json",
		]);
		const inspectUnitJson = await runCliCapture(root, [
			"inspect",
			"unit-fail",
			"--json",
		]);

		expect(passResult.exitCode).toBe(0);
		expect(passResult.stdout).toHaveLength(2);
		expect(passResult.stdout[0]).toMatch(/^run-id: /);
		expect(passResult.stdout[1]).toBe("status: passed");

		expect(firstFailure.exitCode).toBe(1);
		expect(firstFailure.stdout).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^run-id: /),
				"status: failed",
				expect.stringMatching(/^workspace: .+\.buildplane\/workspaces\//),
			]),
		);
		expect(firstFailure.stderr).toEqual([]);

		expect(secondFailure.exitCode).toBe(1);
		expect(secondFailure.stdout).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^run-id: /),
				"status: failed",
				expect.stringMatching(/^workspace: .+\.buildplane\/workspaces\//),
			]),
		);

		expect(statusHuman.exitCode).toBe(0);
		expect(statusHuman.stdout).toEqual(
			expect.arrayContaining([
				"initialized: true",
				expect.stringMatching(
					new RegExp(
						`^latest-run: ${secondFailureRunId} failed \\(unit-fail\\)$`,
					),
				),
				"run-counts: pending=0 running=0 passed=1 failed=2 cancelled=0",
				expect.stringMatching(
					/^workspace: .+\.buildplane\/workspaces\/.* \(retained\)$/,
				),
				"actionable-workspaces: 2",
			]),
		);

		const parsedStatus = JSON.parse(statusJson.stdout.join("\n"));
		expect(parsedStatus).toMatchObject({
			initialized: true,
			latestRun: {
				id: secondFailureRunId,
				unitId: "unit-fail",
				status: "failed",
			},
			latestRunUsedWorkspace: true,
			latestWorkspace: {
				runId: secondFailureRunId,
				status: "retained",
				path: expect.stringMatching(/\.buildplane\/workspaces\//),
				headSha: expect.any(String),
			},
		});
		expect(parsedStatus.actionableWorkspaces).toHaveLength(2);
		expect(parsedStatus.actionableWorkspaces[0]).toMatchObject({
			status: "retained",
			path: expect.stringMatching(/\.buildplane\/workspaces\//),
			headSha: expect.any(String),
		});

		expect(inspectHuman.exitCode).toBe(0);
		expect(inspectHuman.stdout).toEqual(
			expect.arrayContaining([
				"kind: run",
				`run-id: ${secondFailureRunId}`,
				"unit-id: unit-fail",
				"status: failed",
				"workspace-status: retained",
				expect.stringMatching(/^workspace: .+\.buildplane\/workspaces\//),
				expect.stringMatching(/^workspace-head: [0-9a-f]+$/),
				expect.stringMatching(/^workspace-exists-on-disk: true$/),
			]),
		);

		const parsedInspect = JSON.parse(inspectJson.stdout.join("\n"));
		expect(parsedInspect).toMatchObject({
			kind: "run",
			run: { id: secondFailureRunId, status: "failed" },
			workspace: {
				status: "retained",
				path: expect.stringMatching(/\.buildplane\/workspaces\//),
				headSha: expect.any(String),
				existsOnDisk: true,
			},
		});

		const parsedInspectByUnit = JSON.parse(inspectUnitJson.stdout.join("\n"));
		expect(parsedInspectByUnit).toMatchObject({
			kind: "unit",
			run: { id: secondFailureRunId, status: "failed" },
			workspace: {
				status: "retained",
				path: expect.stringMatching(/\.buildplane\/workspaces\//),
				headSha: expect.any(String),
			},
		});
		expect(
			parsedInspectByUnit.runHistory.map((entry: { id: string }) => entry.id),
		).toEqual([secondFailureRunId, extractRunId(firstFailure.stdout)]);
	});

	it("surfaces cleanup-failed workspace details in human and json output", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-cleanup-failed-"));
		const dependencies = createCliDependencies(root, {
			workspace: {
				assertRunnableRepository() {
					return { headSha: "abc123" };
				},
				prepareWorkspace(projectRoot, runId, headSha) {
					const path = join(projectRoot, ".buildplane", "workspaces", runId);
					mkdirSync(path, { recursive: true });
					return { path, headSha };
				},
				deleteWorkspace() {
					return { deleted: false, cleanupError: "disk busy" };
				},
			},
		});
		const packetPath = writePacket(
			root,
			"passing-packet.json",
			createPassingPacket("unit-cleanup"),
		);

		await runCliCapture(root, ["init"], dependencies);

		const runResult = await runCliCapture(
			root,
			["run", "--raw", "--packet", packetPath],
			dependencies,
		);
		const runId = extractRunId(runResult.stdout);
		const statusHuman = await runCliCapture(root, ["status"], dependencies);
		const statusJson = await runCliCapture(
			root,
			["status", "--json"],
			dependencies,
		);
		const inspectHuman = await runCliCapture(
			root,
			["inspect", runId],
			dependencies,
		);
		const inspectJson = await runCliCapture(
			root,
			["inspect", runId, "--json"],
			dependencies,
		);

		expect(runResult.exitCode).toBe(0);
		expect(runResult.stdout).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^run-id: /),
				"status: passed",
				expect.stringMatching(/^workspace: .+\.buildplane\/workspaces\//),
			]),
		);

		expect(statusHuman.stdout).toEqual(
			expect.arrayContaining([
				"initialized: true",
				expect.stringMatching(
					/^workspace: .+\.buildplane\/workspaces\/.* \(cleanup-failed\)$/,
				),
				"actionable-workspaces: 1",
			]),
		);
		expect(JSON.parse(statusJson.stdout.join("\n"))).toMatchObject({
			latestRun: { id: runId, status: "passed" },
			latestRunUsedWorkspace: true,
			latestWorkspace: {
				runId: runId,
				status: "cleanup-failed",
				path: expect.stringMatching(/\.buildplane\/workspaces\//),
				headSha: "abc123",
				cleanupError: "disk busy",
			},
			actionableWorkspaces: [
				{
					runId: runId,
					status: "cleanup-failed",
					path: expect.stringMatching(/\.buildplane\/workspaces\//),
					headSha: "abc123",
					cleanupError: "disk busy",
				},
			],
		});

		expect(inspectHuman.stdout).toEqual(
			expect.arrayContaining([
				`run-id: ${runId}`,
				"status: passed",
				"workspace-status: cleanup-failed",
				expect.stringMatching(/^workspace: .+\.buildplane\/workspaces\//),
				"workspace-head: abc123",
				expect.stringMatching(/^workspace-finalized-at: /),
				"workspace-cleanup-error: disk busy",
				"workspace-exists-on-disk: true",
			]),
		);
		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			workspace: {
				status: "cleanup-failed",
				path: expect.stringMatching(/\.buildplane\/workspaces\//),
				headSha: "abc123",
				cleanupError: "disk busy",
				finalizedAt: expect.any(String),
				existsOnDisk: true,
			},
		});
	});

	it("surfaces post-run infrastructure failures with run id, retained workspace, and explicit human error text", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-runtime-failure-"));
		const retainedWorkspacePath = join(
			root,
			".buildplane",
			"workspaces",
			"run-runtime-failure",
		);
		const dependencies = createCliDependencies(root, {
			orchestrator: {
				initializeProject() {
					return {
						created: true,
						projectRoot: root,
						stateDbPath: join(root, ".buildplane", "state.db"),
					};
				},
				runPacket() {
					return {
						run: {
							id: "run-runtime-failure",
							unitId: "unit-runtime-failure",
							status: "failed",
						},
						failure: {
							kind: "runtime-execution-failed",
							message: "runtime crashed before completion",
						},
						workspace: {
							runId: "run-runtime-failure",
							path: retainedWorkspacePath,
							headSha: "abc123",
							status: "retained",
						},
					};
				},
				getStatus() {
					return {
						initialized: true,
						latestRunUsedWorkspace: false,
						actionableWorkspaces: [],
						runCounts: {
							pending: 0,
							running: 0,
							passed: 0,
							failed: 0,
							cancelled: 0,
						},
					};
				},
				inspect() {
					throw new Error("not used");
				},
			},
		});
		const packetPath = writePacket(
			root,
			"runtime-failure-packet.json",
			createPassingPacket("unit-runtime-failure"),
		);

		const result = await runCliCapture(
			root,
			["run", "--raw", "--packet", packetPath],
			dependencies,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^run-id: /),
				"status: failed",
				expect.stringMatching(/^workspace: .+\.buildplane\/workspaces\//),
			]),
		);
		expect(result.stderr).toEqual(["runtime crashed before completion"]);
	});

	it("renders infrastructure failures as failed human run output even when the durable run stayed passed", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-run-failure-status-"),
		);
		const activeWorkspacePath = join(
			root,
			".buildplane",
			"workspaces",
			"run-delete-persistence",
		);
		const dependencies = createCliDependencies(root, {
			orchestrator: {
				initializeProject() {
					return {
						created: true,
						projectRoot: root,
						stateDbPath: join(root, ".buildplane", "state.db"),
					};
				},
				runPacket() {
					return {
						run: {
							id: "run-delete-persistence",
							unitId: "unit-delete-persistence",
							status: "passed",
						},
						failure: {
							kind: "workspace-delete-persistence-failed",
							message: "recordWorkspaceDeleted persistence failed",
						},
						workspace: {
							runId: "run-delete-persistence",
							path: activeWorkspacePath,
							headSha: "abc123",
							status: "active",
						},
					};
				},
				getStatus() {
					return {
						initialized: true,
						latestRunUsedWorkspace: false,
						actionableWorkspaces: [],
						runCounts: {
							pending: 0,
							running: 0,
							passed: 1,
							failed: 0,
							cancelled: 0,
						},
					};
				},
				inspect() {
					throw new Error("not used");
				},
			},
		});
		const packetPath = writePacket(
			root,
			"run-failure-status-packet.json",
			createPassingPacket("unit-delete-persistence"),
		);

		const result = await runCliCapture(
			root,
			["run", "--raw", "--packet", packetPath],
			dependencies,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual(
			expect.arrayContaining([
				"run-id: run-delete-persistence",
				"status: failed",
			]),
		);
		expect(result.stderr).toEqual([
			"recordWorkspaceDeleted persistence failed",
		]);
	});

	it("reports active-workspace inspect limitations and missing-on-disk notes when surfaced by the orchestrator", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-active-workspace-"),
		);
		const activeWorkspacePath = join(
			root,
			".buildplane",
			"workspaces",
			"run-active",
		);
		const dependencies = createCliDependencies(root, {
			orchestrator: {
				initializeProject() {
					return {
						created: true,
						projectRoot: root,
						stateDbPath: join(root, ".buildplane", "state.db"),
					};
				},
				runPacket() {
					throw new Error("not used");
				},
				getStatus() {
					return {
						initialized: true,
						latestRun: {
							id: "run-active",
							unitId: "unit-active",
							status: "passed",
						},
						latestRunUsedWorkspace: true,
						latestWorkspace: {
							runId: "run-active",
							path: activeWorkspacePath,
							headSha: "abc123",
							status: "active",
						},
						actionableWorkspaces: [],
						runCounts: {
							pending: 0,
							running: 0,
							passed: 1,
							failed: 0,
							cancelled: 0,
						},
					};
				},
				inspect() {
					return {
						kind: "run",
						unit: {
							id: "unit-active",
							kind: "command",
							scope: "task",
							inputRefs: [],
							expectedOutputs: [],
							verificationContract: "exit-0-and-required-outputs",
							policyProfile: "default",
						},
						run: {
							id: "run-active",
							unitId: "unit-active",
							status: "passed",
						},
						workspace: {
							runId: "run-active",
							path: activeWorkspacePath,
							headSha: "abc123",
							status: "active",
							existsOnDisk: false,
						},
						runHistory: [{ id: "run-active", status: "passed" }],
						evidence: [],
						decisions: [],
						artifacts: [],
					};
				},
			},
		});

		const statusHuman = await runCliCapture(root, ["status"], dependencies);
		const statusJson = await runCliCapture(
			root,
			["status", "--json"],
			dependencies,
		);
		const inspectHuman = await runCliCapture(
			root,
			["inspect", "run-active"],
			dependencies,
		);
		const inspectJson = await runCliCapture(
			root,
			["inspect", "run-active", "--json"],
			dependencies,
		);

		expect(statusHuman.stdout).toEqual(
			expect.arrayContaining([
				"initialized: true",
				expect.stringMatching(
					/^workspace: .+\.buildplane\/workspaces\/run-active \(active\)$/,
				),
			]),
		);
		expect(JSON.parse(statusJson.stdout.join("\n"))).toMatchObject({
			latestRunUsedWorkspace: true,
			latestWorkspace: {
				status: "active",
				path: activeWorkspacePath,
				headSha: "abc123",
			},
		});

		expect(inspectHuman.stdout).toEqual(
			expect.arrayContaining([
				"status: passed",
				"workspace-status: active",
				`workspace: ${activeWorkspacePath}`,
				"workspace-head: abc123",
				"workspace-exists-on-disk: false",
				"workspace-note: passed run still reports an active workspace; cleanup may have been interrupted in this thin slice.",
				"workspace-note: last-known workspace path may already be gone on disk despite the persisted active status.",
			]),
		);
		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			workspace: {
				status: "active",
				path: activeWorkspacePath,
				headSha: "abc123",
				existsOnDisk: false,
			},
		});
	});

	it("dispatches model packets via runPacketAsync even without --tui", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-model-async-"));
		const calls: string[] = [];
		const dependencies: RunCliDependencies = {
			createOrchestrator: () => ({
				initializeProject() {
					return {
						created: true,
						projectRoot: root,
						stateDbPath: join(root, ".buildplane", "state.db"),
					};
				},
				runPacket(_packet: unknown) {
					calls.push("runPacket");
					return {
						run: { id: "run-sync", status: "passed" },
						receipt: null,
						decision: null,
					};
				},
				async runPacketAsync(_packet: unknown, _eventBus?: unknown) {
					calls.push("runPacketAsync");
					return {
						run: { id: "run-async", status: "passed" },
						receipt: null,
						decision: null,
					};
				},
				getStatus() {
					return {
						initialized: true,
						latestRunUsedWorkspace: false,
						actionableWorkspaces: [],
						runCounts: {
							pending: 0,
							running: 0,
							passed: 0,
							failed: 0,
							cancelled: 0,
						},
					};
				},
				inspect() {
					throw new Error("not used");
				},
			}),
			parsePacket(_packetPath: string) {
				return {
					unit: {
						id: "unit-model",
						kind: "model",
						scope: "task",
						inputRefs: [],
						expectedOutputs: [],
						verificationContract: "exit-0-and-required-outputs",
						policyProfile: "default",
					},
					model: {
						provider: "anthropic",
						model: "claude-sonnet-4-20250514",
						prompt: "hello",
					},
					verification: { requiredOutputs: [] },
				};
			},
		};

		const result = await runCliCapture(
			root,
			["run", "--raw", "--packet", "model-packet.json"],
			dependencies,
		);

		expect(result.exitCode).toBe(0);
		expect(calls).toEqual(["runPacketAsync"]);
		expect(result.stdout[0]).toBe("run-id: run-async");
	});

	it("dispatches command packets via sync runPacket when --tui is not set", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-cmd-sync-"));
		const calls: string[] = [];
		const dependencies: RunCliDependencies = {
			createOrchestrator: () => ({
				initializeProject() {
					return {
						created: true,
						projectRoot: root,
						stateDbPath: join(root, ".buildplane", "state.db"),
					};
				},
				runPacket(_packet: unknown) {
					calls.push("runPacket");
					return {
						run: { id: "run-sync", status: "passed" },
						receipt: null,
						decision: null,
					};
				},
				async runPacketAsync(_packet: unknown, _eventBus?: unknown) {
					calls.push("runPacketAsync");
					return {
						run: { id: "run-async", status: "passed" },
						receipt: null,
						decision: null,
					};
				},
				getStatus() {
					return {
						initialized: true,
						latestRunUsedWorkspace: false,
						actionableWorkspaces: [],
						runCounts: {
							pending: 0,
							running: 0,
							passed: 0,
							failed: 0,
							cancelled: 0,
						},
					};
				},
				inspect() {
					throw new Error("not used");
				},
			}),
			parsePacket(_packetPath: string) {
				return createPassingPacket("unit-cmd");
			},
		};

		const result = await runCliCapture(
			root,
			["run", "--raw", "--packet", "cmd-packet.json"],
			dependencies,
		);

		expect(result.exitCode).toBe(0);
		expect(calls).toEqual(["runPacket"]);
		expect(result.stdout[0]).toBe("run-id: run-sync");
	});

	it("returns stable operator-facing errors for setup failures and git preflight failures", async () => {
		const setupFailureRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-setup-failure-"),
		);
		const setupDependencies = createCliDependencies(setupFailureRoot, {
			workspace: {
				assertRunnableRepository() {
					return { headSha: "abc123" };
				},
				prepareWorkspace() {
					throw new Error("git worktree add failed");
				},
				deleteWorkspace() {
					return { deleted: true };
				},
			},
		});
		const setupPacketPath = writePacket(
			setupFailureRoot,
			"packet.json",
			createPassingPacket("unit-setup-failure"),
		);
		await runCliCapture(setupFailureRoot, ["init"], setupDependencies);

		const setupFailure = await runCliCapture(
			setupFailureRoot,
			["run", "--raw", "--packet", setupPacketPath],
			setupDependencies,
		);

		expect(setupFailure.exitCode).toBe(1);
		expect(setupFailure.stdout).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^run-id: /),
				"status: failed",
			]),
		);
		expect(setupFailure.stderr).toEqual(["git worktree add failed"]);

		const nonGitRoot = mkdtempSync(join(tmpdir(), "buildplane-cli-non-git-"));
		const nonGitPacketPath = writePacket(
			nonGitRoot,
			"packet.json",
			createPassingPacket("unit-non-git"),
		);
		await runCliCapture(nonGitRoot, ["init"]);

		const nonGit = await runCliCapture(nonGitRoot, [
			"run",
			"--raw",
			"--packet",
			nonGitPacketPath,
		]);
		expect(nonGit.exitCode).toBe(1);
		expect(nonGit.stderr.join("\n")).toMatch(/not a git repository/i);

		const dirtyRoot = createGitRepo();
		const dirtyPacketPath = writePacket(
			dirtyRoot,
			".buildplane/test-packets/packet.json",
			createPassingPacket("unit-dirty"),
		);
		await runCliCapture(dirtyRoot, ["init"]);
		writeFileSync(join(dirtyRoot, "tracked.txt"), "dirty\n");

		const dirty = await runCliCapture(dirtyRoot, [
			"run",
			"--raw",
			"--packet",
			dirtyPacketPath,
		]);
		expect(dirty.exitCode).toBe(1);
		expect(dirty.stderr.join("\n")).toMatch(/working tree is not clean/i);

		const unresolvedHeadRoot = createGitRepo({ commitHead: false });
		const unresolvedHeadPacketPath = writePacket(
			unresolvedHeadRoot,
			"packet.json",
			createPassingPacket("unit-no-head"),
		);
		await runCliCapture(unresolvedHeadRoot, ["init"]);

		const unresolvedHead = await runCliCapture(unresolvedHeadRoot, [
			"run",
			"--raw",
			"--packet",
			unresolvedHeadPacketPath,
		]);
		expect(unresolvedHead.exitCode).toBe(1);
		expect(unresolvedHead.stderr.join("\n")).toMatch(/head is unresolved/i);

		const missingGitRoot = createGitRepo();
		const missingGitPacketPath = writePacket(
			missingGitRoot,
			"packet.json",
			createPassingPacket("unit-missing-git"),
		);
		await runCliCapture(missingGitRoot, ["init"]);
		vi.stubEnv("PATH", "");

		const missingGit = await runCliCapture(missingGitRoot, [
			"run",
			"--raw",
			"--packet",
			missingGitPacketPath,
		]);
		expect(missingGit.exitCode).toBe(1);
		expect(missingGit.stderr.join("\n")).toMatch(/git binary is unavailable/i);
	});

	async function createProjectWithLearnings(
		root: string,
		learnings: Array<{
			kind: string;
			scope: string;
			title: string;
			body: string;
		}>,
	): Promise<{ learningIds: string[] }> {
		execFileSync("git", ["init"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Buildplane Tests"], {
			cwd: root,
		});
		execFileSync("git", ["config", "user.email", "tests@example.com"], {
			cwd: root,
		});
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
			cwd: root,
		});
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const layout = resolveProjectLayout(root);
		const db = new DatabaseSync(layout.stateDbPath);
		const store = createLearningStore(db);
		store.writeLearnings("run-abc", learnings as never);
		const all = store.fetchLearnings();
		const ids = (all as Array<{ id: string }>).map((l) => l.id);
		db.close();
		return { learningIds: ids };
	}

	it("memory list returns a formatted table of learnings", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-memory-list-"));
		await createProjectWithLearnings(root, [
			{
				kind: "fact",
				scope: "workspace",
				title: "Verification gate passed",
				body: "All outputs verified",
			},
		]);

		const result = await runCliCapture(root, ["memory", "list"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.join("\n")).toContain("Verification gate passed");
		expect(result.stdout.join("\n")).toContain("workspace");
	});

	it("memory list --json returns JSON array", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-list-json-"),
		);
		await createProjectWithLearnings(root, [
			{
				kind: "fact",
				scope: "workspace",
				title: "Verification gate passed",
				body: "All outputs verified",
			},
		]);

		const result = await runCliCapture(root, ["memory", "list", "--json"]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout.join("\n"));
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].title).toBe("Verification gate passed");
	});

	it("memory inspect returns detail for a single learning", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-memory-inspect-"));
		const { learningIds } = await createProjectWithLearnings(root, [
			{
				kind: "constraint",
				scope: "session",
				title: "Run rejected",
				body: "Rejected: exit code 1",
			},
		]);

		const result = await runCliCapture(root, [
			"memory",
			"inspect",
			learningIds[0],
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.join("\n")).toContain("Run rejected");
		expect(result.stdout.join("\n")).toContain("Rejected: exit code 1");
		expect(result.stdout.join("\n")).toContain(learningIds[0]);
	});

	it("memory inspect with nonexistent ID returns error", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-inspect-missing-"),
		);
		await createProjectWithLearnings(root, [
			{
				kind: "fact",
				scope: "workspace",
				title: "Some learning",
				body: "body",
			},
		]);

		const result = await runCliCapture(root, [
			"memory",
			"inspect",
			"nonexistent-id",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr.join("\n")).toContain("Learning not found");
	});

	it("unknown memory subcommands still dispatch to native", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-native-fallthrough-"),
		);
		const calls: Array<{
			cwd: string;
			argv: string[];
			commandPath: string[];
		}> = [];
		const dependencies: RunCliDependencies = {
			runNativeCommand: async (argv, options) => {
				calls.push({
					cwd: options.cwd,
					argv,
					commandPath: options.commandPath,
				});
				return 0;
			},
		};

		await runCliCapture(root, ["memory", "search", "foo"], dependencies);

		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["search", "foo"],
			},
		]);
	});
});
