#!/usr/bin/env node
// M6 killer-demo runner — stages the ten-step operator flow for the v0.5 demo.
//
// This script NEVER autonomously triggers a live Claude worker run (spec §7
// live-run gate): the operator triggers and watches the one live execution.
// The runner only stages the flow and narrates every command.
//
// Usage:
//   node scripts/run-demo.mjs --dry-run   # print the whole flow, spawn nothing
//   node scripts/run-demo.mjs             # stage a temp copy of the toy repo,
//                                         # print the flow with real paths, then
//                                         # hand off to the operator (no worker)
//
// Runbook: docs/operations/2026-07-02-m6-demo-runbook.md
// Dependency-free: node: builtins only.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const FIXTURE_DIR = join(REPO_ROOT, "fixtures", "demo-repo");

const GOAL_TEXT =
	"Add rate limiting to POST /api/login: max 5 requests per minute per IP, return 429 with a Retry-After header.";

// ── The ten operator steps ───────────────────────────────────────────────────
// Each command line is what the operator types; `notes` narrate what it proves.
const STEPS = [
	{
		n: 1,
		title: "Compile + preview a raw goal",
		command: `bp goal "${GOAL_TEXT}"`,
		notes: [
			"Auto-detects trustedBase via `git rev-parse HEAD`, synthesizes PlanForge",
			"markdown, runs compile → validate → preview, and prints the plan JSON.",
		],
	},
	{
		n: 2,
		title: "Read the compile/preview surface",
		command: null,
		notes: [
			"Inspect the output: planDigest, trustedBase, missingEvidence, riskClass.",
			"EXPECTED: a bare goal string has an empty `## Tasks` section, so validation",
			'returns INSUFFICIENT_EVIDENCE with missingEvidence: ["tasks"]. This is the',
			"correct, expected preview verdict — `bp goal` is a compile+preview surface,",
			"NOT an admit path. The plan is intentionally not admissible yet.",
		],
	},
	{
		n: 3,
		title: "Switch to goal.md (seed tasks) and dry-run the full plan",
		command: "bp planforge dry-run --input goal.md --json",
		notes: [
			'TWO-INPUT HANDOFF: step 1 used the raw string `bp goal "<text>"`; to admit,',
			"the operator now switches to the seed fixtures/demo-repo/goal.md, which",
			'carries a populated `## Tasks` section. This input change ("<text>" → goal.md)',
			"is deliberate — do not be confused by the discontinuity. The dry-run compiles",
			"goal.md into the full PASS plan (planDigest, trustedBase, tasks, riskClass,",
			"no missing evidence).",
		],
	},
	{
		n: 4,
		title: "Admit the reviewed plan",
		command:
			"bp planforge admit --input goal.md --approve --operator <operator-id>",
		notes: [
			"Operator reviews budget + risk class, then admits. Records the signed",
			"`plan_admitted` event on the L0 tape (kernel key). --approve and --operator",
			"are both required — admission is an explicit, attributed decision.",
		],
	},
	{
		n: 5,
		title: "Admission recorded + bundle finalized; open the web inspector",
		command: "pnpm build && bp web",
		notes: [
			"The signed plan_admitted lands and the capability bundle is finalized.",
			"Launch Mission Control at http://localhost:4173 (source/dev-only — run",
			"`pnpm build` first so apps/web/dist exists). Operator opens the run inspector.",
		],
	},
	{
		n: 6,
		title: "Worker dispatched into an isolated worktree",
		command: null,
		notes: [
			"Worker runs in a fresh git worktree; writable src/ + test/; tools",
			"Read/Write/Edit/Bash; net-egress = NPM registry only.",
		],
	},
	{
		n: 7,
		title: "Every tool call becomes a signed, policy-checked tape event",
		command: null,
		notes: [
			"Each Edit/Bash tool call is appended to the tape as a signed event and",
			"checked against the capability bundle.",
			"→ PAUSE HERE for Property 1 (crash-resume) and Property 2 (policy denial).",
		],
	},
	{
		n: 8,
		title: "Completion validated against the Acceptance Contract",
		command: null,
		notes: [
			"The completion record is evaluated against the Acceptance Contract:",
			"diff-scope + CI + lint. A passing record emits a signed `acceptance_recorded`.",
		],
	},
	{
		n: 9,
		title: "Kernel emits result_ready; operator sees it in the inbox",
		command: null,
		notes: [
			"The kernel emits a signed `result_ready` L0 event. The approval inbox in",
			"bp web surfaces it (the inbox feed stays derived; result_ready coexists).",
		],
	},
	{
		n: 10,
		title: "Operator clicks Merge; final outcome on the tape",
		command: null,
		notes: [
			'Operator clicks "Merge" in bp web → signed `operator_decision_recorded`',
			"plus a signed `run_completed` final-outcome event; the branch is merged.",
		],
	},
];

// ── The three demonstrated properties ────────────────────────────────────────
const PROPERTIES = [
	{
		n: 1,
		title: "Replay / crash-resume",
		notes: [
			"Between steps 7 and 8, set BUILDPLANE_CRASH_AFTER_ACTIVITY=1 and SIGKILL the",
			"kernel right after an `activity_completed` lands. Restart, then run:",
			"  bp planforge recover",
			"The tape is replayed, the completed activity is reused (never re-invoked),",
			"execution resumes at step 8, and the final state is identical — exactly one",
			"`plan_receipt`, no re-execution.",
		],
	},
	{
		n: 2,
		title: "Policy enforcement",
		notes: [
			"Dispatch the out-of-scope command packet",
			"(fixtures/demo-repo/out-of-scope-packet.json) that attempts a write to",
			"docs/out-of-scope.txt — outside the src/**, test/** fsWrite scope. The",
			"capability broker denies it and appends a signed `capability_denied`",
			"quarantine event to the tape. This is the real, enforced M3 boundary.",
		],
	},
	{
		n: 3,
		title: "Signed receipts",
		notes: [
			"Export the toy-repo tape and run:",
			"  node scripts/verify-signed-tape.mjs --fixture <dir>",
			"Exit 0 iff every event's Ed25519 signature verifies and every tape-root",
			"checkpoint recomputes. (The verifier proves consistency against",
			"tape-embedded keys, not third-party authenticity.)",
		],
	},
];

