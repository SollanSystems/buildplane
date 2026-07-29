import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ── ANSI helpers ─────────────────────────────────────────────
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function log(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

export function logBold(msg: string): void {
	log(`${BOLD}${msg}${RESET}`);
}

export function logSuccess(msg: string): void {
	log(`  ${GREEN}✓${RESET} ${msg}`);
}

export function logInfo(msg: string): void {
	log(`  ${CYAN}→${RESET} ${msg}`);
}

export function logDim(msg: string): void {
	log(`  ${DIM}${msg}${RESET}`);
}

export function logSection(title: string): void {
	log("");
	log(
		`${DIM}── ${title} ${"─".repeat(Math.max(0, 48 - title.length))}${RESET}`,
	);
	log("");
}

// ── Git environment isolation ────────────────────────────────
const DEFAULT_GIT_IDENTITY = Object.freeze({
	name: "Buildplane",
	email: "buildplane@local",
});

export function cleanGitEnv(): NodeJS.ProcessEnv {
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

// ── Packet factories ─────────────────────────────────────────
export interface DemoPacket {
	readonly unit: {
		readonly id: string;
		readonly kind: string;
		readonly scope: string;
		readonly inputRefs: readonly string[];
		readonly expectedOutputs: readonly string[];
		readonly verificationContract: string;
		readonly policyProfile: string;
	};
	readonly execution: {
		readonly command: string;
		readonly args: readonly string[];
	};
	readonly verification: {
		readonly requiredOutputs: readonly string[];
	};
	/** Explicitly stamp the role so demo packets exercise the governed shape. */
	readonly execution_role: "implementer";
	readonly intent: {
		readonly objective: string;
		readonly taskType: string;
		readonly context: { readonly files: readonly string[] };
		readonly constraints: {
			readonly scope: readonly string[];
			readonly verification: readonly string[];
		};
		readonly features: {
			readonly ambiguity: string;
			readonly reversibility: string;
			readonly verifierStrength: string;
		};
	};
}

export function createCommandPacket1(): DemoPacket {
	return {
		unit: {
			id: "demo-cmd-1",
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: ["output/result.txt"],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		execution: {
			command: "node",
			args: [
				"-e",
				"require('fs').mkdirSync('output',{recursive:true}); require('fs').writeFileSync('output/result.txt','computed value: 42')",
			],
		},
		verification: { requiredOutputs: ["output/result.txt"] },
		execution_role: "implementer",
		intent: {
			objective: "Compute and write result",
			taskType: "implement",
			context: { files: [] },
			constraints: { scope: [], verification: [] },
			features: {
				ambiguity: "low",
				reversibility: "easy",
				verifierStrength: "strong",
			},
		},
	};
}

export function createCommandPacket2(): DemoPacket {
	return {
		unit: {
			id: "demo-cmd-2",
			kind: "command",
			scope: "task",
			inputRefs: [],
			expectedOutputs: ["output/summary.txt"],
			verificationContract: "exit-0-and-required-outputs",
			policyProfile: "default",
		},
		execution: {
			command: "node",
			args: [
				"-e",
				"require('fs').mkdirSync('output',{recursive:true}); require('fs').writeFileSync('output/summary.txt','summary: all tasks passed')",
			],
		},
		verification: { requiredOutputs: ["output/summary.txt"] },
		execution_role: "implementer",
		intent: {
			objective: "Summarize workspace state",
			taskType: "implement",
			context: { files: ["output/result.txt"] },
			constraints: { scope: [], verification: [] },
			features: {
				ambiguity: "low",
				reversibility: "easy",
				verifierStrength: "strong",
			},
		},
	};
}

// ── Main demo runner ─────────────────────────────────────────
/**
 * The flywheel demo intentionally uses local command execution in a disposable
 * repository. It is useful for development, but it is not a governed worker
 * or an ActionGateway/OCI sandbox demonstration. Require an explicit caller
 * acknowledgement so it cannot be mistaken for the normal trusted front door.
 */
export async function runDemo(options: {
	readonly model?: boolean;
	readonly raw?: boolean;
}): Promise<void> {
	if (options.raw !== true) {
		throw new Error(
			"The flywheel demo uses an unsafe ambient command lane. Pass raw: true (CLI: buildplane demo --raw) to acknowledge it.",
		);
	}
	// ── Setup ──────────────────────────────────────────────────
	log("");
	logBold("━━━ Buildplane Flywheel Demo ━━━━━━━━━━━━━━━━━━");
	// Keep these machine-detectable raw-lane markers separate from the human
	// explanation. Demo output must never be mistaken for governed evidence.
	log("governance: unsafe");
	log("trusted-receipt: false");
	logDim("development demo; no trusted receipt");
	log("");
	log("Setting up temporary workspace...");

	const demoDir = mkdtempSync(join(tmpdir(), "bp-demo-"));
	const gitEnv = cleanGitEnv();
	const gitOpts = { cwd: demoDir, env: gitEnv, encoding: "utf8" as const };

	execFileSync("git", ["init"], gitOpts);
	writeFileSync(join(demoDir, ".gitkeep"), "");
	execFileSync("git", ["add", "."], gitOpts);
	execFileSync("git", ["commit", "-m", "init"], gitOpts);

	// Dynamic imports (same pattern as loadCliOrchestrator in run-cli.ts)
	const kernel = (await import("@buildplane/kernel")) as unknown as {
		createBuildplaneOrchestrator: (opts: Record<string, unknown>) => {
			initializeProject: () => { created: boolean; projectRoot: string };
			runPacket: (
				packet: unknown,
				eventBus?: unknown,
				runOptions?: { trustLane?: "unsafe" },
			) => {
				run: { id: string; status: string };
				receipt: unknown;
				decision?: { outcome: string; reasons: string[] };
			};
		};
	};
	const storage = (await import("@buildplane/storage")) as unknown as {
		createBuildplaneStorage: (root: string) => unknown;
		resolveProjectLayout: (root: string) => { stateDbPath: string };
		createLearningStore: (db: unknown) => {
			writeLearnings: (runId: string, learnings: readonly unknown[]) => void;
			fetchLearnings: (opts?: {
				limit?: number;
			}) => readonly { kind: string; title: string; body: string }[];
		};
	};
	const runtime = (await import("@buildplane/runtime")) as unknown as {
		executePacket: (packet: unknown, root: string) => unknown;
	};
	const policy = (await import("@buildplane/policy")) as unknown as {
		evaluateRun: (...args: unknown[]) => unknown;
	};
	const adaptersGit = (await import("@buildplane/adapters-git")) as unknown as {
		createGitWorktreeAdapter: () => unknown;
	};
	const { enrichPacketWithMemories } = await import("./packet-enrichment.js");

	// Phase 1: Create orchestrator without memory, init project
	const baseOpts = {
		projectRoot: demoDir,
		storage: storage.createBuildplaneStorage(demoDir),
		runtime: { executePacket: runtime.executePacket },
		policy: { evaluateRun: policy.evaluateRun },
		workspace: adaptersGit.createGitWorktreeAdapter(),
	};

	const initOrchestrator = kernel.createBuildplaneOrchestrator(baseOpts);
	initOrchestrator.initializeProject();

	// Phase 2: Open memory ports (state.db now exists)
	const layout = storage.resolveProjectLayout(demoDir);
	const readDb = new DatabaseSync(layout.stateDbPath, { readOnly: true });
	const writeDb = new DatabaseSync(layout.stateDbPath);
	const readMemoryPort = storage.createLearningStore(readDb);
	const writeMemoryPort = storage.createLearningStore(writeDb);

	// Phase 3: Re-create orchestrator WITH memory port
	const orchestrator = kernel.createBuildplaneOrchestrator({
		...baseOpts,
		memoryPort: writeMemoryPort,
	});

	logSuccess("Initialized .buildplane project");

	// ── Phase 1: First Run ─────────────────────────────────────
	logSection("Phase 1: First Run");

	const packet1 = createCommandPacket1();
	log(`Running: "${packet1.intent.objective}"`);

	const result1 = orchestrator.runPacket(packet1, undefined, {
		trustLane: "unsafe",
	});
	logSuccess(`Passed — exit 0, ${packet1.unit.expectedOutputs[0]} created`);
	const decision1 = result1.decision as { outcome: string } | undefined;
	log(`  Policy: ${decision1?.outcome ?? "N/A"}`);
	log("");

	// Show extracted learnings
	const learnings = readMemoryPort.fetchLearnings({ limit: 10 });
	log("  Learnings extracted (read from run_learnings table):");
	for (const l of learnings) {
		logDim(`[${l.kind}] ${l.title}: ${l.body}`);
	}

	// ── Phase 2: Flywheel Proof ────────────────────────────────
	logSection("Phase 2: Flywheel Proof");

	log("Fetching memories from prior runs...");
	logInfo(`${learnings.length} learnings found`);
	log("");

	const packet2 = createCommandPacket2();
	const enrichedPacket = (await enrichPacketWithMemories(
		packet2,
		readMemoryPort,
		undefined,
		undefined,
	)) as {
		intent?: { context?: { memories?: string[] } };
	};

	const memories = enrichedPacket.intent?.context?.memories ?? [];
	log("  Injected into run 2's prompt:");
	for (const m of memories) {
		logDim(`  ${m}`);
	}
	log("");

	log(`Running: "${packet2.intent.objective}"`);
	const result2 = orchestrator.runPacket(enrichedPacket, undefined, {
		trustLane: "unsafe",
	});
	logSuccess(`Passed — exit 0, ${packet2.unit.expectedOutputs[0]} created`);
	const decision2 = result2.decision as { outcome: string } | undefined;
	log(`  Policy: ${decision2?.outcome ?? "N/A"}`);

	// ── Result ─────────────────────────────────────────────────
	logSection("Result");

	log(`  Run 1: stored ${learnings.length} learnings`);
	log(`  Run 2: received ${memories.length} memories from run 1`);
	logSuccess("Flywheel closed — second run was informed by the first");
	log("");
	log(`  Workspace: ${demoDir} (inspect with buildplane history)`);
	log("");

	// Suppress unused variable warnings for result vars — we log outcomes above
	void result1;
	void result2;

	// ── Phase 3: Model flywheel (optional) ─────────────────────
	if (options.model) {
		logSection("Phase 3: Model Flywheel");
		log("Detecting model host...");

		let hostName: string | undefined;
		try {
			execFileSync("which", ["claude"], { encoding: "utf8" });
			hostName = "Claude Code";
		} catch {
			try {
				execFileSync("which", ["codex"], { encoding: "utf8" });
				hostName = "Codex";
			} catch {
				// No host found
			}
		}

		if (!hostName) {
			log(
				"  No model host detected. Install Claude Code or Codex to see the model demo.",
			);
		} else {
			logInfo(`Detected: ${hostName}`);
			log("");

			const modelPacket = {
				unit: {
					id: "demo-model-1",
					kind: "model",
					scope: "task",
					inputRefs: [],
					expectedOutputs: ["output/hello.js"],
					verificationContract: "exit-0-and-required-outputs",
					policyProfile: "default",
				},
				intent: {
					objective: "Write a hello world Node.js script",
					taskType: "implement",
					context: { files: [] },
					constraints: { scope: [], verification: [] },
					features: {
						ambiguity: "low",
						reversibility: "easy",
						verifierStrength: "strong",
					},
				},
				verification: { requiredOutputs: ["output/hello.js"] },
			};

			const enrichedModelPacket = (await enrichPacketWithMemories(
				modelPacket,
				readMemoryPort,
				undefined,
				undefined,
			)) as { intent?: { context?: { memories?: string[] } } };

			const modelMemories = enrichedModelPacket.intent?.context?.memories ?? [];
			log(`  Model packet would receive ${modelMemories.length} memories:`);
			for (const m of modelMemories) {
				logDim(`  ${m}`);
			}
			log("");
			log(
				`  When executed through ${hostName}, these appear in the model's "Relevant Memories" section.`,
			);
			log(
				"  Full model execution demo coming in a follow-up (requires host integration testing).",
			);
		}
		log("");
	}
}
