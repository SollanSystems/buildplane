import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createGitWorktreeAdapter as createActualGitWorkspaceAdapter } from "@buildplane/adapters-git";
import {
	type BuildplaneOrchestrator,
	type BuildplaneWorkspacePort,
	createBuildplaneOrchestrator,
	type RunAdmissionLocalEvidenceStore,
	type UnitPacket,
} from "@buildplane/kernel";
import { digest } from "@buildplane/planforge";
import { evaluateRun } from "@buildplane/policy";
import { executePacket } from "@buildplane/runtime";
import {
	createBuildplaneStorage,
	createEventStore,
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
				admissionStore: createTestAdmissionStore(projectRoot),
			}),
	};
}

function createGitWorktreeAdapter(): BuildplaneWorkspacePort {
	return createActualGitWorkspaceAdapter();
}

function createTestAdmissionStore(
	root: string,
): RunAdmissionLocalEvidenceStore {
	return {
		writeReceiptArtifact(input) {
			return {
				ref: `artifact://${input.receipt.receipt_id}`,
				path: join(root, ".buildplane", "admission", "run-admission.json"),
			};
		},
		appendAdmissionEvent(input) {
			return {
				ref: `event://${input.event.event_id}`,
				path: join(root, ".buildplane", "admission", "events.jsonl"),
			};
		},
	};
}

function writeWorkspaceFile(
	root: string,
	name: string,
	content: string,
): string {
	const targetPath = join(root, name);
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, content);
	return targetPath;
}

function writePacket(root: string, name: string, packet: unknown): string {
	const packetPath = join(root, name);
	mkdirSync(dirname(packetPath), { recursive: true });
	writeFileSync(packetPath, JSON.stringify(packet));
	return packetPath;
}

function loadAdmissionFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(
			join(
				process.cwd(),
				"packages",
				"kernel",
				"test",
				"fixtures",
				"admission-receipts",
				`${name}.json`,
			),
			"utf8",
		),
	);
}

function loadAdmissionFixtureWithoutEvidence(
	name: string,
	kind: string,
): unknown {
	const fixture = loadAdmissionFixture(name) as Record<string, unknown>;
	const evidenceInputs = fixture.evidence_inputs as readonly Record<
		string,
		unknown
	>[];
	return {
		...fixture,
		evidence_inputs: evidenceInputs.filter(
			(evidence) => evidence.kind !== kind,
		),
	};
}

function loadAdmissionFixtureWithoutRepoOrEvidence(name: string): unknown {
	return {
		...(loadAdmissionFixture(name) as Record<string, unknown>),
		repo: {},
		evidence_inputs: [],
	};
}

