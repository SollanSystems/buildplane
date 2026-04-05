// biome-ignore lint/correctness/noUnusedImports: used in Task 2
import { execFileSync } from "node:child_process";
// biome-ignore lint/correctness/noUnusedImports: used in Task 2
import { mkdtempSync, writeFileSync } from "node:fs";
// biome-ignore lint/correctness/noUnusedImports: used in Task 2
import { tmpdir } from "node:os";
// biome-ignore lint/correctness/noUnusedImports: used in Task 2
import { join } from "node:path";
// biome-ignore lint/correctness/noUnusedImports: used in Task 2
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
export function cleanGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}
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

// ── Main demo runner (placeholder — wired in Task 2) ─────────
export async function runDemo(_options: { model?: boolean }): Promise<void> {
	throw new Error("Not yet implemented — wired in Task 2");
}
