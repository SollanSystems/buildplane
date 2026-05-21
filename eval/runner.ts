import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type Condition,
	type ConditionResult,
	computeAggregates,
	type EvalReport,
	type FixtureResult,
	formatEvalReport,
} from "./report.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve @buildplane/* packages from the CLI package directory (where they are installed)
const CLI_DIR = join(__dirname, "..", "apps", "cli");
function cliImport(pkg: string): Promise<unknown> {
	// Resolve the package entrypoint relative to apps/cli
	// We use a dynamic URL path trick: create a fake file in CLI_DIR so Node
	// resolves imports from there.
	const resolvedPath = join(CLI_DIR, "node_modules", pkg, "package.json");
	const pkgJson = JSON.parse(readFileSync(resolvedPath, "utf8")) as {
		main?: string;
		exports?: Record<string, unknown>;
	};

	// Prefer exports["."] or main
	let entrypoint: string;
	if (
		pkgJson.exports &&
		typeof pkgJson.exports === "object" &&
		"." in pkgJson.exports
	) {
		const dot = (pkgJson.exports as Record<string, unknown>)["."];
		if (typeof dot === "string") {
			entrypoint = dot;
		} else if (dot && typeof dot === "object") {
			const dotExp = dot as Record<string, unknown>;
			const resolved = dotExp.import ?? dotExp.default ?? dotExp.require;
			entrypoint = String(resolved);
		} else {
			entrypoint = pkgJson.main ?? "index.js";
		}
	} else {
		entrypoint = pkgJson.main ?? "index.js";
	}

	const pkgDir = join(CLI_DIR, "node_modules", pkg);
	const fullPath = join(pkgDir, entrypoint);
	return import(pathToFileURL(fullPath).href);
}

// ── Git environment isolation ──────────────────────────────────
const DEFAULT_GIT_IDENTITY = Object.freeze({
	name: "Buildplane",
	email: "buildplane@local",
});

function cleanGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}
	env.GIT_AUTHOR_NAME ??= DEFAULT_GIT_IDENTITY.name;
	env.GIT_AUTHOR_EMAIL ??= DEFAULT_GIT_IDENTITY.email;
	env.GIT_COMMITTER_NAME ??= DEFAULT_GIT_IDENTITY.name;
	env.GIT_COMMITTER_EMAIL ??= DEFAULT_GIT_IDENTITY.email;
	return env;
}

// ── CLI arg parsing ────────────────────────────────────────────
function parseArgs(): { suite: string; json: boolean } {
	const args = process.argv.slice(2);
	let suite = "local";
	let json = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--suite" && args[i + 1]) {
			suite = args[i + 1];
			i++;
		} else if (args[i] === "--json") {
			json = true;
		}
	}

	return { suite, json };
}

// ── Fixture discovery ──────────────────────────────────────────
interface FixtureMeta {
	name: string;
	description: string;
	rawApprovalMode?: "reviewer-must-approve";
	rawApprovalOutputPath?: string;
	rawApprovalMustContain?: string;
}

interface Fixture {
	dir: string;
	meta: FixtureMeta;
	run1: unknown;
	run2: unknown;
}

function discoverFixtures(suiteDir: string): Fixture[] {
	const entries = readdirSync(suiteDir);
	const fixtures: Fixture[] = [];

	for (const entry of entries) {
		const entryPath = join(suiteDir, entry);
		try {
			const stat = statSync(entryPath);
			if (!stat.isDirectory()) continue;
		} catch {
			continue;
		}

		const metaPath = join(entryPath, "meta.json");
		try {
			statSync(metaPath);
		} catch {
			// No meta.json — skip
			continue;
		}

		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as FixtureMeta;
		const run1 = JSON.parse(
			readFileSync(join(entryPath, "run-1.json"), "utf8"),
		);
		const run2 = JSON.parse(
			readFileSync(join(entryPath, "run-2.json"), "utf8"),
		);

		fixtures.push({ dir: entryPath, meta, run1, run2 });
	}

	return fixtures;
}