function parseArgs(argv) {
	return {
		dryRun: argv.includes("--dry-run"),
		help: argv.includes("--help") || argv.includes("-h"),
	};
}

function printUsage(out) {
	out("Buildplane M6 demo runner");
	out("");
	out("Usage:");
	out(
		"  node scripts/run-demo.mjs --dry-run   Print the whole flow; spawn nothing.",
	);
	out(
		"  node scripts/run-demo.mjs             Stage a temp copy of the toy repo,",
	);
	out(
		"                                        print the flow, hand off to operator.",
	);
	out("");
	out("Runbook: docs/operations/2026-07-02-m6-demo-runbook.md");
}

function printFlow(out, { stagedDir } = {}) {
	out(
		"═══════════════════════════════════════════════════════════════════════",
	);
	out(" Buildplane v0.5 — the ten-step killer demo");
	out(
		"═══════════════════════════════════════════════════════════════════════",
	);
	out("");
	out(
		"The operator triggers and watches the one live worker run. This runner only",
	);
	out("stages the flow — it never autonomously spawns a worker (spec §7).");
	if (stagedDir) {
		out("");
		out(`Staged toy repo: ${stagedDir}`);
		out("Run the commands below from that directory.");
	}
	out("");
	out(
		"── The ten steps ──────────────────────────────────────────────────────",
	);
	for (const step of STEPS) {
		out("");
		out(`Step ${step.n} — ${step.title}`);
		if (step.command) {
			out(`  $ ${step.command}`);
		}
		for (const line of step.notes) {
			out(`  ${line}`);
		}
	}
	out("");
	out(
		"── The three properties ───────────────────────────────────────────────",
	);
	for (const property of PROPERTIES) {
		out("");
		out(`Property ${property.n} — ${property.title}`);
		for (const line of property.notes) {
			out(`  ${line}`);
		}
	}
	out("");
	out(
		"═══════════════════════════════════════════════════════════════════════",
	);
}

const TRUSTED_BASE_PLACEHOLDER = "<stamped-at-staging>";

function stageToyRepo(out) {
	const stagedDir = mkdtempSync(join(tmpdir(), "buildplane-demo-"));
	cpSync(FIXTURE_DIR, stagedDir, { recursive: true });
	// Demo inputs + run state stay git-ignored so stamping the trusted base
	// AFTER the seed commit leaves the staged tree clean (the run loop
	// requires a clean tree, and the seed SHA cannot be known before it exists).
	// `.claude/` + `.gsd/` cover host-session tool state the spawned worker's
	// `claude` process may drop into its worktree — diff-scope honors
	// `--exclude-standard`, so ignoring them keeps the acceptance gate on the
	// task's real writes instead of the operator machine's hook droppings.
	writeFileSync(
		join(stagedDir, ".gitignore"),
		[
			"node_modules/",
			".buildplane/",
			".claude/",
			".gsd/",
			"goal.md",
			"out-of-scope-packet.json",
			"",
		].join("\n"),
	);
	// git-init the copy so `bp goal` can auto-detect trustedBase via
	// `git rev-parse HEAD`. Failure is non-fatal — the operator can init by hand.
	const env = { ...process.env };
	env.GIT_AUTHOR_NAME ??= "Buildplane";
	env.GIT_AUTHOR_EMAIL ??= "buildplane@local";
	env.GIT_COMMITTER_NAME ??= "Buildplane";
	env.GIT_COMMITTER_EMAIL ??= "buildplane@local";
	try {
		const git = (args) =>
			execFileSync("git", args, {
				cwd: stagedDir,
				env,
				stdio: ["ignore", "pipe", "ignore"],
			});
		git(["init", "-q"]);
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "chore: seed demo toy repo"]);
		const trustedBase = git(["rev-parse", "HEAD"]).toString().trim();
		const goalPath = join(stagedDir, "goal.md");
		writeFileSync(
			goalPath,
			readFileSync(goalPath, "utf8").replace(
				TRUSTED_BASE_PLACEHOLDER,
				trustedBase,
			),
		);
		out(`Stamped trusted base ${trustedBase} into the staged goal.md.`);
	} catch {
		out(
			"  (warning: could not git-init/stamp the staged copy — init it and stamp goal.md's Trusted base by hand)",
		);
	}
	return stagedDir;
}

function main() {
	const out = (line) => process.stdout.write(`${line}\n`);
	const { dryRun, help } = parseArgs(process.argv.slice(2));

	if (help) {
		printUsage(out);
		return 0;
	}

	if (dryRun) {
		printFlow(out);
		out("");
		out(
			"dry-run: no temp dir was created and no processes were spawned. Re-run",
		);
		out(
			"without --dry-run to stage a temp copy of the toy repo for a live demo.",
		);
		return 0;
	}

	const stagedDir = stageToyRepo(out);
	printFlow(out, { stagedDir });
	out("");
	out(
		"Staged and ready. The runner stops here — the operator triggers the live",
	);
	out("worker run and works through the steps above while watching.");
	return 0;
}

process.exit(main());