function loadAdmissionFixtureWithSideEffects(
	name: string,
	requestedSideEffects: readonly string[],
): unknown {
	const fixture = loadAdmissionFixture(name) as Record<string, unknown>;
	const request = fixture.request as Record<string, unknown>;
	return {
		...fixture,
		request: {
			...request,
			requested_capabilities: requestedSideEffects,
			requested_side_effects: requestedSideEffects,
		},
	};
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

function createBootstrapDoctorReport(ok = true) {
	return {
		ok,
		checks: [
			{
				id: "node",
				label: "Node.js",
				ok,
				required: true,
				expected: ">=24.13.1 <25",
				detected: ok ? "24.13.2" : "22.22.2",
				message: ok
					? "detected 24.13.2; supports >=24.13.1 <25"
					: "Buildplane requires Node >=24.13.1 <25. Detected 22.22.2.",
			},
			{
				id: "node_sqlite",
				label: "node:sqlite",
				ok,
				required: true,
				message: ok
					? "node:sqlite import available"
					: "node:sqlite import failed",
			},
			{
				id: "npm",
				label: "npm",
				ok,
				required: true,
				command: "npm --version",
				detected: ok ? "10.9.0" : undefined,
				message: ok ? "npm 10.9.0" : "command not available",
			},
			{
				id: "git",
				label: "git",
				ok,
				required: true,
				command: "git --version",
				detected: ok ? "git version 2.49.0" : undefined,
				message: ok ? "git version 2.49.0" : "command not available",
			},
		],
		notes: [
			".node-version pins the tested development baseline; the published CLI accepts compatible Node 24 runtimes.",
			"Published memory is available only when the installed package includes a packaged native binary for this platform.",
		],
	};
}

function createCapabilityReport(ok = true) {
	return {
		ok,
		environment: {
			detectedNodeVersion: ok ? "24.13.2" : "22.22.2",
			supportedNodeRange: ">=24.13.1 <25",
		},
		capabilities: [
			{
				id: "node",
				label: "Node.js",
				ok,
				required: true,
				available: ok,
				expected: ">=24.13.1 <25",
				detected: ok ? "24.13.2" : "22.22.2",
				message: ok
					? "detected 24.13.2; supports >=24.13.1 <25"
					: "Buildplane requires Node >=24.13.1 <25. Detected 22.22.2.",
			},
			{
				id: "published_memory",
				label: "Published memory",
				ok: false,
				required: false,
				available: false,
				message: "packaged linux-x64 native binary not found in vendor/native",
			},
		],
		notes: [
			".node-version pins the tested development baseline; the published CLI accepts compatible Node 24 runtimes.",
		],
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
		expect(result.stdout.join("\n")).toContain("bootstrap doctor");
		expect(result.stdout.join("\n")).toContain("workflow scan");
	});

	it("bootstrap doctor prints a deterministic human prerequisite report before init", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-bootstrap-doctor-human-"),
		);

		const result = await runCliCapture(root, ["bootstrap", "doctor"], {
			inspectBootstrapDoctor: () => createBootstrapDoctorReport(true),
		} as unknown as RunCliDependencies);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toContain("bootstrap-doctor: pass");
		expect(result.stdout).toContain(
			"  - [pass] node: detected 24.13.2; supports >=24.13.1 <25",
		);
		expect(result.stdout).toContain(
			"  - [pass] node_sqlite: node:sqlite import available",
		);
		expect(result.stdout).toContain("  - [pass] npm: npm 10.9.0");
		expect(result.stdout).toContain(
			"  - Published memory is available only when the installed package includes a packaged native binary for this platform.",
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("bootstrap doctor --json returns a failing report without creating .buildplane", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-bootstrap-doctor-json-"),
		);

		const result = await runCliCapture(
			root,
			["bootstrap", "doctor", "--json"],
			{
				inspectBootstrapDoctor: () => createBootstrapDoctorReport(false),
			} as unknown as RunCliDependencies,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toEqual(
			createBootstrapDoctorReport(false),
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("bootstrap doctor --capabilities prints deterministic human capability truth", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-capabilities-human-"),
		);
		const result = await runCliCapture(
			root,
			["bootstrap", "doctor", "--capabilities"],
			{
				inspectCapabilities: () => createCapabilityReport(true),
			} as unknown as RunCliDependencies,
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toContain("capabilities: pass");
		expect(result.stdout.join("\n")).toContain("node");
		expect(result.stdout.join("\n")).toContain("published_memory");
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("bootstrap doctor --capabilities --json returns capability report", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-capabilities-json-"),
		);
		const report = createCapabilityReport(true);
		const result = await runCliCapture(
			root,
			["bootstrap", "doctor", "--capabilities", "--json"],
			{ inspectCapabilities: () => report } as unknown as RunCliDependencies,
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toEqual(report);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("bootstrap doctor --capabilities rejects unsupported extra arguments", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-capabilities-invalid-"),
		);
		const result = await runCliCapture(root, [
			"bootstrap",
			"doctor",
			"--capabilities",
			"unexpected",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([]);
		expect(result.stderr.join("\n")).toContain(
			"Unsupported bootstrap doctor arguments: --capabilities unexpected",
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("bootstrap doctor rejects unsupported extra arguments", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-bootstrap-doctor-invalid-"),
		);

		const result = await runCliCapture(root, [
			"bootstrap",
			"doctor",
			"unexpected",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([]);
		expect(result.stderr.join("\n")).toContain(
			"Unsupported bootstrap doctor arguments: unexpected",
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("bootstrap seed writes repo.* facts and reports them", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-seed-"));
		// initialize a project so the state DB exists
		createBuildplaneStorage(root).initializeProject();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { test: "vitest --run", build: "tsc -b" } }),
		);
		writeFileSync(join(root, "tsconfig.json"), "{}");

		const result = await runCliCapture(root, ["bootstrap", "seed", "--json"]);
		expect(result.exitCode).toBe(0);
		const seeded = JSON.parse(result.stdout.join("\n"));
		const keys = seeded.map((f: { factKey: string }) => f.factKey);
		expect(keys).toContain("repo.primary-language");
		expect(keys).toContain("repo.test-runner");
		expect(keys).toContain("repo.build-command");

		// Persisted: a fresh read-only port can list them.
		const facts = createBuildplaneStorage(root).listRepoFacts({
			scopeType: "repo",
		});
		expect(facts.some((f) => f.factKey === "repo.test-runner")).toBe(true);
	});

	it("bootstrap seed rejects unsupported extra arguments", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-bootstrap-seed-invalid-"),
		);
		createBuildplaneStorage(root).initializeProject();

		const result = await runCliCapture(root, ["bootstrap", "seed", "--bogus"]);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toEqual([]);
		expect(result.stderr.join("\n")).toContain(
			"Unsupported bootstrap seed arguments: --bogus",
		);
		const facts = createBuildplaneStorage(root).listRepoFacts({
			scopeType: "repo",
		});
		expect(facts).toEqual([]);
	});

	it("shows top-level help for --help", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-help-flag-"));

		const result = await runCliCapture(root, ["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout.join("\n")).toContain("Execute:");
		expect(result.stdout.join("\n")).toContain("run --packet <path>");
		expect(result.stdout.join("\n")).toContain("replay <id> [--json]");
		expect(result.stdout.join("\n")).toContain(
			"fork <id> --at <event> --packet <file>",
		);
		expect(result.stdout.join("\n")).toContain(
			"ledger replay --run-id <id> --workspace <path>",
		);
	});

	it("shows replay help without requiring init or a run id", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-replay-help-"));

		const result = await runCliCapture(root, ["replay", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const output = result.stdout.join("\n");
		expect(output).toContain("buildplane replay <run-id> [options]");
		expect(output).toContain("Re-executes the stored packet snapshot");
		expect(output).toContain("--policy <profile>");
		expect(output).toContain(
			"buildplane ledger replay --run-id <run-id> --workspace <path>",
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("routes bare replay/fork help tokens to help output instead of parsing them as ids", async () => {
		const replayRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-replay-help-token-"),
		);
		const replayResult = await runCliCapture(replayRoot, ["replay", "help"]);

		expect(replayResult.exitCode).toBe(0);
		expect(replayResult.stderr).toEqual([]);
		expect(replayResult.stdout.join("\n")).toContain(
			"buildplane replay <run-id> [options]",
		);
		expect(replayResult.stdout.join("\n")).toContain("--policy <profile>");
		expect(existsSync(join(replayRoot, ".buildplane"))).toBe(false);

		const forkRoot = mkdtempSync(
			join(tmpdir(), "buildplane-cli-fork-help-token-"),
		);
		const forkResult = await runCliCapture(forkRoot, ["fork", "help"]);

		expect(forkResult.exitCode).toBe(0);
		expect(forkResult.stderr).toEqual([]);
		expect(forkResult.stdout.join("\n")).toContain(
			"buildplane fork <parent-run-id> --at <event-id> --packet <file>",
		);
		expect(existsSync(join(forkRoot, ".buildplane"))).toBe(false);
	});

	it("applies replay policy overrides from both --policy=<profile> and --policy <profile>", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-replay-policy-"));
		const capturedPolicies: string[] = [];
		const packetSnapshot = createPassingPacket("unit-replay-policy");

		vi.doMock("@buildplane/storage", () => ({
			createBuildplaneStorage: () => ({
				getPacketSnapshot: (_runId: string) => packetSnapshot,
			}),
			createEventStore: () => ({
				persistEvent: (_runId: string, _event: unknown) => {},
			}),
		}));
		vi.doMock("@buildplane/kernel", () => ({
			createEventBus: () => ({
				subscribe: (_listener: (event: unknown) => void) => () => {},
				emit: (_event: unknown) => {},
			}),
		}));

		const dependencies: RunCliDependencies = {
			createOrchestrator: () =>
				({
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
					async runPacketAsync(packet: unknown) {
						const replayPacket = packet as {
							unit?: { policyProfile?: string };
						};
						capturedPolicies.push(replayPacket.unit?.policyProfile ?? "");
						return {
							run: {
								id: `run-replay-${capturedPolicies.length}`,
								status: "passed",
							},
							receipt: null,
							decision: null,
						};
					},
					async runGraphAsync() {
						return { outcome: "passed" as const, nodes: [] };
					},
					async runStrategy() {
						return {
							strategyId: "strategy-1",
							mode: "single",
							outcome: "passed" as const,
							childResults: new Map(),
							mergeDecision: {
								policy: "default",
								outcome: "passed",
								reasons: [],
							},
						};
					},
					getStatus() {
						return { initialized: true };
					},
					inspect(id: string) {
						return { kind: "run", run: { id } };
					},
				}) as BuildplaneOrchestrator,
		};

		try {
			const equalsResult = await runCliCapture(
				root,
				["replay", "run-policy-equals", "--policy=safe"],
				dependencies,
			);
			expect(equalsResult.exitCode).toBe(0);

			const spaceResult = await runCliCapture(
				root,
				["replay", "run-policy-space", "--policy", "safe"],
				dependencies,
			);
			expect(spaceResult.exitCode).toBe(0);

			const helpValueResult = await runCliCapture(
				root,
				["replay", "run-policy-help-value", "--policy", "help"],
				dependencies,
			);
			expect(helpValueResult.exitCode).toBe(0);

			expect(capturedPolicies).toEqual(["safe", "safe", "help"]);
		} finally {
			vi.doUnmock("@buildplane/storage");
			vi.doUnmock("@buildplane/kernel");
		}
	});

	it("shows fork help without requiring init or fork args", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-fork-help-"));

		const result = await runCliCapture(root, ["fork", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const output = result.stdout.join("\n");
		expect(output).toContain(
			"buildplane fork <parent-run-id> --at <event-id> --packet <file>",
		);
		expect(output).toContain("Fork resumes from a unit boundary");
		expect(output).toContain("workspace git state must be clean");
		expect(output).toContain("Target event must be a unit_started event");
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("workflow scan prints a preview of recognized workflow files without init", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-workflow-scan-human-"),
		);
		writeWorkspaceFile(root, "CLAUDE.md", "# Claude instructions\n");
		writeWorkspaceFile(root, ".claude/settings.json", "{}\n");
		writeWorkspaceFile(root, ".claude/hooks/pre_tool_use.py", "print('hi')\n");
		writeWorkspaceFile(root, ".codex/config.toml", "model = 'o3'\n");
		writeWorkspaceFile(root, ".codex/auth.json", "ignored\n");

		const result = await runCliCapture(root, ["workflow", "scan"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toContain("workflow-findings: 4");
		expect(result.stdout).toContain("  - [shared/instructions] CLAUDE.md");
		expect(result.stdout).toContain(
			"  - [claude/config] .claude/settings.json",
		);
		expect(result.stdout).toContain(
			"  - [claude/hooks] .claude/hooks/pre_tool_use.py",
		);
		expect(result.stdout).toContain("  - [codex/config] .codex/config.toml");
		expect(result.stdout).toContain(
			"preview-only: no workflow data was imported",
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("workflow scan --json returns a deterministic preview before init", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-workflow-scan-json-"),
		);
		writeWorkspaceFile(root, "AGENTS.md", "# shared\n");
		writeWorkspaceFile(root, ".codex/AGENTS.md", "# codex\n");
		writeWorkspaceFile(root, ".codex/config.toml", "model = 'o3'\n");
		writeWorkspaceFile(root, ".claude/auth.json", "ignored\n");

		const result = await runCliCapture(root, ["workflow", "scan", "--json"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toEqual({
			preview: true,
			findings: [
				{ path: "AGENTS.md", source: "shared", kind: "instructions" },
				{ path: ".codex/AGENTS.md", source: "codex", kind: "instructions" },
				{ path: ".codex/config.toml", source: "codex", kind: "config" },
			],
		});
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
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

	it("supports the evidence-first inspector projection for inspect", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-inspector-view-"));
		await runCliCapture(root, ["init"]);
		const inspectSnapshot = {
			kind: "run",
			unit: { id: "unit-inspector", kind: "command" },
			run: {
				id: "run-inspector",
				unitId: "unit-inspector",
				status: "passed",
			},
			eventTape: {
				runId: "run-inspector",
				eventCount: 1,
				firstKind: "run_started",
				lastKind: "run_completed",
				terminalStatus: "passed",
				events: [
					{
						id: "event-1",
						kind: "run_completed",
						occurredAt: "2026-05-16T00:00:00.000Z",
						summary: "completed",
					},
				],
			},
			evidence: [{ kind: "command-exit", status: "pass", message: "exit 0" }],
			decisions: [
				{
					kind: "advance-run",
					outcome: "approved",
					reasons: ["required output exists"],
				},
			],
			artifacts: [{ type: "log", location: ".buildplane/log.txt" }],
		};
		const dependencies: RunCliDependencies = {
			createOrchestrator: () =>
				({
					inspect: () => inspectSnapshot,
					initializeProject() {
						throw new Error("not used");
					},
					runPacket() {
						throw new Error("not used");
					},
					async runPacketAsync() {
						throw new Error("not used");
					},
					getStatus() {
						throw new Error("not used");
					},
					approveRun() {
						throw new Error("not used");
					},
					rejectSuspendedRun() {
						throw new Error("not used");
					},
					async runGraphAsync() {
						throw new Error("not used");
					},
					async runStrategy() {
						throw new Error("not used");
					},
				}) as unknown as BuildplaneOrchestrator,
		};

		const human = await runCliCapture(
			root,
			["inspect", "run-inspector", "--view", "inspector"],
			dependencies,
		);
		const json = await runCliCapture(
			root,
			["inspect", "run-inspector", "--json", "--view=inspector"],
			dependencies,
		);
		const rawJson = await runCliCapture(
			root,
			["inspect", "run-inspector", "--json"],
			dependencies,
		);

		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("Run Inspector");
		expect(human.stdout).toContain("Outcome Strip");
		expect(human.stdout).toContain("Event Timeline");
		expect(human.stdout).toContain("Evidence Pane");
		expect(json.exitCode).toBe(0);
		expect(JSON.parse(json.stdout.join("\n"))).toMatchObject({
			kind: "run-inspector",
			runId: "run-inspector",
			outcomeStrip: { verdict: "PASSED" },
		});
		expect(rawJson.exitCode).toBe(0);
		expect(JSON.parse(rawJson.stdout.join("\n"))).toMatchObject({
			kind: "run",
			run: { id: "run-inspector" },
		});
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

	it("emits admission receipt dry-run JSON without initialization, worker, native, or remote side effects", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-admission-"));
		const inputPath = writePacket(
			root,
			"admission/pass.json",
			loadAdmissionFixture("pass"),
		);
		const createOrchestrator = vi.fn();
		const runNativeCommand = vi.fn();
		const publishPrCheckRequest = vi.fn();
		const publishPrCommentRequest = vi.fn();
		const verifyPrHeadRequest = vi.fn();

		const result = await runCliCapture(
			root,
			["admission", "receipt", "--input", inputPath, "--dry-run", "--json"],
			{
				createOrchestrator: createOrchestrator as NonNullable<
					RunCliDependencies["createOrchestrator"]
				>,
				runNativeCommand,
				publishPrCheckRequest: publishPrCheckRequest as NonNullable<
					RunCliDependencies["publishPrCheckRequest"]
				>,
				publishPrCommentRequest: publishPrCommentRequest as NonNullable<
					RunCliDependencies["publishPrCommentRequest"]
				>,
				verifyPrHeadRequest: verifyPrHeadRequest as NonNullable<
					RunCliDependencies["verifyPrHeadRequest"]
				>,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const receipt = JSON.parse(result.stdout.join("\n"));
		expect(receipt).toMatchObject({
			receipt_type: "run.admission",
			run: { run_id: "run_bp1_pass_0001" },
			admission: {
				decision: "PASS",
				will_execute_worker: false,
				authorized_next_step: "record_admission_only",
			},
			replay: { side_effect_safe: true },
			provenance: { worker_agent_trusted: false },
		});
		expect(receipt.idempotency_key).toMatch(/^run\.admission:v0:sha256:/);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
		expect(createOrchestrator).not.toHaveBeenCalled();
		expect(runNativeCommand).not.toHaveBeenCalled();
		expect(publishPrCheckRequest).not.toHaveBeenCalled();
		expect(publishPrCommentRequest).not.toHaveBeenCalled();
		expect(verifyPrHeadRequest).not.toHaveBeenCalled();
	});

	it("fails admission receipt dry-run closed when required evidence is absent", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-admission-missing-evidence-"),
		);
		const inputPath = writePacket(
			root,
			"admission/missing-rev-parse.json",
			loadAdmissionFixtureWithoutEvidence("pass", "git.rev-parse"),
		);
		const createOrchestrator = vi.fn();
		const runNativeCommand = vi.fn();
		const publishPrCheckRequest = vi.fn();
		const publishPrCommentRequest = vi.fn();
		const verifyPrHeadRequest = vi.fn();

		const result = await runCliCapture(
			root,
			["admission", "receipt", "--input", inputPath, "--dry-run", "--json"],
			{
				createOrchestrator: createOrchestrator as NonNullable<
					RunCliDependencies["createOrchestrator"]
				>,
				runNativeCommand,
				publishPrCheckRequest: publishPrCheckRequest as NonNullable<
					RunCliDependencies["publishPrCheckRequest"]
				>,
				publishPrCommentRequest: publishPrCommentRequest as NonNullable<
					RunCliDependencies["publishPrCommentRequest"]
				>,
				verifyPrHeadRequest: verifyPrHeadRequest as NonNullable<
					RunCliDependencies["verifyPrHeadRequest"]
				>,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const receipt = JSON.parse(result.stdout.join("\n"));
		expect(receipt).toMatchObject({
			admission: {
				decision: "INSUFFICIENT_EVIDENCE",
				missing_evidence: ["git.rev-parse"],
				unsafe_requests: [],
				will_execute_worker: false,
				authorized_next_step:
					"capture_missing_evidence_then_recompute_admission",
			},
			policy: {
				allowed_side_effects: [],
				capability_grants: [],
				quarantine: false,
			},
		});
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
		expect(createOrchestrator).not.toHaveBeenCalled();
		expect(runNativeCommand).not.toHaveBeenCalled();
		expect(publishPrCheckRequest).not.toHaveBeenCalled();
		expect(publishPrCommentRequest).not.toHaveBeenCalled();
		expect(verifyPrHeadRequest).not.toHaveBeenCalled();
	});

	it("fails admission receipt dry-run closed when repo binding and evidence inputs are omitted", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-admission-omitted-binding-"),
		);
		const inputPath = writePacket(
			root,
			"admission/omitted-binding.json",
			loadAdmissionFixtureWithoutRepoOrEvidence("pass"),
		);
		const createOrchestrator = vi.fn();
		const runNativeCommand = vi.fn();

		const result = await runCliCapture(
			root,
			["admission", "receipt", "--input", inputPath, "--dry-run", "--json"],
			{
				createOrchestrator: createOrchestrator as NonNullable<
					RunCliDependencies["createOrchestrator"]
				>,
				runNativeCommand,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const receipt = JSON.parse(result.stdout.join("\n"));
		expect(receipt.admission.decision).toBe("INSUFFICIENT_EVIDENCE");
		expect(receipt.admission.missing_evidence).toEqual(
			expect.arrayContaining([
				"git.status",
				"git.rev-parse",
				"declared_scope",
				"repo.base_commit",
				"repo.worktree_path",
			]),
		);
		expect(receipt.policy.allowed_side_effects).toEqual([]);
		expect(receipt.policy.capability_grants).toEqual([]);
		expect(receipt.admission.will_execute_worker).toBe(false);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
		expect(createOrchestrator).not.toHaveBeenCalled();
		expect(runNativeCommand).not.toHaveBeenCalled();
	});

	it("fails admission receipt dry-run closed for unknown auto-Kanban side effects", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-admission-kanban-side-effect-"),
		);
		const inputPath = writePacket(
			root,
			"admission/kanban-side-effect.json",
			loadAdmissionFixtureWithSideEffects("pass", [
				"fs.read:repo",
				"kanban.write:auto",
			]),
		);
		const createOrchestrator = vi.fn();
		const runNativeCommand = vi.fn();
		const publishPrCheckRequest = vi.fn();
		const publishPrCommentRequest = vi.fn();
		const verifyPrHeadRequest = vi.fn();

		const result = await runCliCapture(
			root,
			["admission", "receipt", "--input", inputPath, "--dry-run", "--json"],
			{
				createOrchestrator: createOrchestrator as NonNullable<
					RunCliDependencies["createOrchestrator"]
				>,
				runNativeCommand,
				publishPrCheckRequest: publishPrCheckRequest as NonNullable<
					RunCliDependencies["publishPrCheckRequest"]
				>,
				publishPrCommentRequest: publishPrCommentRequest as NonNullable<
					RunCliDependencies["publishPrCommentRequest"]
				>,
				verifyPrHeadRequest: verifyPrHeadRequest as NonNullable<
					RunCliDependencies["verifyPrHeadRequest"]
				>,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const receipt = JSON.parse(result.stdout.join("\n"));
		expect(receipt).toMatchObject({
			admission: {
				decision: "UNSAFE_TO_RUN",
				missing_evidence: [],
				unsafe_requests: ["kanban.write:auto"],
				will_execute_worker: false,
				authorized_next_step: "freeze_and_require_explicit_release_authority",
			},
			policy: {
				allowed_side_effects: ["fs.read:repo"],
				quarantine: true,
			},
		});
		expect(receipt.policy.denied_side_effects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ effect: "kanban.write:auto" }),
			]),
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
		expect(createOrchestrator).not.toHaveBeenCalled();
		expect(runNativeCommand).not.toHaveBeenCalled();
		expect(publishPrCheckRequest).not.toHaveBeenCalled();
		expect(publishPrCommentRequest).not.toHaveBeenCalled();
		expect(verifyPrHeadRequest).not.toHaveBeenCalled();
	});

	it("fails admission receipt dry-run input validation without leaking credential-shaped values", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-admission-invalid-"),
		);
		const sensitiveValue = ["ghp", "dummy_value_not_a_real_credential"].join(
			"_",
		);
		const inputPath = writePacket(root, "admission/invalid.json", {
			unsafe_value: sensitiveValue,
			request: { requested_side_effects: ["git.push:remote"] },
		});
		const createOrchestrator = vi.fn();

		const result = await runCliCapture(
			root,
			["admission", "receipt", "--input", inputPath, "--dry-run", "--json"],
			{
				createOrchestrator: createOrchestrator as NonNullable<
					RunCliDependencies["createOrchestrator"]
				>,
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		const output = result.stdout.join("\n");
		expect(output).not.toContain(sensitiveValue);
		expect(JSON.parse(output)).toMatchObject({
			error: { code: "INVALID_PACKET" },
		});
		expect(createOrchestrator).not.toHaveBeenCalled();
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("persists CLI-created run admission receipts with kernel contents and digest refs", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);
		const packetPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/cli-admission-receipt.json",
			createPassingPacket("unit-cli-store-integrity"),
		);

		const result = await runCliCapture(root, [
			"run",
			"--raw",
			"--packet",
			packetPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const eventsPath = join(
			root,
			".git",
			"buildplane",
			"admission",
			"events.jsonl",
		);
		expect(existsSync(eventsPath)).toBe(true);
		const events = readFileSync(eventsPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						kind?: string;
						payload?: {
							receipt_id?: string;
							receipt_digest?: string;
							receipt_ref?: string;
							unit_id?: string;
						};
					},
			);
		const recordedEvent = events.find(
			(event) =>
				event.kind === "run_admission_recorded" &&
				event.payload?.unit_id === "unit-cli-store-integrity",
		);
		if (!recordedEvent?.payload?.receipt_id) {
			throw new Error("missing run admission receipt event");
		}
		const payload = recordedEvent.payload;
		expect(payload.receipt_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(payload.receipt_ref).toBe(
			`artifact://run-admission/${payload.receipt_digest}`,
		);
		const receiptPath = join(
			root,
			".git",
			"buildplane",
			"admission",
			"receipts",
			`${payload.receipt_id}.json`,
		);
		expect(existsSync(receiptPath)).toBe(true);
		const receiptContents = readFileSync(receiptPath, "utf8");
		expect(
			`sha256:${createHash("sha256").update(receiptContents).digest("hex")}`,
		).toBe(payload.receipt_digest);
		expect(JSON.parse(receiptContents)).toMatchObject({
			receipt_id: payload.receipt_id,
			run: { unit_id: "unit-cli-store-integrity" },
		});
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

	it("persists reviewer-leg injected memories for implement-then-review strategies", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const storage = createBuildplaneStorage(root);
		storage.createProcedure({
			name: "How to review a change",
			taskType: "review",
			bodyMarkdown: "Confirm the objective is satisfied before approving.",
			createdBy: "worker",
		});

		const strategyPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/reviewer-injected-strategy.json",
			{
				id: "strategy-reviewer-injected",
				mode: "implement-then-review",
				mergePolicy: "reviewer-must-approve",
				children: [
					{
						role: "implementer",
						packet: {
							...createPassingPacket("reviewer-injected-impl"),
							intent: {
								objective: "Write a parser",
								taskType: "implement",
								context: { files: [] },
								constraints: { scope: ["apps/cli/src"], verification: [] },
								features: {
									ambiguity: "low",
									reversibility: "easy",
									verifierStrength: "strong",
								},
							},
						},
					},
					{
						role: "reviewer",
						dependsOn: ["reviewer-injected-impl"],
						packet: {
							unit: {
								id: "reviewer-injected-reviewer",
								kind: "command",
								scope: "task",
								inputRefs: [],
								expectedOutputs: [],
								verificationContract: "exit-0-and-required-outputs",
								policyProfile: "default",
							},
							execution: { command: "true", args: [] },
							intent: {
								objective:
									"Review whether the implementer satisfied: Write a parser",
								taskType: "review",
								context: { files: [] },
								constraints: { scope: [], verification: [] },
								features: {
									ambiguity: "low",
									reversibility: "easy",
									verifierStrength: "strong",
								},
							},
							verification: { requiredOutputs: [] },
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
		const reviewerInspect = await runCliCapture(root, [
			"inspect",
			"reviewer-injected-reviewer",
			"--json",
		]);

		expect(runStrategy.exitCode).toBe(0);
		const reviewerRun = JSON.parse(reviewerInspect.stdout.join("\n"));
		expect(reviewerRun).toMatchObject({
			run: { unitId: "reviewer-injected-reviewer", status: "passed" },
			injectedMemories: [
				{ memoryKind: "procedure", matchReason: "exact-task-type" },
			],
		});

		const reviewerRunId = reviewerRun.run.id as string;
		expect(storage.listInjectedMemories(reviewerRunId).length).toBeGreaterThan(
			0,
		);
	});

	it("persists reviewer-leg injected memories on the default run --packet path", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);

		const storage = createBuildplaneStorage(root);
		storage.createProcedure({
			name: "How to review a change",
			taskType: "review",
			bodyMarkdown: "Confirm the objective is satisfied before approving.",
			createdBy: "worker",
		});

		const packetPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/default-packet-reviewer.json",
			{
				...createPassingPacket("default-packet-reviewer-impl"),
				intent: {
					objective: "Write a parser",
					taskType: "implement",
					context: { files: [] },
					constraints: { scope: ["apps/cli/src"], verification: [] },
					features: {
						ambiguity: "low",
						reversibility: "easy",
						verifierStrength: "strong",
					},
				},
			},
		);

		const run = await runCliCapture(root, ["run", "--packet", packetPath]);
		expect(run.exitCode).toBe(0);

		const reviewerInspect = await runCliCapture(root, [
			"inspect",
			"default-packet-reviewer-impl-reviewer",
			"--json",
		]);
		const reviewerRun = JSON.parse(reviewerInspect.stdout.join("\n"));
		expect(reviewerRun).toMatchObject({
			run: {
				unitId: "default-packet-reviewer-impl-reviewer",
				status: "passed",
			},
			injectedMemories: [
				{ memoryKind: "procedure", matchReason: "exact-task-type" },
			],
		});

		const reviewerRunId = reviewerRun.run.id as string;
		expect(storage.listInjectedMemories(reviewerRunId).length).toBeGreaterThan(
			0,
		);
	});

	it("surfaces strategy lineage and memory summaries in inspect and history for strategy runs", async () => {
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
			".buildplane/test-packets/strategy-history.json",
			{
				id: "strategy-history",
				mode: "single",
				mergePolicy: "direct",
				children: [
					{
						role: "implementer",
						packet: {
							...createPassingPacket("strategy-history-unit"),
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
		const inspectHuman = await runCliCapture(root, [
			"inspect",
			"strategy-history-unit",
		]);
		const inspectJson = await runCliCapture(root, [
			"inspect",
			"strategy-history-unit",
			"--json",
		]);
		const historyHuman = await runCliCapture(root, ["history"]);
		const historyJson = await runCliCapture(root, ["history", "--json"]);

		expect(runStrategy.exitCode).toBe(0);
		expect(inspectHuman.stdout).toEqual(
			expect.arrayContaining(["strategy: strategy-history"]),
		);
		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			strategy: { strategyId: "strategy-history" },
		});
		expect(historyHuman.stdout.join("\n")).toContain("strategy-history");
		expect(historyHuman.stdout.join("\n")).toContain("mem=2/0");
		expect(JSON.parse(historyJson.stdout.join("\n"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					unitId: "strategy-history-unit",
					strategyId: "strategy-history",
					injectedMemoryCount: 2,
					promotedStructuredMemoryCount: 0,
				}),
			]),
		);
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

	it("preserves native json output for pack show --json success paths", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pack-show-json-success-"),
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
				options.stdout('{"selectionReason":"explicit provider requested"}');
				options.stderr("pack-show-json-warn");
				return 7;
			},
		};

		const result = await runCliCapture(
			root,
			["pack", "show", "superclaude", "--json"],
			dependencies,
		);

		expect(result.exitCode).toBe(7);
		expect(result.stdout).toEqual([
			'{"selectionReason":"explicit provider requested"}',
		]);
		expect(result.stderr).toEqual(["pack-show-json-warn"]);
		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["pack", "show"],
				argv: ["superclaude", "--json"],
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
				checkWorktreeClean: () => true,
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

	it("lists actionable workspaces in human and json output", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const workspaceAdapter = createActualGitWorkspaceAdapter();
		const headSha = git(root, ["rev-parse", "HEAD"]).trim();

		const retainedRun = storage.createRun({
			...createPassingPacket("unit-workspace-retained"),
		});
		const retainedWorkspace = workspaceAdapter.prepareWorkspace(
			root,
			retainedRun.id,
			headSha,
		);
		storage.recordWorkspacePrepared(retainedRun.id, {
			path: retainedWorkspace.path,
			headSha: retainedWorkspace.headSha,
			sourceProjectRoot: root,
		});
		storage.commitRunFailureOutcome(retainedRun.id, {
			decision: {
				kind: "reject-run",
				outcome: "rejected",
				reasons: ["command exited with code 1"],
			},
			workspaceStatus: "retained",
		});

		const cleanupRun = storage.createRun({
			...createPassingPacket("unit-workspace-cleanup-failed"),
		});
		const cleanupWorkspace = workspaceAdapter.prepareWorkspace(
			root,
			cleanupRun.id,
			headSha,
		);
		storage.recordWorkspacePrepared(cleanupRun.id, {
			path: cleanupWorkspace.path,
			headSha: cleanupWorkspace.headSha,
			sourceProjectRoot: root,
		});
		storage.markRunRunning(cleanupRun.id);
		storage.commitRunSuccessOutcome(cleanupRun.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: [],
		});
		storage.recordWorkspaceCleanupFailed(cleanupRun.id, "disk busy");

		const human = await runCliCapture(root, ["workspace", "list"]);
		const json = await runCliCapture(root, ["workspace", "list", "--json"]);

		expect(human.exitCode).toBe(0);
		expect(human.stdout.join("\n")).toContain(retainedRun.id);
		expect(human.stdout.join("\n")).toContain(cleanupRun.id);
		expect(human.stdout.join("\n")).toContain("retained");
		expect(human.stdout.join("\n")).toContain("cleanup-failed");
		expect(human.stdout.join("\n")).toContain("cleanup-error: disk busy");
		expect(JSON.parse(json.stdout.join("\n"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					runId: retainedRun.id,
					status: "retained",
					path: retainedWorkspace.path,
				}),
				expect.objectContaining({
					runId: cleanupRun.id,
					status: "cleanup-failed",
					path: cleanupWorkspace.path,
					cleanupError: "disk busy",
				}),
			]),
		);
	});

	it("cleans up retained workspaces and removes them from actionable status", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);
		const packetPath = writeCommittedPacket(
			root,
			".buildplane/test-packets/cleanup-retained.json",
			createFailingPacket("unit-cleanup-retained"),
		);

		const runResult = await runCliCapture(root, [
			"run",
			"--raw",
			"--packet",
			packetPath,
		]);
		const runId = extractRunId(runResult.stdout);
		const cleanup = await runCliCapture(root, ["workspace", "cleanup", runId]);
		const statusJson = await runCliCapture(root, ["status", "--json"]);
		const inspectJson = await runCliCapture(root, ["inspect", runId, "--json"]);

		expect(cleanup.exitCode).toBe(0);
		expect(cleanup.stdout).toEqual(
			expect.arrayContaining([
				"workspace-cleanup: deleted",
				`run-id: ${runId}`,
			]),
		);
		expect(JSON.parse(statusJson.stdout.join("\n"))).toMatchObject({
			actionableWorkspaces: [],
		});
		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			workspace: {
				status: "deleted",
				existsOnDisk: false,
			},
		});
	});

	it("cleans up cleanup-failed workspaces and removes them from actionable status", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const workspaceAdapter = createActualGitWorkspaceAdapter();
		const headSha = git(root, ["rev-parse", "HEAD"]).trim();

		const run = storage.createRun({
			...createPassingPacket("unit-cleanup-failed-operator"),
		});
		const preparedWorkspace = workspaceAdapter.prepareWorkspace(
			root,
			run.id,
			headSha,
		);
		storage.recordWorkspacePrepared(run.id, {
			path: preparedWorkspace.path,
			headSha: preparedWorkspace.headSha,
			sourceProjectRoot: root,
		});
		storage.markRunRunning(run.id);
		storage.commitRunSuccessOutcome(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: [],
		});
		storage.recordWorkspaceCleanupFailed(run.id, "disk busy");

		const cleanup = await runCliCapture(root, [
			"workspace",
			"cleanup",
			run.id,
			"--json",
		]);
		const statusJson = await runCliCapture(root, ["status", "--json"]);
		const inspectJson = await runCliCapture(root, [
			"inspect",
			run.id,
			"--json",
		]);

		expect(cleanup.exitCode).toBe(0);
		expect(JSON.parse(cleanup.stdout.join("\n"))).toMatchObject({
			runId: run.id,
			status: "deleted",
			previousStatus: "cleanup-failed",
			path: preparedWorkspace.path,
		});
		expect(JSON.parse(statusJson.stdout.join("\n"))).toMatchObject({
			actionableWorkspaces: [],
		});
		expect(JSON.parse(inspectJson.stdout.join("\n"))).toMatchObject({
			workspace: {
				status: "deleted",
				existsOnDisk: false,
			},
		});
	});

	it("returns stable errors for unknown and non-actionable workspace cleanup requests", async () => {
		const root = createGitRepo();
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun({
			...createPassingPacket("unit-workspace-active"),
		});
		const workspacePath = join(root, ".buildplane", "workspaces", run.id);
		mkdirSync(workspacePath, { recursive: true });
		storage.recordWorkspacePrepared(run.id, {
			path: workspacePath,
			headSha: "abc123",
			sourceProjectRoot: root,
		});

		const unknown = await runCliCapture(root, [
			"workspace",
			"cleanup",
			"missing-run",
			"--json",
		]);
		const nonActionable = await runCliCapture(root, [
			"workspace",
			"cleanup",
			run.id,
			"--json",
		]);

		expect(unknown.exitCode).toBe(1);
		expect(JSON.parse(unknown.stdout.join("\n"))).toMatchObject({
			error: { code: "NOT_FOUND" },
		});
		expect(nonActionable.exitCode).toBe(1);
		expect(JSON.parse(nonActionable.stdout.join("\n"))).toMatchObject({
			error: { code: "WORKSPACE_NOT_ACTIONABLE" },
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

	it("reuses the existing CLI event bus for TUI execution instead of creating a separate TUI bus", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-tui-bus-"));
		const renderTuiMock = vi.fn(() => ({
			waitUntilExit: async () => {},
			unmount: () => {},
			clear: () => {},
		}));
		const createEventBusMock = vi.fn(() => ({
			subscribe: () => () => {},
			emit: () => {},
		}));
		vi.doMock("@buildplane/ui-tui", () => ({ renderTui: renderTuiMock }));
		vi.doMock("@buildplane/kernel", () => ({
			createEventBus: createEventBusMock,
		}));
		let asyncBus: unknown;
		const dependencies: RunCliDependencies = {
			createOrchestrator: () => ({
				initializeProject() {
					return {
						created: true,
						projectRoot: root,
						stateDbPath: join(root, ".buildplane", "state.db"),
					};
				},
				runPacket() {
					throw new Error("sync path should not be used for --tui");
				},
				async runPacketAsync(_packet: unknown, eventBus?: unknown) {
					asyncBus = eventBus;
					return {
						run: { id: "run-tui", status: "passed" },
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
			parsePacket() {
				return {
					unit: {
						id: "unit-tui-command",
						kind: "command",
						scope: "task",
						inputRefs: [],
						expectedOutputs: [],
						verificationContract: "exit-0",
						policyProfile: "default",
					},
					execution: {
						command: "node",
						args: ["-e", "console.log('ok')"],
					},
					verification: { requiredOutputs: [] },
				};
			},
		};

		try {
			const result = await runCliCapture(
				root,
				["run", "--raw", "--tui", "--packet", "command-packet.json"],
				dependencies,
			);

			expect(result.exitCode).toBe(0);
			expect(createEventBusMock).not.toHaveBeenCalled();
			expect(renderTuiMock).toHaveBeenCalledTimes(1);
			expect(asyncBus).toBe(renderTuiMock.mock.calls[0]?.[0]);
		} finally {
			vi.doUnmock("@buildplane/ui-tui");
			vi.doUnmock("@buildplane/kernel");
		}
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
				checkWorktreeClean: () => true,
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

	it("delegates no-id memory inspect forms to native", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-inspect-no-id-native-"),
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

		const inspectResult = await runCliCapture(
			root,
			["memory", "inspect"],
			dependencies,
		);
		const inspectJsonResult = await runCliCapture(
			root,
			["memory", "inspect", "--json"],
			dependencies,
		);

		expect(inspectResult.exitCode).toBe(0);
		expect(inspectJsonResult.exitCode).toBe(0);
		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["inspect"],
			},
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["inspect", "--json"],
			},
		]);
	});

	it("delegates id-plus-extra-flag memory inspect forms to native", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-inspect-id-flags-native-"),
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

		const result = await runCliCapture(
			root,
			["memory", "inspect", "mem_123", "--include-forgotten"],
			dependencies,
		);

		expect(result.exitCode).toBe(0);
		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["inspect", "mem_123", "--include-forgotten"],
			},
		]);
	});

	it("delegates advanced memory inspect forms to native", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-inspect-native-fallthrough-"),
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

		const result = await runCliCapture(
			root,
			["memory", "inspect", "--effective", "--json"],
			dependencies,
		);

		expect(result.exitCode).toBe(0);
		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["inspect", "--effective", "--json"],
			},
		]);
	});

	it("preserves native json output for advanced memory inspect success paths", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-inspect-json-success-"),
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
				options.stdout('{"nativeRoot":"/tmp/native","items":[]}');
				options.stderr("memory-inspect-json-warn");
				return 7;
			},
		};

		const result = await runCliCapture(
			root,
			["memory", "inspect", "--effective", "--json"],
			dependencies,
		);

		expect(result.exitCode).toBe(7);
		expect(result.stdout).toEqual(['{"nativeRoot":"/tmp/native","items":[]}']);
		expect(result.stderr).toEqual(["memory-inspect-json-warn"]);
		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["inspect", "--effective", "--json"],
			},
		]);
	});

	async function createProjectWithReceiptBackedLearning(
		options: {
			prefix: string;
			runId: string;
			withVerifierReceipt: boolean;
			learning?: {
				kind: string;
				scope: string;
				title: string;
				body: string;
			};
		} = {
			prefix: "buildplane-cli-memory-promote-",
			runId: "run-cli-memory-promote",
			withVerifierReceipt: true,
		},
	): Promise<{ root: string; runId: string }> {
		const root = mkdtempSync(join(tmpdir(), options.prefix));
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(createPassingPacket(options.runId), {
			runId: options.runId,
		});
		storage.markRunRunning(run.id);
		if (options.withVerifierReceipt) {
			storage.recordExecutionEvidence(run.id, {
				command: "node",
				args: ["-e", "console.log('verified source')"],
				cwd: root,
				startedAt: "2026-05-07T10:00:00.000Z",
				completedAt: "2026-05-07T10:00:01.000Z",
				exitCode: 0,
				stdout: "verified source\n",
				stderr: "",
				outputChecks: [{ path: "tmp/pass.txt", exists: true }],
			});
		}
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: options.withVerifierReceipt
				? ["required output exists"]
				: ["worker claimed success"],
		});
		storage.completeRun(run.id, "passed");
		const layout = resolveProjectLayout(root);
		const db = new DatabaseSync(layout.stateDbPath);
		const store = createLearningStore(db);
		store.writeLearnings(run.id, [
			options.learning ?? {
				kind: "fact",
				scope: "session",
				title: "Repo uses receipt backed memory",
				body: "Durable facts must cite accepted Buildplane receipts.",
			},
		] as never);
		db.close();
		return { root, runId: run.id };
	}

	it("shows local help for receipt-backed memory promotion", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-promote-help-"),
		);
		const dependencies: RunCliDependencies = {
			runNativeCommand: async () => {
				throw new Error("memory promote help should not dispatch to native");
			},
		};

		const result = await runCliCapture(
			root,
			["memory", "promote", "--help"],
			dependencies,
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout.join("\n")).toContain(
			"buildplane memory promote --receipt <run-id> [--json]",
		);
		expect(result.stdout.join("\n")).toContain(
			"PASSED receipt-backed final verdict",
		);
	});

	it("promotes source-backed fact learnings only from accepted receipts", async () => {
		const { root, runId } = await createProjectWithReceiptBackedLearning({
			prefix: "buildplane-cli-memory-promote-pass-",
			runId: "run-cli-memory-promote-pass",
			withVerifierReceipt: true,
		});

		const result = await runCliCapture(root, [
			"memory",
			"promote",
			"--receipt",
			runId,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const report = JSON.parse(result.stdout.join("\n"));
		expect(report).toMatchObject({
			receiptId: runId,
			verdict: "PASSED",
			promoted: 1,
			skipped: 0,
		});
		expect(report.records).toEqual([
			expect.objectContaining({
				memoryType: "repo-fact",
				factKey: "Repo uses receipt backed memory",
				sourceRunId: runId,
				createdBy: "system",
			}),
		]);

		const facts = createBuildplaneStorage(root).listRepoFacts();
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({
			factKey: "Repo uses receipt backed memory",
			factValue: "Durable facts must cite accepted Buildplane receipts.",
			memoryType: "repo-fact",
			scopeType: "repo",
			provenance: expect.objectContaining({
				sourceRunId: runId,
				createdBy: "system",
				confidence: 1,
			}),
		});
	});

	it("fails closed when memory promotion lacks an accepted receipt", async () => {
		const { root, runId } = await createProjectWithReceiptBackedLearning({
			prefix: "buildplane-cli-memory-promote-blocked-",
			runId: "run-cli-memory-promote-blocked",
			withVerifierReceipt: false,
		});

		const result = await runCliCapture(root, [
			"memory",
			"promote",
			"--receipt",
			runId,
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		const report = JSON.parse(result.stdout.join("\n"));
		expect(report).toMatchObject({
			error: {
				code: "RECEIPT_NOT_ACCEPTED",
			},
			receipt: expect.objectContaining({
				runId,
				verdict: "BLOCKED",
			}),
		});
		expect(createBuildplaneStorage(root).listRepoFacts()).toHaveLength(0);
	});

	it("keeps receipt-backed memory promotion idempotent", async () => {
		const { root, runId } = await createProjectWithReceiptBackedLearning({
			prefix: "buildplane-cli-memory-promote-idempotent-",
			runId: "run-cli-memory-promote-idempotent",
			withVerifierReceipt: true,
		});

		const first = await runCliCapture(root, [
			"memory",
			"promote",
			"--receipt",
			runId,
			"--json",
		]);
		const second = await runCliCapture(root, [
			"memory",
			"promote",
			"--receipt",
			runId,
			"--json",
		]);

		expect(first.exitCode).toBe(0);
		expect(second.exitCode).toBe(0);
		const secondReport = JSON.parse(second.stdout.join("\n"));
		expect(secondReport).toMatchObject({
			receiptId: runId,
			verdict: "PASSED",
			promoted: 0,
			skipped: 1,
		});
		expect(createBuildplaneStorage(root).listRepoFacts()).toHaveLength(1);
	});

	it("skips receipt learning rows that changed after the accepted run", async () => {
		const { root, runId } = await createProjectWithReceiptBackedLearning({
			prefix: "buildplane-cli-memory-promote-mutated-",
			runId: "run-cli-memory-promote-mutated",
			withVerifierReceipt: true,
		});
		const layout = resolveProjectLayout(root);
		const db = new DatabaseSync(layout.stateDbPath);
		const store = createLearningStore(db);
		store.writeLearnings("run-after-receipt", [
			{
				kind: "fact",
				scope: "session",
				title: "Repo uses receipt backed memory",
				body: "Unverified later worker claim must not reuse the accepted run id.",
			},
		] as never);
		db.close();

		const result = await runCliCapture(root, [
			"memory",
			"promote",
			"--receipt",
			runId,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout.join("\n"));
		expect(report).toMatchObject({
			receiptId: runId,
			verdict: "PASSED",
			promoted: 0,
			skipped: 1,
		});
		expect(report.records[0]).toMatchObject({
			status: "skipped",
			reason: "learning changed after receipt capture",
		});
		expect(createBuildplaneStorage(root).listRepoFacts()).toHaveLength(0);
	});

	it("sanitizes promoted fact content idempotently before storage and human output", async () => {
		const neutralizedMention = "@\u200bhere";
		const escapedPipe = "\\|";
		const doubleEscapedPipe = "\\\\|";
		const { root, runId } = await createProjectWithReceiptBackedLearning({
			prefix: "buildplane-cli-memory-promote-sanitize-",
			runId: "run-cli-memory-promote-sanitize",
			withVerifierReceipt: true,
			learning: {
				kind: "fact",
				scope: "session",
				title: "Repo uses\n@here \u001b[31m | memory",
				body: "Durable facts\n@here \u001b[31m must stay | data with `ticks` <!--hidden-->.",
			},
		});

		const result = await runCliCapture(root, [
			"memory",
			"promote",
			"--receipt",
			runId,
		]);

		expect(result.exitCode).toBe(0);
		const humanOutput = result.stdout.join("\n");
		expect(humanOutput).not.toContain("\u001b");
		expect(humanOutput).not.toContain("@here");
		expect(humanOutput).toContain(neutralizedMention);
		expect(humanOutput).toContain(escapedPipe);
		expect(humanOutput).not.toContain(doubleEscapedPipe);

		const facts = createBuildplaneStorage(root).listRepoFacts();
		expect(facts).toHaveLength(1);
		expect(facts[0].factKey).not.toContain("\n");
		expect(facts[0].factKey).not.toContain("\u001b");
		expect(facts[0].factKey).not.toContain("@here");
		expect(facts[0].factKey).toContain(neutralizedMention);
		expect(facts[0].factKey).toContain(escapedPipe);
		expect(facts[0].factKey).not.toContain(doubleEscapedPipe);
		expect(facts[0].factValue).not.toContain("\n");
		expect(facts[0].factValue).not.toContain("\u001b");
		expect(facts[0].factValue).not.toContain("@here");
		expect(facts[0].factValue).not.toContain("`");
		expect(facts[0].factValue).not.toContain("<!--");
		expect(facts[0].factValue).not.toContain("-->");
		expect(facts[0].factValue).toContain(neutralizedMention);
		expect(facts[0].factValue).toContain(escapedPipe);
		expect(facts[0].factValue).not.toContain(doubleEscapedPipe);
	});

	it("skips conflicting repo facts from different provenance", async () => {
		const { root, runId } = await createProjectWithReceiptBackedLearning({
			prefix: "buildplane-cli-memory-promote-conflict-",
			runId: "run-cli-memory-promote-conflict",
			withVerifierReceipt: true,
		});
		createBuildplaneStorage(root).upsertRepoFact({
			factKey: "Repo uses receipt backed memory",
			factValue: "Existing operator-reviewed fact.",
			valueType: "string",
			scopeType: "repo",
			createdBy: "operator",
			sourceRunId: "operator-source",
		});

		const result = await runCliCapture(root, [
			"memory",
			"promote",
			"--receipt",
			runId,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout.join("\n"));
		expect(report).toMatchObject({ promoted: 0, skipped: 1 });
		expect(report.records[0]).toMatchObject({
			status: "skipped",
			reason: "active fact exists from different provenance",
		});
		const facts = createBuildplaneStorage(root).listRepoFacts();
		expect(facts).toHaveLength(1);
		expect(facts[0].factValue).toBe("Existing operator-reviewed fact.");
		expect(facts[0].provenance.sourceRunId).toBe("operator-source");
	});

	it("receipt-backed memory promotion rejects unsupported local arguments", async () => {
		const { root, runId } = await createProjectWithReceiptBackedLearning({
			prefix: "buildplane-cli-memory-promote-bad-args-",
			runId: "run-cli-memory-promote-bad-args",
			withVerifierReceipt: true,
		});
		const dependencies: RunCliDependencies = {
			runNativeCommand: async () => {
				throw new Error("receipt-like promote arguments must fail locally");
			},
		};

		const scopedCopy = await runCliCapture(
			root,
			["memory", "promote", "--receipt", runId, "--to", "user", "--json"],
			dependencies,
		);
		const duplicateReceipt = await runCliCapture(
			root,
			[
				"memory",
				"promote",
				"--receipt",
				runId,
				"--receipt",
				"run-cli-memory-promote-other",
				"--json",
			],
			dependencies,
		);
		const equalsReceipt = await runCliCapture(
			root,
			["memory", "promote", `--receipt=${runId}`, "--json"],
			dependencies,
		);

		for (const result of [scopedCopy, duplicateReceipt, equalsReceipt]) {
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toEqual([]);
			const report = JSON.parse(result.stdout.join("\n"));
			expect(report).toMatchObject({
				error: {
					code: "UNSUPPORTED_ARGUMENTS",
				},
			});
		}
		expect(JSON.parse(scopedCopy.stdout.join("\n")).error.message).toContain(
			"--to user",
		);
		expect(
			JSON.parse(duplicateReceipt.stdout.join("\n")).error.message,
		).toContain("--receipt");
		expect(JSON.parse(equalsReceipt.stdout.join("\n")).error.message).toContain(
			"--receipt=",
		);
		expect(createBuildplaneStorage(root).listRepoFacts()).toHaveLength(0);
	});

	it("native memory promote forms without receipt flags still dispatch to native", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-memory-promote-native-fallthrough-"),
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

		const bare = await runCliCapture(root, ["memory", "promote"], dependencies);
		const jsonOnly = await runCliCapture(
			root,
			["memory", "promote", "--json"],
			dependencies,
		);
		const scopedCopy = await runCliCapture(
			root,
			["memory", "promote", "mem_01HXYZ", "--to", "user"],
			dependencies,
		);

		expect(bare.exitCode).toBe(0);
		expect(jsonOnly.exitCode).toBe(0);
		expect(scopedCopy.exitCode).toBe(0);
		expect(calls).toEqual([
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["promote"],
			},
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["promote", "--json"],
			},
			{
				cwd: root,
				commandPath: ["memory"],
				argv: ["promote", "mem_01HXYZ", "--to", "user"],
			},
		]);
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

	it("reports receipt-backed final verdicts from verify --run --json", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-verify-pass-"));
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(createPassingPacket("unit-cli-verify-pass"), {
			runId: "run-cli-verify-pass",
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");

		const result = await runCliCapture(root, [
			"verify",
			"--run",
			run.id,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const report = JSON.parse(result.stdout.join("\n"));
		expect(report).toMatchObject({
			runId: run.id,
			verdict: "PASSED",
			receipts: { verifier: 2, approvals: 1, rejections: 0 },
		});
		expect(report.criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "required-output:tmp/pass.txt",
					status: "PASSED",
				}),
				expect.objectContaining({ id: "command-exit:0", status: "PASSED" }),
			]),
		);
	});

	it("fails closed from verify --run --json when acceptance evidence is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-verify-blocked-"));
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(
			createPassingPacket("unit-cli-verify-blocked"),
			{
				runId: "run-cli-verify-blocked",
			},
		);
		storage.markRunRunning(run.id);
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["worker claimed success"],
		});
		storage.completeRun(run.id, "passed");

		const result = await runCliCapture(root, [
			"verify",
			"--run",
			run.id,
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		const blockedReport = JSON.parse(result.stdout.join("\n"));
		expect(blockedReport).toMatchObject({
			runId: run.id,
			verdict: "BLOCKED",
		});
		expect(blockedReport.criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "required-output:tmp/pass.txt",
					status: "INSUFFICIENT_EVIDENCE",
				}),
				expect.objectContaining({
					id: "command-exit:0",
					status: "INSUFFICIENT_EVIDENCE",
				}),
			]),
		);
		expect(blockedReport.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "MISSING_VERIFIER_RECEIPT" }),
			]),
		);
	});

	it("surfaces architecture.diff_scope blockers from verify --run --json", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-verify-architecture-scope-"),
		);
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(
			createPassingPacket("unit-cli-verify-architecture-scope"),
			{
				runId: "run-cli-verify-architecture-scope",
			},
		);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('changed files')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "changed files: src/domain/runBundle.ts infra/prod.tf\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "architecture.diff_scope",
			outcome: "rejected",
			reasons: [
				"architecture.diff_scope blocked infra/prod.tf: path is outside allowed architecture scope src/**, tests/**.",
			],
		});
		storage.completeRun(run.id, "failed");

		const result = await runCliCapture(root, [
			"verify",
			"--run",
			run.id,
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		const report = JSON.parse(result.stdout.join("\n"));
		expect(report).toMatchObject({
			runId: run.id,
			verdict: "BLOCKED",
		});
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "UNRESOLVED_BLOCKER",
					message: expect.stringContaining(
						"architecture.diff_scope blocked infra/prod.tf",
					),
				}),
			]),
		);
	});

	it("exports Mission Control run bundles from evidence export", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-evidence-export-"));
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(
			createPassingPacket("unit-cli-evidence-export"),
			{
				runId: "run-cli-evidence-export",
			},
		);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");

		const outPath = join(root, ".buildplane", "exports", "run-bundle.json");
		const result = await runCliCapture(root, [
			"evidence",
			"export",
			"--run",
			run.id,
			"--out",
			outPath,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(result.stdout).toEqual([
			"evidence-export: wrote",
			`run-id: ${run.id}`,
			`out: ${outPath}`,
		]);
		const bundle = JSON.parse(readFileSync(outPath, "utf8"));
		expect(bundle).toMatchObject({
			kind: "run_bundle",
			schema_version: "1.0",
			run: { id: run.id, status: "passed", verdict: "passed" },
		});
		const workerEvent = bundle.events.find(
			(event: { kind: string; actor: { id: string } }) =>
				event.kind === "tool_call" && event.actor.id === "buildplane.runtime",
		);
		const verifierEvent = bundle.events.find(
			(event: { kind: string; actor: { id: string } }) =>
				event.kind === "assertion_check" &&
				event.actor.id === "buildplane.verifier",
		);
		expect(bundle.run.verified_criteria[0].evidence_event_id).toBe(
			verifierEvent.id,
		);
		expect(bundle.run.verified_criteria[0].evidence_event_id).not.toBe(
			workerEvent.id,
		);
	});

	it("prints exported run bundle JSON when evidence export uses --json", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-evidence-export-json-"),
		);
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(
			createPassingPacket("unit-cli-evidence-export-json"),
			{
				runId: "run-cli-evidence-export-json",
			},
		);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");

		const outPath = join(root, "bundle.json");
		const result = await runCliCapture(root, [
			"evidence",
			"export",
			"--run",
			run.id,
			"--out",
			outPath,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const printedBundle = JSON.parse(result.stdout.join("\n"));
		expect(printedBundle).toEqual(JSON.parse(readFileSync(outPath, "utf8")));
		expect(printedBundle.run.id).toBe(run.id);
	});

	it("returns stable json errors for evidence export argument failures", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-evidence-export-error-"),
		);
		await runCliCapture(root, ["init"]);

		const result = await runCliCapture(root, [
			"evidence",
			"export",
			"--run",
			"run-missing-out",
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: {
				code: "CLI_ERROR",
				message: "Missing required --out <path> argument.",
			},
		});
	});

	it("exports local OpenTelemetry-shaped traces from trace export", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-trace-export-"));
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(
			createPassingPacket("unit-cli-trace-export"),
			{
				runId: "run-cli-trace-export",
			},
		);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");

		const outPath = join(root, ".buildplane", "exports", "trace.json");
		const result = await runCliCapture(root, [
			"trace",
			"export",
			"--run",
			run.id,
			"--format",
			"otel-json",
			"--out",
			outPath,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const summary = JSON.parse(result.stdout.join("\n"));
		expect(summary).toMatchObject({
			format: "otel-json",
			runId: run.id,
			outPath,
			traceGrading: {
				schema: "buildplane.trace_grading.v0",
				runId: run.id,
			},
		});
		const trace = JSON.parse(readFileSync(outPath, "utf8"));
		const spans = trace.resourceSpans[0].scopeSpans[0].spans;
		expect(spans.map((span: { name: string }) => span.name)).toEqual(
			expect.arrayContaining([
				"buildplane.run",
				"buildplane.evidence.command-exit",
				"buildplane.policy.advance-run",
			]),
		);
		expect(spans[0].kind).toBe(1);
		expect(summary.spanCount).toBe(spans.length);
		expect(trace.traceGrading).toBeUndefined();
	});

	it("previews the exact GitHub check-run payload from pr-check dry-run", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pr-check-dry-run-"),
		);
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(createPassingPacket("unit-cli-pr-check"), {
			runId: "run-cli-pr-check-dry-run",
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");

		const result = await runCliCapture(root, [
			"pr-check",
			"dry-run",
			"--run",
			run.id,
			"--repo",
			"SollanSystems/buildplane",
			"--sha",
			"0123456789abcdef0123456789abcdef01234567",
			"--name",
			"Buildplane Evidence",
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const preview = JSON.parse(result.stdout.join("\n"));
		expect(preview).toMatchObject({
			mode: "dry-run",
			operation: {
				method: "POST",
				path: "/repos/SollanSystems/buildplane/check-runs",
				body: {
					name: "Buildplane Evidence",
					head_sha: "0123456789abcdef0123456789abcdef01234567",
					status: "completed",
					conclusion: "success",
					external_id: run.id,
				},
			},
			sideEffect: {
				capability: "github.pr_check",
				action: "publish",
				target: "repo:SollanSystems/buildplane",
			},
		});
	});

	it("fails closed before network when pr-check publish lacks a matching grant", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-pr-check-denied-"));
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(
			createPassingPacket("unit-cli-pr-check-denied"),
			{
				runId: "run-cli-pr-check-denied",
			},
		);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");
		const grantPath = join(root, "grants.json");
		writeFileSync(grantPath, JSON.stringify({ capabilityGrants: [] }), "utf8");
		const request = vi.fn();
		const originalEnv = process.env;
		const credentialReads: string[] = [];
		process.env = new Proxy(
			{ ...originalEnv, BUILDPLANE_TEST_CREDENTIAL: "cred" },
			{
				get(target, property, receiver) {
					if (property === "BUILDPLANE_TEST_CREDENTIAL") {
						credentialReads.push(String(property));
					}
					return Reflect.get(target, property, receiver);
				},
			},
		) as NodeJS.ProcessEnv;
		let result: Awaited<ReturnType<typeof runCliCapture>>;
		try {
			result = await runCliCapture(
				root,
				[
					"pr-check",
					"publish",
					"--run",
					run.id,
					"--repo",
					"SollanSystems/buildplane",
					"--sha",
					"0123456789abcdef0123456789abcdef01234567",
					"--grant-file",
					grantPath,
					"--grant-id",
					"grant-pr-check-publish",
					"--credential-env",
					"BUILDPLANE_TEST_CREDENTIAL",
					"--json",
				],
				{ publishPrCheckRequest: request },
			);
		} finally {
			process.env = originalEnv;
		}

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: { message: expect.stringContaining("UNSAFE_TO_RUN") },
		});
		expect(request).not.toHaveBeenCalled();
		expect(credentialReads).toEqual([]);
	});

	it("publishes pr-check only after a matching grant and credential are present", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pr-check-publish-"),
		);
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(
			createPassingPacket("unit-cli-pr-check-publish"),
			{
				runId: "run-cli-pr-check-publish",
			},
		);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");
		const grantPath = join(root, "grants.json");
		writeFileSync(
			grantPath,
			JSON.stringify({
				capabilityGrants: [
					{
						id: "grant-pr-check-publish",
						capability: "github.pr_check",
						actions: ["publish"],
						targets: ["repo:SollanSystems/buildplane"],
					},
				],
			}),
			"utf8",
		);
		vi.stubEnv("BUILDPLANE_TEST_CREDENTIAL", "cred");
		const request = vi.fn().mockResolvedValue({ status: 201, ok: true });

		const result = await runCliCapture(
			root,
			[
				"pr-check",
				"publish",
				"--run",
				run.id,
				"--repo",
				"SollanSystems/buildplane",
				"--sha",
				"0123456789abcdef0123456789abcdef01234567",
				"--grant-file",
				grantPath,
				"--grant-id",
				"grant-pr-check-publish",
				"--credential-env",
				"BUILDPLANE_TEST_CREDENTIAL",
				"--json",
			],
			{ publishPrCheckRequest: request },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const published = JSON.parse(result.stdout.join("\n"));
		expect(published).toMatchObject({
			mode: "published",
			grantId: "grant-pr-check-publish",
			sideEffect: {
				grantId: "grant-pr-check-publish",
				capability: "github.pr_check",
				action: "publish",
				target: "repo:SollanSystems/buildplane",
			},
			response: { status: 201, ok: true },
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/repos/SollanSystems/buildplane/check-runs",
			}),
			{ credential: "cred" },
		);
	});

	it("previews a compact PR evidence comment from pr-comment dry-run", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pr-comment-dry-run-"),
		);
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(createPassingPacket("unit-cli-pr-comment"), {
			runId: "run-cli-pr-comment-dry-run",
		});
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");

		const result = await runCliCapture(root, [
			"pr-comment",
			"dry-run",
			"--run",
			run.id,
			"--repo",
			"SollanSystems/buildplane",
			"--pr",
			"42",
			"--sha",
			"0123456789abcdef0123456789abcdef01234567",
			"--details-url",
			"https://mission-control.example/runs/run-cli-pr-comment-dry-run",
			"--bundle-url",
			"https://artifacts.example/run-cli-pr-comment-dry-run.json",
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		const preview = JSON.parse(result.stdout.join("\n"));
		expect(preview).toMatchObject({
			mode: "dry-run",
			preflight: {
				method: "GET",
				path: "/repos/SollanSystems/buildplane/pulls/42",
			},
			operation: {
				method: "POST",
				path: "/repos/SollanSystems/buildplane/issues/42/comments",
			},
			sideEffect: {
				capability: "github.pr_comment",
				action: "publish",
				target: "repo:SollanSystems/buildplane#pr:42",
				metadata: {
					headSha: "0123456789abcdef0123456789abcdef01234567",
					prNumber: 42,
				},
			},
		});
		expect(preview.operation.body.body).toContain(
			"<!-- buildplane:pr-evidence run=run-cli-pr-comment-dry-run sha=0123456789abcdef0123456789abcdef01234567 pr=42 -->",
		);
		expect(preview.operation.body.body).toContain("| Final verdict | PASSED |");
		expect(preview.operation.body.body).toContain("| Pull request | #42 |");
		expect(preview.operation.body.body).toContain(
			"| Head SHA | `0123456789abcdef0123456789abcdef01234567` |",
		);
		expect(preview.operation.body.body).toContain(
			"| Pass authority | verifier receipts only; worker claims are not authoritative |",
		);
		expect(preview.operation.body.body).toContain(
			"| Evidence bundle | https://artifacts.example/run-cli-pr-comment-dry-run.json |",
		);
	});

	it("rejects non-canonical PR numbers before loading evidence", async () => {
		for (const prNumber of ["1e2", "0x2a", "042"]) {
			const root = mkdtempSync(
				join(tmpdir(), "buildplane-cli-pr-comment-bad-pr-"),
			);
			await runCliCapture(root, ["init"]);
			const result = await runCliCapture(root, [
				"pr-comment",
				"dry-run",
				"--run",
				"run-cli-pr-comment-bad-pr",
				"--repo",
				"SollanSystems/buildplane",
				"--pr",
				prNumber,
				"--sha",
				"0123456789abcdef0123456789abcdef01234567",
				"--json",
			]);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toEqual([]);
			expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
				error: {
					message: expect.stringContaining(
						"PR number must be a positive decimal integer",
					),
				},
			});
		}
	});

	it("fails closed before network when pr-comment publish lacks a matching grant", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-pr-comment-denied-"),
		);
		await runCliCapture(root, ["init"]);
		const storage = createBuildplaneStorage(root);
		const run = storage.createRun(
			createPassingPacket("unit-cli-pr-comment-denied"),
			{
				runId: "run-cli-pr-comment-denied",
			},
		);
		storage.markRunRunning(run.id);
		storage.recordExecutionEvidence(run.id, {
			command: "node",
			args: ["-e", "console.log('worker claim')"],
			cwd: root,
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.000Z",
			exitCode: 0,
			stdout: "worker claim\n",
			stderr: "",
			outputChecks: [{ path: "tmp/pass.txt", exists: true }],
		});
		storage.recordDecision(run.id, {
			kind: "advance-run",
			outcome: "approved",
			reasons: ["required output exists"],
		});
		storage.completeRun(run.id, "passed");
		const grantPath = join(root, "grants.json");
		writeFileSync(grantPath, JSON.stringify({ capabilityGrants: [] }), "utf8");
		const request = vi.fn();
		const originalEnv = process.env;
		const credentialReads: string[] = [];
		process.env = new Proxy(
			{ ...originalEnv, BUILDPLANE_TEST_CREDENTIAL: "cred" },
			{
				get(target, property, receiver) {
					if (property === "BUILDPLANE_TEST_CREDENTIAL") {
						credentialReads.push(String(property));
					}
					return Reflect.get(target, property, receiver);
				},
			},
		) as NodeJS.ProcessEnv;
		let result: Awaited<ReturnType<typeof runCliCapture>>;
		try {
			result = await runCliCapture(
				root,
				[
					"pr-comment",
					"publish",
					"--run",
					run.id,
					"--repo",
					"SollanSystems/buildplane",
					"--pr",
					"42",
					"--sha",
					"0123456789abcdef0123456789abcdef01234567",
					"--grant-file",
					grantPath,
					"--grant-id",
					"grant-pr-comment-publish",
					"--credential-env",
					"BUILDPLANE_TEST_CREDENTIAL",
					"--json",
				],
				{ publishPrCommentRequest: request },
			);
		} finally {
			process.env = originalEnv;
		}

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: { message: expect.stringContaining("UNSAFE_TO_RUN") },
		});
		expect(request).not.toHaveBeenCalled();
		expect(credentialReads).toEqual([]);
	});

	it("memory facts lists repo.* facts as json and human output", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-facts-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		storage.upsertRepoFact({
			factKey: "repo.test-runner",
			factValue: "vitest --run",
			valueType: "string",
			scopeType: "repo",
			createdBy: "system",
		});

		const jsonResult = await runCliCapture(root, ["memory", "facts", "--json"]);
		expect(jsonResult.exitCode).toBe(0);
		const facts = JSON.parse(jsonResult.stdout.join("\n"));
		expect(
			facts.some((f: { factKey: string }) => f.factKey === "repo.test-runner"),
		).toBe(true);

		const humanResult = await runCliCapture(root, ["memory", "facts"]);
		expect(humanResult.stdout.join("\n")).toContain("repo.test-runner");
		expect(humanResult.stdout.join("\n")).toContain("vitest --run");
	});

	it("memory facts on an uninitialized project prints the empty state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-facts-empty-"));
		const result = await runCliCapture(root, ["memory", "facts"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.join("\n")).toContain("No repo facts found.");
	});

	it("memory procedures lists procedures filtered by --task-type", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-procs-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		storage.createProcedure({
			name: "How to review a PR",
			taskType: "review",
			bodyMarkdown: "1. read the diff",
			createdBy: "system",
		});

		const jsonResult = await runCliCapture(root, [
			"memory",
			"procedures",
			"--task-type",
			"review",
			"--json",
		]);
		expect(jsonResult.exitCode).toBe(0);
		const procs = JSON.parse(jsonResult.stdout.join("\n"));
		expect(
			procs.some((p: { name: string }) => p.name === "How to review a PR"),
		).toBe(true);

		const humanResult = await runCliCapture(root, ["memory", "procedures"]);
		expect(humanResult.stdout.join("\n")).toContain("How to review a PR");
	});

	it("memory facts surfaces a real storage error with a non-zero exit", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-facts-corrupt-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const layout = resolveProjectLayout(root);
		writeFileSync(layout.stateDbPath, "not a sqlite database");

		const result = await runCliCapture(root, ["memory", "facts", "--json"]);
		expect(result.exitCode).toBe(1);
		const error = JSON.parse(result.stdout.join("\n"));
		expect(error).toMatchObject({ error: { message: expect.any(String) } });
	});

	it("memory procedures surfaces a real storage error with a non-zero exit", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-procs-corrupt-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const layout = resolveProjectLayout(root);
		writeFileSync(layout.stateDbPath, "not a sqlite database");

		const result = await runCliCapture(root, [
			"memory",
			"procedures",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		const error = JSON.parse(result.stdout.join("\n"));
		expect(error).toMatchObject({ error: { message: expect.any(String) } });
	});

	it("memory procedures on an uninitialized project prints the empty state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-procs-empty-"));
		const result = await runCliCapture(root, ["memory", "procedures"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.join("\n")).toContain("No procedures found.");
	});

	it("memory facts rejects --scope without a value", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-facts-scope-"));
		const result = await runCliCapture(root, [
			"memory",
			"facts",
			"--scope",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: { message: expect.stringContaining("--scope") },
		});
	});

	it("memory facts rejects unsupported flags", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "buildplane-cli-facts-unsupported-"),
		);
		const result = await runCliCapture(root, [
			"memory",
			"facts",
			"--bogus",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: { message: expect.stringContaining("--bogus") },
		});
	});

	it("memory procedures rejects --task-type without a value", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-procs-task-"));
		const result = await runCliCapture(root, [
			"memory",
			"procedures",
			"--task-type",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: { message: expect.stringContaining("--task-type") },
		});
	});

	it("memory episodes lists a run's events as json and human output", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-episodes-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const eventStore = createEventStore(root);
		eventStore.persistEvent("run-x", {
			kind: "run-created",
			runId: "run-x",
			unitId: "unit-x",
			status: "pending",
			timestamp: "2026-03-17T00:00:00.000Z",
		});
		eventStore.persistEvent("run-x", {
			kind: "run-started",
			runId: "run-x",
			unitId: "unit-x",
			status: "running",
			timestamp: "2026-03-17T00:00:01.000Z",
		});

		const jsonResult = await runCliCapture(root, [
			"memory",
			"episodes",
			"run-x",
			"--json",
		]);
		expect(jsonResult.exitCode).toBe(0);
		const events = JSON.parse(jsonResult.stdout.join("\n"));
		expect(events.map((e: { kind: string }) => e.kind)).toEqual([
			"run-created",
			"run-started",
		]);

		const humanResult = await runCliCapture(root, [
			"memory",
			"episodes",
			"run-x",
		]);
		expect(humanResult.exitCode).toBe(0);
		expect(humanResult.stdout.join("\n")).toContain("run-created");
		expect(humanResult.stdout.join("\n")).toContain("run-started");
	});

	it("memory episodes caps the output with --limit", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-episodes-limit-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();
		const eventStore = createEventStore(root);
		for (let i = 0; i < 3; i++) {
			eventStore.persistEvent("run-x", {
				kind: "model-token-delta",
				runId: "run-x",
				delta: `t${i}`,
				timestamp: `2026-03-17T00:00:0${i}.000Z`,
			});
		}

		const result = await runCliCapture(root, [
			"memory",
			"episodes",
			"run-x",
			"--limit",
			"1",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		const events = JSON.parse(result.stdout.join("\n"));
		expect(events).toHaveLength(1);
		expect(events[0].timestamp).toBe("2026-03-17T00:00:02.000Z");
	});

	it("memory episodes requires a runId argument", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-episodes-norun-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const result = await runCliCapture(root, ["memory", "episodes", "--json"]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout.join("\n"))).toMatchObject({
			error: { message: expect.stringContaining("runId") },
		});
	});

	it("memory episodes on a run with no events prints the empty state", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-cli-episodes-empty-"));
		const storage = createBuildplaneStorage(root);
		storage.initializeProject();

		const result = await runCliCapture(root, ["memory", "episodes", "run-x"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.join("\n")).toContain("No events found.");
	});
});