// ── Bootstrap a fresh temp project ────────────────────────────
async function bootstrapProject(
	kernel: KernelModule,
	storage: StorageModule,
	runtimePort: RuntimePortLike,
	policy: PolicyModule,
	adaptersGit: AdaptersGitModule,
): Promise<{
	demoDir: string;
	orchestrator: OrchestratorLike;
	readMemoryPort: MemoryPortLike;
	writeMemoryPort: MemoryPortLike;
}> {
	const demoDir = mkdtempSync(join(tmpdir(), "bp-eval-"));
	const gitEnv = cleanGitEnv();
	const gitOpts = { cwd: demoDir, env: gitEnv, encoding: "utf8" as const };

	execFileSync("git", ["init", "-b", "main"], gitOpts);
	writeFileSync(join(demoDir, ".gitkeep"), "");
	execFileSync("git", ["add", "."], gitOpts);
	execFileSync("git", ["commit", "-m", "init"], gitOpts);

	const baseOpts = {
		projectRoot: demoDir,
		storage: storage.createBuildplaneStorage(demoDir),
		runtime: runtimePort,
		policy: { evaluateRun: policy.evaluateRun },
		workspace: adaptersGit.createGitWorktreeAdapter(),
	};

	const initOrch = kernel.createBuildplaneOrchestrator(baseOpts);
	initOrch.initializeProject();

	const layout = storage.resolveProjectLayout(demoDir);
	const readDb = new DatabaseSync(layout.stateDbPath, { readOnly: true });
	const writeDb = new DatabaseSync(layout.stateDbPath);
	const readMemoryPort = storage.createLearningStore(readDb);
	const writeMemoryPort = storage.createLearningStore(writeDb);

	const orchestrator = kernel.createBuildplaneOrchestrator({
		...baseOpts,
		memoryPort: writeMemoryPort,
	});

	return { demoDir, orchestrator, readMemoryPort, writeMemoryPort };
}

// ── Type aliases for dynamic imports ──────────────────────────
type OrchestratorLike = {
	initializeProject: () => { created: boolean; projectRoot: string };
	runPacket: (packet: unknown) => {
		run: { id: string; status: string };
		receipt: unknown;
		decision?: { outcome: string; reasons: string[] };
	};
	runPacketAsync: (
		packet: unknown,
		eventBus?: unknown,
	) => Promise<{
		run: { id: string; status: string };
		receipt: unknown;
		decision?: { outcome: string; reasons: string[] };
	}>;
	runStrategy: (
		strategy: unknown,
		eventBus?: unknown,
	) => Promise<{
		outcome: "passed" | "failed" | "mixed";
		rounds?: ReadonlyArray<unknown>;
		mergeDecision: { policy: string; outcome: string; reasons: string[] };
		strategyId: string;
	}>;
};

type MemoryPortLike = {
	fetchLearnings: (opts?: { limit?: number }) => ReadonlyArray<{
		kind: string;
		title: string;
		body: string;
	}>;
	writeLearnings: (runId: string, learnings: readonly unknown[]) => void;
};

type KernelModule = {
	createBuildplaneOrchestrator: (
		opts: Record<string, unknown>,
	) => OrchestratorLike;
	createEventBus: () => unknown;
};

type StorageModule = {
	createBuildplaneStorage: (root: string) => unknown;
	resolveProjectLayout: (root: string) => { stateDbPath: string };
	createLearningStore: (db: unknown) => MemoryPortLike;
};

type RuntimeModule = {
	executePacket: (packet: unknown, root: string) => unknown;
};

type RuntimePortLike = {
	executePacket: (packet: unknown, root: string) => unknown;
	executePacketAsync: (
		packet: unknown,
		root: string,
		eventBus: unknown,
	) => Promise<unknown>;
};

type TaskRendererLike = {
	render: (
		intent: unknown,
		role: "implementer" | "reviewer",
	) => { system?: string; prompt: string };
};

type PolicyModule = {
	evaluateRun: (...args: unknown[]) => unknown;
};

type AdaptersGitModule = {
	createGitWorktreeAdapter: () => unknown;
};

type AdaptersModelsModule = {
	createCodexRenderer: () => unknown;
};

type AdaptersCodexModule = {
	createCodexExecutor: (options?: {
		renderer?: unknown;
		cliBinary?: string;
	}) => {
		executePacket: (packet: unknown, root: string) => unknown;
		executePacketAsync: (
			packet: unknown,
			root: string,
			eventBus: unknown,
		) => Promise<unknown>;
	};
};

