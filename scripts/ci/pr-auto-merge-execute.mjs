#!/usr/bin/env node
/**
 * Narrow auto-merge executor.
 *
 * Performs a GitHub PR merge ONLY after a fresh eligibility receipt proves
 * `AUTO_MERGE_READY`. Re-checks live state before merging. Refuses stale
 * receipts, SHA mismatches, and already-merged PRs.
 *
 * Merge method:
 *   - Prefers native auto-merge via GraphQL `enablePullRequestAutoMerge`
 *   - Falls back to direct REST merge only with --direct-merge flag
 *
 * Must NOT approve reviews, create deployments, delete branches (except as
 * configured by repo settings), or mutate workflow state beyond the merge.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// ── constants ────────────────────────────────────────────────────────────────

const OPT_LABEL = "buildplane:auto-merge";
const MAX_RECEIPT_AGE_MINUTES = 10;

export const EXEC_MERGE_OK = "EXEC_MERGE_OK";
export const EXEC_AUTO_MERGE_ENABLED = "EXEC_AUTO_MERGE_ENABLED";
export const EXEC_DIRECT_MERGED = "EXEC_DIRECT_MERGED";
export const RECONCILE_ALREADY_MERGED = "RECONCILE_ALREADY_MERGED";
export const BLOCKED_NO_RECEIPT = "BLOCKED_NO_RECEIPT";
export const BLOCKED_STALE_RECEIPT = "BLOCKED_STALE_RECEIPT";
export const BLOCKED_RECEIPT_NOT_READY = "BLOCKED_RECEIPT_NOT_READY";
export const BLOCKED_RECEIPT_PR_MISMATCH = "BLOCKED_RECEIPT_PR_MISMATCH";
export const BLOCKED_RECEIPT_SHA_MISMATCH = "BLOCKED_RECEIPT_SHA_MISMATCH";
export const BLOCKED_RECEIPT_UNREADABLE = "BLOCKED_RECEIPT_UNREADABLE";
export const BLOCKED_LIVE_SHA_MISMATCH = "BLOCKED_LIVE_SHA_MISMATCH";
export const BLOCKED_LIVE_RECHECK = "BLOCKED_LIVE_RECHECK";
export const BLOCKED_POST_MERGE = "BLOCKED_POST_MERGE";
export const BLOCKED_PR_CLOSED = "BLOCKED_PR_CLOSED";
export const BLOCKED_PR_ID_LOOKUP = "BLOCKED_PR_ID_LOOKUP";
export const ERROR_GITHUB_QUERY = "ERROR_GITHUB_QUERY";

// ── helpers ──────────────────────────────────────────────────────────────────

export function runJson(command, args) {
	const output = execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(output);
}

export function tryRunJson(command, args) {
	try {
		return runJson(command, args);
	} catch {
		return undefined;
	}
}

export function runStdout(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

export function prShortSha(sha) {
	if (!sha || sha.length < 7) return sha;
	return sha.slice(0, 7);
}

// ── receipt reading ──────────────────────────────────────────────────────────

export function firstString(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return undefined;
}

export function readReceipt(path) {
	if (!path || !existsSync(path)) {
		return {
			valid: false,
			reason: `receipt not found: ${path}`,
			status: BLOCKED_NO_RECEIPT,
		};
	}

	let data;
	try {
		const content = readFileSync(path, "utf8").trim();
		data = JSON.parse(content);
	} catch {
		return {
			valid: false,
			reason: `receipt is not valid JSON: ${path}`,
			status: BLOCKED_RECEIPT_UNREADABLE,
		};
	}

	// Accept both flat executor-focused receipts and canonical nested eligibility receipts.
	const verdict = data.verdict ?? data.status;
	const receiptPr =
		typeof data.pr === "object" && data.pr !== null ? data.pr.number : data.pr;
	const receiptHeadSha = firstString(
		data.headSha,
		data.expectedHeadSha,
		data.pr?.headRefOid,
		data.pr?.headSha,
		data.review?.expectedHead,
		data.review?.reviewAssertion?.reviewedCommitSha,
		data.review?.reviewAssertion?.currentPrHeadSha,
	);
	const timestamp = firstString(
		data.timestamp,
		data.generatedAt,
		data.createdAt,
	);

	const gaps = [];
	if (verdict !== "AUTO_MERGE_READY") {
		gaps.push(`verdict is "${verdict}", expected AUTO_MERGE_READY`);
	}
	if (receiptPr == null) gaps.push("missing pr/pr.number");
	if (!receiptHeadSha) {
		gaps.push(
			"missing headSha/expectedHeadSha or canonical receipt review/pr head fields",
		);
	}
	if (!timestamp) gaps.push("missing timestamp");

	if (gaps.length > 0) {
		return {
			valid: false,
			reason: `receipt gaps: ${gaps.join("; ")}`,
			status: BLOCKED_RECEIPT_NOT_READY,
		};
	}

	// Check receipt age. Reject malformed or future timestamps fail-closed so
	// receipts cannot bypass the freshness gate through NaN/negative ages.
	const receiptTime = new Date(timestamp).getTime();
	if (!Number.isFinite(receiptTime)) {
		return {
			valid: false,
			reason: `receipt has invalid timestamp: ${timestamp}`,
			status: BLOCKED_STALE_RECEIPT,
		};
	}
	const receiptAge = (Date.now() - receiptTime) / 60000;
	if (receiptAge < 0) {
		return {
			valid: false,
			reason: `receipt timestamp is ${Math.abs(receiptAge).toFixed(1)} min in the future`,
			status: BLOCKED_STALE_RECEIPT,
		};
	}
	if (receiptAge > MAX_RECEIPT_AGE_MINUTES) {
		return {
			valid: false,
			reason: `receipt is ${receiptAge.toFixed(1)} min old (max ${MAX_RECEIPT_AGE_MINUTES})`,
			status: BLOCKED_STALE_RECEIPT,
		};
	}

	return {
		data,
		pr: Number(receiptPr),
		headSha: receiptHeadSha,
		timestamp,
		valid: true,
	};
}

// ── PR query ─────────────────────────────────────────────────────────────────

export function queryPr(prNumber) {
	const json = tryRunJson("gh", [
		"pr",
		"view",
		String(prNumber),
		"-R",
		"SollanSystems/buildplane",
		"--json",
		"number,url,state,isDraft,baseRefName,headRefName," +
			"headRefOid,mergeable,mergeStateStatus,reviewDecision," +
			"autoMergeRequest,labels",
	]);
	if (!json) return undefined;

	const labels = (
		Array.isArray(json.labels?.nodes)
			? json.labels.nodes
			: Array.isArray(json.labels)
				? json.labels
				: []
	)
		.map((l) => (typeof l === "string" ? l : l?.name))
		.filter(Boolean);

	return {
		number: json.number,
		url: json.url,
		state: json.state,
		isDraft: json.isDraft ?? false,
		baseRefName: json.baseRefName,
		headRefName: json.headRefName,
		headRefOid: json.headRefOid,
		mergeable: json.mergeable,
		mergeStateStatus: json.mergeStateStatus,
		reviewDecision: json.reviewDecision,
		autoMergeRequest: json.autoMergeRequest ?? null,
		labels,
		hasOptInLabel: labels.includes(OPT_LABEL),
	};
}

// ── recon live eligibility ───────────────────────────────────────────────────

export function buildLiveEligibilityArgs(prNumber, expectedHead, expectedBase) {
	return [
		"scripts/ci/pr-auto-merge-eligibility.mjs",
		"--pr",
		String(prNumber),
		"--expected-head",
		expectedHead,
		"--expected-base",
		expectedBase,
		"--review-pass",
		"--json",
	];
}

export function runLiveEligibility(prNumber, expectedHead, expectedBase) {
	const result = tryRunJson(
		"node",
		buildLiveEligibilityArgs(prNumber, expectedHead, expectedBase),
	);
	return result;
}

// ── merge ────────────────────────────────────────────────────────────────────

export function buildEnableAutoMergeArgs(prId, expectedHeadOid) {
	const query = `mutation($prId: ID!, $expectedHeadOid: GitObjectID!) { enablePullRequestAutoMerge(input: {pullRequestId: $prId, mergeMethod: SQUASH, expectedHeadOid: $expectedHeadOid}) { clientMutationId } }`;
	return [
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		"-f",
		`prId=${prId}`,
		"-f",
		`expectedHeadOid=${expectedHeadOid}`,
	];
}

export function enableAutoMerge(prId, expectedHeadOid) {
	// Use GraphQL to enable native auto-merge with SQUASH, pinned to the
	// reviewed head SHA so a last-moment push cannot inherit this merge request.
	runStdout("gh", buildEnableAutoMergeArgs(prId, expectedHeadOid));
}

export function missingNativeAutoMergePrIdBlocker(prNumber) {
	return {
		status: BLOCKED_PR_ID_LOOKUP,
		reason: `Failed to resolve PR #${prNumber} node ID for native auto-merge; rerun after GitHub API recovery or pass --direct-merge explicitly to use direct squash merge`,
	};
}

export function buildDirectSquashMergeArgs(prNumber, headSha, commitTitle) {
	return [
		"pr",
		"merge",
		String(prNumber),
		"-R",
		"SollanSystems/buildplane",
		"--squash",
		"--delete-branch",
		"--match-head-commit",
		headSha,
		"--subject",
		commitTitle ?? `Auto-merge PR #${prNumber} via Buildplane`,
	];
}

export function directSquashMerge(prNumber, headSha, commitTitle) {
	runStdout("gh", buildDirectSquashMergeArgs(prNumber, headSha, commitTitle));
}

// ── post-merge verification ──────────────────────────────────────────────────

export function queryCheckRunsForCommit(commitSha) {
	const checkRuns = [];
	for (let page = 1; page <= 10; page++) {
		const pageRuns = tryRunJson("gh", [
			"api",
			`repos/SollanSystems/buildplane/commits/${commitSha}/check-runs?per_page=100&page=${page}`,
			"--jq",
			".check_runs | map({name, conclusion, status})",
		]);
		if (!Array.isArray(pageRuns)) break;
		checkRuns.push(...pageRuns);
		if (pageRuns.length < 100) break;
	}
	return checkRuns;
}

export function verifyPostMerge(prNumber, headSha, expectedBase) {
	const results = { checks: [], merged: false, onDefaultBranch: false };

	// Fetch
	runStdout("git", ["fetch", "origin", "--prune"]);

	// Verify PR state is MERGED
	const pr = tryRunJson("gh", [
		"pr",
		"view",
		String(prNumber),
		"-R",
		"SollanSystems/buildplane",
		"--json",
		"state,mergeCommit",
	]);
	results.merged = pr?.state === "MERGED";
	results.mergeCommit = pr?.mergeCommit?.oid ?? null;

	// Verify merge commit exists on origin/main
	if (results.mergeCommit) {
		const defaultBranch = tryRunJson("gh", [
			"repo",
			"view",
			"SollanSystems/buildplane",
			"--json",
			"defaultBranchRef",
		]);
		const defaultBranchName =
			defaultBranch?.defaultBranchRef?.name ?? expectedBase ?? "main";

		const onBranch = tryRunText("git", [
			"branch",
			"-r",
			"--contains",
			results.mergeCommit,
			`origin/${defaultBranchName}`,
		]);
		results.onDefaultBranch = onBranch !== undefined && onBranch.length > 0;
	}

	// Query default branch checks (if merge commit known)
	if (results.mergeCommit) {
		results.checkRuns = queryCheckRunsForCommit(results.mergeCommit);
	}

	// GET-only deployment probe
	const deployments = tryRunJson("gh", [
		"api",
		`repos/SollanSystems/buildplane/deployments?ref=${results.mergeCommit ?? headSha}&per_page=20`,
		"--jq",
		". | length",
	]);
	results.deploymentCount =
		typeof deployments === "number" ? deployments : null;

	return results;
}

export function normalizeCheckState(value) {
	return typeof value === "string" ? value.toUpperCase() : "";
}

export function isPostMergeVerified(postMerge) {
	const allowedCheckConclusions = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
	const checkRuns = Array.isArray(postMerge.checkRuns)
		? postMerge.checkRuns
		: [];
	const checkRunsVerified =
		checkRuns.length > 0 &&
		checkRuns.every(
			(check) =>
				normalizeCheckState(check?.status) === "COMPLETED" &&
				allowedCheckConclusions.has(normalizeCheckState(check?.conclusion)),
		);

	return (
		postMerge.merged === true &&
		postMerge.onDefaultBranch === true &&
		postMerge.deploymentCount === 0 &&
		checkRunsVerified
	);
}

export function tryRunText(command, args) {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
}

// ── usage ────────────────────────────────────────────────────────────────────

export function usage(exitCode = 0) {
	const stream = exitCode === 0 ? process.stdout : process.stderr;
	stream.write(
		"Usage: node scripts/ci/pr-auto-merge-execute.mjs --pr <number> --receipt <path> [options]\n\n",
	);
	stream.write(
		"Narrow auto-merge executor. Merges only with a fresh AUTO_MERGE_READY receipt.\n\n",
	);
	stream.write("Required:\n");
	stream.write("  --pr <number>              PR number to merge\n");
	stream.write(
		"  --receipt <path>           Path to eligibility receipt JSON\n\n",
	);
	stream.write("Options:\n");
	stream.write(
		"  --direct-merge              Use direct REST merge instead of native auto-merge\n",
	);
	stream.write("  --dry-run                   Inspect only; do not merge\n");
	stream.write("  --json                      JSON-only output\n");
	stream.write(
		"  --expected-base <branch>   Required base branch (default: main)\n",
	);
	stream.write("  --help                     Show this help\n");
	process.exit(exitCode);
}

// ── parse args ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
	const args = {
		directMerge: false,
		dryRun: false,
		expectedBase: "main",
		jsonOnly: false,
		pr: undefined,
		receipt: undefined,
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") usage(0);
		if (a === "--direct-merge") {
			args.directMerge = true;
			continue;
		}
		if (a === "--dry-run") {
			args.dryRun = true;
			continue;
		}
		if (a === "--json") {
			args.jsonOnly = true;
			continue;
		}
		if (a === "--pr") {
			args.pr = argv[++i];
			continue;
		}
		if (a === "--receipt") {
			args.receipt = argv[++i];
			continue;
		}
		if (a === "--expected-base") {
			args.expectedBase = argv[++i];
			continue;
		}
		throw new Error(`Unknown argument: ${a}`);
	}

	if (!args.pr || !/^\d+$/.test(args.pr))
		throw new Error("--pr <number> is required");
	if (!args.receipt) throw new Error("--receipt <path> is required");

	return args;
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function main() {
	const args = parseArgs(process.argv.slice(2));

	// 1. Read and validate receipt
	const receipt = readReceipt(args.receipt);
	if (!receipt.valid) {
		if (args.jsonOnly) {
			process.stdout.write(
				JSON.stringify({
					verdict: "BLOCKED",
					status: receipt.status,
					reason: receipt.reason,
				}) + "\n",
			);
		} else {
			process.stderr.write(`RECEIPT INVALID: ${receipt.reason}\n`);
		}
		process.exit(1);
	}

	// 2. Validate receipt matches target
	const blockers = [];

	if (Number(args.pr) !== receipt.pr) {
		blockers.push({
			status: BLOCKED_RECEIPT_PR_MISMATCH,
			reason: `receipt PR #${receipt.pr} != target PR #${args.pr}`,
		});
	}

	// 3. Query live PR state
	const pr = queryPr(args.pr);
	if (!pr) {
		blockers.push({
			status: ERROR_GITHUB_QUERY,
			reason: `Failed to query PR #${args.pr}`,
		});
	}

	// 4. Check live SHA matches receipt SHA
	if (pr && pr.headRefOid !== receipt.headSha) {
		blockers.push({
			status: BLOCKED_RECEIPT_SHA_MISMATCH,
			reason: `receipt SHA ${prShortSha(receipt.headSha)} != live SHA ${prShortSha(pr.headRefOid)}`,
		});
	}

	// 5. Check PR state
	if (pr && pr.state === "MERGED") {
		blockers.push({
			status: RECONCILE_ALREADY_MERGED,
			reason: "PR is already merged",
		});
	}

	if (pr && pr.state === "CLOSED") {
		blockers.push({
			status: BLOCKED_PR_CLOSED,
			reason: "PR is closed without being merged",
		});
	}

	// If already merged, emit reconciliation receipt
	if (blockers.some((b) => b.status === RECONCILE_ALREADY_MERGED)) {
		const recReceipt = {
			timestamp: new Date().toISOString(),
			pr: args.pr,
			status: RECONCILE_ALREADY_MERGED,
			mergeCommit: pr?.autoMergeRequest?.mergeCommit?.oid ?? null,
			state: pr?.state ?? "unknown",
			note: "PR was already merged. Verify merge commit on default branch if needed.",
		};
		process.stdout.write(JSON.stringify(recReceipt, null, 2) + "\n");
		process.exit(0);
	}

	// 6. Block on any pre-conditions
	if (blockers.length > 0) {
		if (args.jsonOnly) {
			process.stdout.write(
				JSON.stringify({ verdict: "BLOCKED", blockers }) + "\n",
			);
		} else {
			process.stderr.write(`BLOCKED:\n`);
			for (const b of blockers)
				process.stderr.write(`  - ${b.status}: ${b.reason}\n`);
		}
		process.exit(1);
	}

	// 7. Live re-probe using eligibility script
	const liveProbe = runLiveEligibility(
		args.pr,
		receipt.headSha,
		args.expectedBase,
	);
	if (
		!liveProbe ||
		(liveProbe.verdict !== "AUTO_MERGE_READY" &&
			liveProbe.status !== "AUTO_MERGE_READY")
	) {
		blockers.push({
			status: BLOCKED_LIVE_RECHECK,
			reason: `live eligibility check verdict: ${liveProbe?.verdict ?? liveProbe?.status ?? "ERROR"}`,
		});
	}

	if (blockers.length > 0) {
		if (args.jsonOnly) {
			process.stdout.write(
				JSON.stringify({ verdict: "BLOCKED", blockers }) + "\n",
			);
		} else {
			process.stderr.write(`BLOCKED:\n`);
			for (const b of blockers)
				process.stderr.write(`  - ${b.status}: ${b.reason}\n`);
		}
		process.exit(1);
	}

	// 8. Dry-run
	if (args.dryRun) {
		const dryReceipt = {
			timestamp: new Date().toISOString(),
			pr: args.pr,
			headSha: pr.headRefOid,
			receiptSha: receipt.headSha,
			receiptAge:
				((Date.now() - new Date(receipt.timestamp).getTime()) / 60000).toFixed(
					1,
				) + " min",
			liveEligibility: liveProbe?.verdict ?? liveProbe?.status,
			mergeMethod: args.directMerge ? "direct-squash" : "native-auto-merge",
			verdict: "DRY_RUN_OK",
		};
		process.stdout.write(JSON.stringify(dryReceipt, null, 2) + "\n");
		if (!args.jsonOnly) {
			process.stdout.write("\nDry-run: all gates passed. Would merge now.\n");
		}
		process.exit(0);
	}

	// 9. Perform merge
	const mergeBlockers = [];
	if (!args.directMerge) {
		// Prefer native auto-merge
		const nodeId = pr.autoMergeRequest?.pullRequest?.id;
		if (!nodeId) {
			// Need to get node ID from GraphQL
			const prData = tryRunJson("gh", [
				"api",
				"graphql",
				"-f",
				`query={ repository(owner: "SollanSystems", name: "buildplane") { pullRequest(number: ${args.pr}) { id } } }`,
			]);
			const prId = prData?.data?.repository?.pullRequest?.id;
			if (prId) {
				enableAutoMerge(prId, receipt.headSha);
			} else {
				mergeBlockers.push(missingNativeAutoMergePrIdBlocker(args.pr));
			}
		} else {
			enableAutoMerge(nodeId, receipt.headSha);
		}
	}

	if (mergeBlockers.length > 0) {
		if (args.jsonOnly) {
			process.stdout.write(
				JSON.stringify({ verdict: "BLOCKED", blockers: mergeBlockers }) + "\n",
			);
		} else {
			process.stderr.write(`BLOCKED:\n`);
			for (const b of mergeBlockers)
				process.stderr.write(`  - ${b.status}: ${b.reason}\n`);
		}
		process.exit(1);
	}

	if (args.directMerge) {
		directSquashMerge(
			args.pr,
			receipt.headSha,
			`Auto-merge PR #${args.pr} via Buildplane`,
		);
	}

	// 10. Post-merge verification
	const postMerge = verifyPostMerge(
		args.pr,
		receipt.headSha,
		args.expectedBase,
	);

	const postMergeVerified = isPostMergeVerified(postMerge);
	const execReceipt = {
		timestamp: new Date().toISOString(),
		pr: args.pr,
		headSha: pr.headRefOid,
		receiptSha: receipt.headSha,
		mergeMethod: args.directMerge ? "direct-squash" : "native-auto-merge",
		verdict: postMergeVerified
			? args.directMerge
				? EXEC_DIRECT_MERGED
				: EXEC_AUTO_MERGE_ENABLED
			: EXEC_MERGE_OK,
		postVerification: postMerge,
	};

	process.stdout.write(JSON.stringify(execReceipt, null, 2) + "\n");

	if (!postMergeVerified) {
		process.exit(1);
	}
}

// Only run main() when executed directly
const isMain =
	process.argv[1] &&
	(process.argv[1].endsWith("/pr-auto-merge-execute.mjs") ||
		process.argv[1].endsWith("\\pr-auto-merge-execute.mjs"));

if (isMain) {
	main().catch((err) => {
		process.stderr.write(`FATAL: ${err.message}\n`);
		process.exit(2);
	});
}