describe("planforge dry-run", () => {
	const fixtureRoot = join(
		dirname(fileURLToPath(import.meta.url)),
		"fixtures/planforge",
	);
	const inputFixture = join(fixtureRoot, "goal-input.md");
	const expectedFixture = join(fixtureRoot, "expected-plan.json");

	it("planforge emits the expected stable dry-run plan fixture without project writes", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-"));
		const result = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			inputFixture,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toEqual([]);
		expect(JSON.parse(result.stdout.join("\n"))).toEqual(
			JSON.parse(readFileSync(expectedFixture, "utf8")),
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("planforge computes the receipt plan digest from the review artifact", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-"));
		const result = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			inputFixture,
			"--json",
		]);

		expect(result.exitCode).toBe(0);
		const payload = JSON.parse(result.stdout.join("\n"));
		const { receiptPreview: _receiptPreview, ...reviewArtifact } = payload;
		const expectedDigest = digest(reviewArtifact);

		expect(payload.receiptPreview.planDigest).toBe(expectedDigest);
		expect(payload.receiptPreview.planDigest).not.toBe(
			"sha256:fixture-plan-digest-placeholder",
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("planforge fails closed when required evidence is missing", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-"));
		const invalidInput = join(root, "missing-evidence.md");
		writeFileSync(
			invalidInput,
			[
				"# Bad PlanForge input",
				"",
				"## Goal",
				"Create a local dry-run plan.",
				"",
			].join("\n"),
			"utf8",
		);

		const result = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			invalidInput,
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toEqual([]);
		const payload = JSON.parse(result.stdout.join("\n"));
		expect(payload.validation.status).toBe("INSUFFICIENT_EVIDENCE");
		expect(payload.validation.missingEvidence).toEqual([
			"repository_remote",
			"trusted_base",
			"dry_run_constraints",
			"trusted_boundary",
			"worktree_policy",
			"tasks",
		]);
		expect(payload.validation.requiredEvidence).toContain("trusted_boundary");
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("planforge derives identifiers from input evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-"));
		const copiedInput = join(root, "copied-goal.md");
		writeFileSync(copiedInput, readFileSync(inputFixture, "utf8"), "utf8");
		const alternateInput = join(root, "alternate-goal.md");
		writeFileSync(
			alternateInput,
			[
				"# Alternate PlanForge input",
				"",
				"## Goal",
				"Create a different dry-run plan artifact.",
				"",
				"## Repository context",
				"",
				"- Remote: https://github.com/SollanSystems/buildplane.git",
				"- Trusted base: 15dbb32db0e1f0024687533755805fc23f3ef6d4",
				"- Worktree policy: isolated-worktree-required",
				"",
				"## Safety constraints",
				"",
				"- Dry-run only.",
				"- Buildplane kernel validates and admits plans.",
				"- Coding agents are untrusted workers.",
				"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
				"",
				"## Tasks",
				"",
				"### A1: Alternate task",
				"",
				"- Objective: Produce the alternate dry-run plan artifact.",
				"- Assignee-hint: auto-coder",
				"- Workspace: isolated-worktree",
				"- Allowed-side-effects: local-doc",
				"- Forbidden-side-effects: execute-code",
				"- Depends-on:",
				"- Acceptance-criteria:",
				"  - Alternate artifact is produced.",
				"- Verification-commands:",
				"  - pnpm lint",
				"",
			].join("\n"),
			"utf8",
		);

		const missingTrustedBoundaryInput = join(root, "goal-input.md");
		writeFileSync(
			missingTrustedBoundaryInput,
			readFileSync(inputFixture, "utf8")
				.replace(/- Buildplane kernel validates and admits plans.\r?\n/, "")
				.replace(/- Coding agents are untrusted workers.\r?\n/, ""),
			"utf8",
		);

		const fixtureResult = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			inputFixture,
			"--json",
		]);
		const copiedResult = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			copiedInput,
			"--json",
		]);
		const alternateResult = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			alternateInput,
			"--json",
		]);
		const missingTrustedBoundaryResult = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			missingTrustedBoundaryInput,
			"--json",
		]);

		const fixturePayload = JSON.parse(fixtureResult.stdout.join("\n"));
		const copiedPayload = JSON.parse(copiedResult.stdout.join("\n"));
		const alternatePayload = JSON.parse(alternateResult.stdout.join("\n"));
		const missingTrustedBoundaryPayload = JSON.parse(
			missingTrustedBoundaryResult.stdout.join("\n"),
		);
		expect(copiedPayload.validation.status).toBe("PASS");
		expect(copiedPayload.receiptPreview.inputDigest).toBe(
			fixturePayload.receiptPreview.inputDigest,
		);
		expect(copiedPayload.idempotencyKey).not.toBe(
			fixturePayload.idempotencyKey,
		);
		expect(copiedPayload.receiptPreview.idempotencyKey).toBe(
			copiedPayload.idempotencyKey,
		);
		expect(alternatePayload.validation.status).toBe("PASS");
		expect(alternatePayload.goal).toBe(
			"Create a different dry-run plan artifact.",
		);
		expect(alternatePayload.id).not.toBe(fixturePayload.id);
		expect(alternatePayload.idempotencyKey).not.toBe(
			fixturePayload.idempotencyKey,
		);
		expect(missingTrustedBoundaryResult.exitCode).toBe(1);
		expect(missingTrustedBoundaryPayload.validation.status).toBe(
			"INSUFFICIENT_EVIDENCE",
		);
		expect(missingTrustedBoundaryPayload.validation.missingEvidence).toEqual([
			"trusted_boundary",
		]);
		expect(missingTrustedBoundaryPayload.id).not.toBe(fixturePayload.id);
		expect(missingTrustedBoundaryPayload.idempotencyKey).not.toBe(
			fixturePayload.idempotencyKey,
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});

	it("planforge requires evidence in the intended sections and rejects forbidden goal intents", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-"));
		const misplacedEvidenceInput = join(root, "misplaced-evidence.md");
		writeFileSync(
			misplacedEvidenceInput,
			[
				"# Misplaced PlanForge input",
				"",
				"## Goal",
				"Create a local dry-run plan artifact.",
				"",
				"## Notes",
				"",
				"- Remote: https://github.com/SollanSystems/buildplane.git",
				"- Trusted base: 15dbb32db0e1f0024687533755805fc23f3ef6d4",
				"- Worktree policy: isolated-worktree-required",
				"- Dry-run only.",
				"- Buildplane kernel validates and admits plans.",
				"- Coding agents are untrusted workers.",
				"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
				"",
			].join("\n"),
			"utf8",
		);
		const safeNegatedInput = join(root, "safe-negated-goal.md");
		writeFileSync(
			safeNegatedInput,
			[
				"# Safe negated PlanForge input",
				"",
				"## Goal",
				"Create a local dry-run plan artifact that does not execute code and does not use GitHub.",
				"",
				"## Repository context",
				"",
				"- Remote: https://github.com/SollanSystems/buildplane.git",
				"- Trusted base: 15dbb32db0e1f0024687533755805fc23f3ef6d4",
				"- Worktree policy: isolated-worktree-required",
				"",
				"## Safety constraints",
				"",
				"- Dry-run only.",
				"- Buildplane kernel validates and admits plans.",
				"- Coding agents are untrusted workers.",
				"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
				"",
				"## Tasks",
				"",
				"### S1: Safe negated task",
				"",
				"- Objective: Produce the safe negated dry-run plan artifact.",
				"- Assignee-hint: auto-coder",
				"- Workspace: isolated-worktree",
				"- Allowed-side-effects: local-doc",
				"- Forbidden-side-effects: execute-code",
				"- Depends-on:",
				"- Acceptance-criteria:",
				"  - Safe negated artifact is produced.",
				"- Verification-commands:",
				"  - pnpm lint",
				"",
			].join("\n"),
			"utf8",
		);
		const unsafeInput = join(root, "unsafe-goal.md");
		writeFileSync(
			unsafeInput,
			[
				"# Unsafe PlanForge input",
				"",
				"## Goal",
				"Run commands locally, open pull requests, and perform network writes for a dry-run plan artifact.",
				"",
				"## Repository context",
				"",
				"- Remote: https://github.com/SollanSystems/buildplane.git",
				"- Trusted base: 15dbb32db0e1f0024687533755805fc23f3ef6d4",
				"- Worktree policy: isolated-worktree-required",
				"",
				"## Safety constraints",
				"",
				"- Dry-run only.",
				"- Buildplane kernel validates and admits plans.",
				"- Coding agents are untrusted workers.",
				"- No Kanban, GSD2, GitHub, network, push, PR, deploy, merge, or worker-spawn side effects.",
				"",
			].join("\n"),
			"utf8",
		);

		const misplacedResult = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			misplacedEvidenceInput,
			"--json",
		]);
		const safeNegatedResult = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			safeNegatedInput,
			"--json",
		]);
		const unsafeResult = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			unsafeInput,
			"--json",
		]);

		const misplacedPayload = JSON.parse(misplacedResult.stdout.join("\n"));
		const safeNegatedPayload = JSON.parse(safeNegatedResult.stdout.join("\n"));
		const unsafePayload = JSON.parse(unsafeResult.stdout.join("\n"));
		expect(misplacedResult.exitCode).toBe(1);
		expect(misplacedPayload.validation.status).toBe("INSUFFICIENT_EVIDENCE");
		expect(misplacedPayload.validation.missingEvidence).toEqual([
			"repository_remote",
			"trusted_base",
			"dry_run_constraints",
			"trusted_boundary",
			"worktree_policy",
			"tasks",
		]);
		expect(
			misplacedPayload.validation.checks.find(
				(check: { id: string }) => check.id === "dry-run-only",
			)?.status,
		).toBe("INSUFFICIENT_EVIDENCE");
		expect(safeNegatedResult.exitCode).toBe(0);
		expect(safeNegatedPayload.validation.status).toBe("PASS");
		expect(
			safeNegatedPayload.validation.checks.flatMap(
				(check: { evidenceRefs: string[] }) => check.evidenceRefs,
			),
		).toContain("safe-negated-goal.md#safety-constraints");
		expect(unsafeResult.exitCode).toBe(1);
		expect(unsafePayload.validation.status).toBe("UNSAFE_TO_RUN");
		expect(unsafePayload.validation.unsafeReasons).toEqual([
			"goal requests a forbidden side effect",
		]);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});
	it("planforge rejects missing input, unsupported non-dry-run, and write forms before side effects", async () => {
		const root = mkdtempSync(join(tmpdir(), "buildplane-planforge-"));
		const missingInput = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--json",
		]);
		const nonDryRun = await runCliCapture(root, [
			"planforge",
			"frobnicate",
			"--json",
		]);
		const writeForm = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			inputFixture,
			"--json",
			"--write",
		]);
		const writeEqualsForm = await runCliCapture(root, [
			"planforge",
			"dry-run",
			"--input",
			inputFixture,
			"--json",
			"--write=receipt.json",
		]);

		expect(missingInput.exitCode).toBe(1);
		expect(nonDryRun.exitCode).toBe(1);
		expect(writeForm.exitCode).toBe(1);
		expect(writeEqualsForm.exitCode).toBe(1);
		expect(missingInput.stdout.join("\n")).toContain(
			"Missing required --input",
		);
		expect(nonDryRun.stdout.join("\n")).toContain(
			"Only dry-run, admit, dispatch, and resume are available",
		);
		expect(writeForm.stdout.join("\n")).toContain(
			"side-effect forms are disabled",
		);
		expect(writeEqualsForm.stdout.join("\n")).toContain(
			"side-effect forms are disabled",
		);
		expect(existsSync(join(root, ".buildplane"))).toBe(false);
	});
});