type EnrichFn = (
	packet: unknown,
	memoryPort: MemoryPortLike | undefined,
	honchoAdapter: undefined,
	userId: undefined,
) => Promise<unknown>;

type WrapAsStrategyFn = (packet: unknown) => unknown;

// ── Run a single condition ─────────────────────────────────────
async function runCondition(
	condition: Condition,
	fixtureMeta: FixtureMeta,
	rawRun1Packet: unknown,
	rawRun2Packet: unknown,
	kernel: KernelModule,
	storage: StorageModule,
	runtimePort: RuntimePortLike,
	policy: PolicyModule,
	adaptersGit: AdaptersGitModule,
	enrichPacketWithMemories: EnrichFn,
	wrapAsStrategy: WrapAsStrategyFn,
): Promise<ConditionResult> {
	const useMemory = condition.startsWith("memory+");
	const useStrategy = condition.endsWith("+strategy");

	const { demoDir, orchestrator, readMemoryPort } = await bootstrapProject(
		kernel,
		storage,
		runtimePort,
		policy,
		adaptersGit,
	);

	// Run-1 always with full memory (seeds learnings)
	orchestrator.runPacket(rawRun1Packet);

	// Count learnings after run-1
	const learningsWritten = readMemoryPort.fetchLearnings({ limit: 100 }).length;

	// Run-2 under condition
	const start = Date.now();
	let run2Packet = rawRun2Packet;
	let memoriesInjected = 0;

	if (useMemory) {
		const enriched = await enrichPacketWithMemories(
			run2Packet,
			readMemoryPort,
			undefined,
			undefined,
		);
		const memories =
			(enriched as { intent?: { context?: { memories?: string[] } } }).intent
				?.context?.memories ?? [];
		memoriesInjected = memories.length;
		run2Packet = enriched;
	}

	let passed = false;
	let rounds = 0;

	if (useStrategy) {
		const strategy = wrapAsStrategy(run2Packet);
		const eventBus = kernel.createEventBus();
		const result = await orchestrator.runStrategy(strategy, eventBus);
		passed = result.outcome === "passed";
		rounds = result.rounds?.length ?? 1;
	} else if ((run2Packet as { model?: unknown }).model) {
		const eventBus = kernel.createEventBus();
		const result = await orchestrator.runPacketAsync(run2Packet, eventBus);
		passed = result.run.status === "passed";
		if (passed && fixtureMeta.rawApprovalMode === "reviewer-must-approve") {
			const approvalOutputPath = fixtureMeta.rawApprovalOutputPath;
			if (!approvalOutputPath) {
				throw new Error(
					`Fixture '${fixtureMeta.name}' requires rawApprovalOutputPath when reviewer approval measurement is enabled.`,
				);
			}
			const approvalPath = resolve(demoDir, approvalOutputPath);
			passed = existsSync(approvalPath);
			if (passed && fixtureMeta.rawApprovalMustContain) {
				const outputText = readFileSync(approvalPath, "utf8");
				passed = outputText.includes(fixtureMeta.rawApprovalMustContain);
			}
		}
		rounds = 0;
	} else {
		const result = orchestrator.runPacket(run2Packet);
		passed = result.run.status === "passed";
		rounds = 0;
	}

	const durationMs = Date.now() - start;

	return {
		condition,
		passed,
		rounds,
		learningsWritten,
		memoriesInjected,
		durationMs,
	};
}

// ── Main ───────────────────────────────────────────────────────
const CONDITIONS: Condition[] = [
	"memory+strategy",
	"memory+raw",
	"nomemory+strategy",
	"nomemory+raw",
];

const SUITE_ID_PATTERN = /^[a-z0-9-]+$/i;

function normalizeSuiteId(suite: string): string {
	if (!SUITE_ID_PATTERN.test(suite)) {
		throw new Error(
			`Suite ids must be bare names without path segments (received '${suite}').`,
		);
	}
	return suite.toLowerCase();
}

function renderCodexEvalPrompt(
	packet: {
		model?: { systemPrompt?: string; prompt?: string };
		intent?: unknown;
	},
	renderer: TaskRendererLike,
): string {
	if (packet.intent) {
		const rendered = renderer.render(packet.intent, "implementer");
		const systemParts = [packet.model?.systemPrompt, rendered.system].filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		);
		return systemParts.length > 0
			? `${systemParts.join("\n\n---\n\n")}\n\n---\n\n${rendered.prompt}`
			: rendered.prompt;
	}
	if (packet.model?.prompt) {
		return packet.model.systemPrompt
			? `${packet.model.systemPrompt}\n\n---\n\n${packet.model.prompt}`
			: packet.model.prompt;
	}
	throw new Error(
		"Packet must have either a model.prompt or an intent with a renderer.",
	);
}

function createLocalCodexEvalExecutor(renderer: TaskRendererLike): {
	executePacketAsync: (
		packet: unknown,
		projectRoot: string,
		eventBus: unknown,
	) => Promise<unknown>;
} {
	return {
		async executePacketAsync(packet: unknown, projectRoot: string, eventBus) {
			const startedAt = new Date().toISOString();
			const p = packet as {
				model?: { systemPrompt?: string; prompt?: string; model?: string };
				intent?: unknown;
				verification?: { requiredOutputs?: readonly string[] };
			};
			const bus = eventBus as { emit?: (event: unknown) => void };
			bus.emit?.({
				kind: "execution-started",
				runId: "",
				timestamp: startedAt,
				executionType: "command",
			});

			const prompt = renderCodexEvalPrompt(p, renderer);
			const outputDir = resolve(projectRoot, "output");
			mkdirSync(outputDir, { recursive: true });

			let exitCode = 1;
			const stdout = "";
			let stderr = "";
			const writeOutput = (fileName: string, body: string) => {
				writeFileSync(resolve(outputDir, fileName), body);
				exitCode = 0;
			};
			const hasMemory = prompt.includes("<memories>");
			const hasReviewerFeedback = prompt.includes(
				"Reviewer feedback from round 1",
			);

			if (prompt.includes("Review the implementer output")) {
				const combinedPath = resolve(outputDir, "combined-only.js");
				const reviewerRescuePath = resolve(outputDir, "reviewer-rescue.js");
				if (existsSync(combinedPath)) {
					exitCode = readFileSync(combinedPath, "utf8").includes(
						"approved combined memory strategy",
					)
						? 0
						: 1;
				} else if (existsSync(reviewerRescuePath)) {
					exitCode = readFileSync(reviewerRescuePath, "utf8").includes(
						"approved",
					)
						? 0
						: 1;
				} else {
					const hasJavaScriptOutput = readdirSync(outputDir).some((entry) =>
						entry.endsWith(".js"),
					);
					exitCode = hasJavaScriptOutput ? 0 : 1;
				}
			} else if (prompt.includes("output/combined-only.js")) {
				if (hasMemory && hasReviewerFeedback) {
					writeOutput(
						"combined-only.js",
						"console.log('approved combined memory strategy')\n",
					);
				} else if (hasMemory) {
					writeOutput(
						"combined-only.js",
						"console.log('draft combined memory strategy')\n",
					);
				} else {
					stderr = "combined-only fixture requires injected memory";
				}
			} else if (prompt.includes("output/reviewer-rescue.js")) {
				writeOutput(
					"reviewer-rescue.js",
					hasReviewerFeedback
						? "console.log('approved reviewer rescue')\n"
						: "console.log('draft reviewer rescue')\n",
				);
			} else if (prompt.includes("output/memory-helped.js")) {
				writeOutput("memory-helped.js", "console.log('memory helped')\n");
			} else if (prompt.includes("output/hello.js")) {
				writeOutput("hello.js", "console.log('hello from codex')\n");
			} else {
				stderr = "local codex eval stub did not match fixture prompt";
			}

			const completedAt = new Date().toISOString();
			const outputChecks = (p.verification?.requiredOutputs ?? []).map(
				(path) => ({
					path,
					exists: existsSync(resolve(projectRoot, path)),
				}),
			);
			bus.emit?.({
				kind: "command-execution-complete",
				runId: "",
				timestamp: completedAt,
				exitCode,
				outputChecks,
			});

			return {
				command: "local-codex-eval",
				args: [],
				cwd: projectRoot,
				startedAt,
				completedAt,
				exitCode,
				stdout,
				stderr,
				outputChecks,
			};
		},
	};
}

async function main(): Promise<void> {
	const parsed = parseArgs();
	const suite = normalizeSuiteId(parsed.suite);
	const { json } = parsed;

	const suiteDir = join(__dirname, "suites", suite);
	const fixtures = discoverFixtures(suiteDir);

	if (fixtures.length === 0) {
		process.stderr.write(`No fixtures found in suite: ${suite}\n`);
		process.exit(1);
	}

	// Dynamic imports — resolve from apps/cli where @buildplane packages are installed
	const kernel = (await cliImport(
		"@buildplane/kernel",
	)) as unknown as KernelModule;
	const storage = (await cliImport(
		"@buildplane/storage",
	)) as unknown as StorageModule;
	const runtime = (await cliImport(
		"@buildplane/runtime",
	)) as unknown as RuntimeModule;
	const policy = (await cliImport(
		"@buildplane/policy",
	)) as unknown as PolicyModule;
	const adaptersGit = (await cliImport(
		"@buildplane/adapters-git",
	)) as unknown as AdaptersGitModule;
	const adaptersModels = (await cliImport(
		"@buildplane/adapters-models",
	)) as unknown as AdaptersModelsModule;
	const adaptersCodex = (await cliImport(
		"@buildplane/adapters-codex",
	)) as unknown as AdaptersCodexModule;

	const codexRenderer =
		adaptersModels.createCodexRenderer() as TaskRendererLike;
	const codexExecutor =
		process.env.BUILDPLANE_EVAL_MODEL === "1"
			? adaptersCodex.createCodexExecutor({
					renderer: codexRenderer,
				})
			: createLocalCodexEvalExecutor(codexRenderer);
	const runtimeRouter: RuntimePortLike = {
		executePacket(packet: unknown, root: string) {
			const candidate = packet as { execution?: unknown };
			if (candidate.execution) {
				return runtime.executePacket(packet, root);
			}
			throw new Error("Model packets require async execution path.");
		},
		async executePacketAsync(packet: unknown, root: string, eventBus: unknown) {
			const candidate = packet as {
				execution?: unknown;
				routingHints?: { preferredWorker?: string };
			};
			if (candidate.execution) {
				return runtime.executePacket(packet, root);
			}
			if (candidate.routingHints?.preferredWorker === "codex") {
				return codexExecutor.executePacketAsync(
					packet as never,
					root,
					eventBus,
				);
			}
			throw new Error(
				`Unsupported eval model worker: ${candidate.routingHints?.preferredWorker ?? "(missing preferredWorker)"}`,
			);
		},
	};

	const cliSrcBase = pathToFileURL(join(CLI_DIR, "src")).href;
	const { enrichPacketWithMemories } = (await import(
		`${cliSrcBase}/packet-enrichment.js`
	)) as { enrichPacketWithMemories: EnrichFn };

	const { wrapAsStrategy } = (await import(
		`${cliSrcBase}/strategy-wrapper.js`
	)) as { wrapAsStrategy: WrapAsStrategyFn };

	const fixtureResults: FixtureResult[] = [];

	for (const fixture of fixtures) {
		if (!json) {
			process.stdout.write(`Running fixture: ${fixture.meta.name}\n`);
		}

		const conditionResults: ConditionResult[] = [];

		for (const condition of CONDITIONS) {
			if (!json) {
				process.stdout.write(`  condition: ${condition}...\n`);
			}

			const result = await runCondition(
				condition,
				fixture.meta,
				fixture.run1,
				fixture.run2,
				kernel,
				storage,
				runtimeRouter,
				policy,
				adaptersGit,
				enrichPacketWithMemories,
				wrapAsStrategy,
			);

			conditionResults.push(result);
		}

		fixtureResults.push({
			name: fixture.meta.name,
			description: fixture.meta.description,
			conditions: conditionResults,
		});
	}

	const aggregates = computeAggregates(fixtureResults);

	const report: EvalReport = {
		suiteId: suite,
		fixtures: fixtureResults,
		aggregates,
	};

	if (json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatEvalReport(report));
	}

	process.exit(0);
}

main().catch((err) => {
	process.stderr.write(
		`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
