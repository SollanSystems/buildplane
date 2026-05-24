#!/usr/bin/env node
/**
 * PR auto-merge opt-in helper.
 *
 * Read-only-first: dry-run mode inspects live PR state and prints intended
 * mutations without changing anything. Live mode applies the opt-in label
 * (and optionally marks draft ready), then re-queries and emits a receipt.
 *
 * Mutations allowed:
 *   - Create label `buildplane:auto-merge` if it does not exist on the repo
 *   - Add the label to the target PR
 *   - Optionally mark draft → ready if explicitly requested via --mark-ready
 *
 * Must NOT merge, enable auto-merge, approve reviews, create deployments,
 * delete branches, or mutate workflow state.
 */

import { execFileSync } from "node:child_process";

// ── constants ────────────────────────────────────────────────────────────────
const OPT_LABEL = "buildplane:auto-merge";

export const BLOCKED_REVIEW_THREADS = "BLOCKED_REVIEW_THREADS";
export const BLOCKED_CHECKS_PENDING = "BLOCKED_CHECKS_PENDING";
export const BLOCKED_DRAFT = "BLOCKED_DRAFT";
export const BLOCKED_SHA_MISMATCH = "BLOCKED_SHA_MISMATCH";
export const BLOCKED_SHA_MISSING = "BLOCKED_SHA_MISSING";
export const BLOCKED_ALREADY_MERGED = "BLOCKED_ALREADY_MERGED";
export const BLOCKED_DEPLOYMENT_SIDE_EFFECT = "BLOCKED_DEPLOYMENT_SIDE_EFFECT";
export const BLOCKED_DRY_RUN_DIVERGED = "BLOCKED_DRY_RUN_DIVERGED";
export const BLOCKED_OPT_IN_LABEL_MISSING = "BLOCKED_OPT_IN_LABEL_MISSING";
export const OPT_IN_OK = "OPT_IN_OK";
export const OPT_IN_DRY_RUN = "OPT_IN_DRY_RUN";
export const ERROR_GITHUB_QUERY = "ERROR_GITHUB_QUERY";

const PENDING_STATUSES = new Set([
	"QUEUED",
	"IN_PROGRESS",
	"PENDING",
	"REQUESTED",
	"WAITING",
	"pending",
]);

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

export function runText(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export function runStdout(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

export function labelNames(labels) {
	if (Array.isArray(labels?.nodes)) return labelNames(labels.nodes);
	if (!Array.isArray(labels)) return [];
	return labels
		.map((l) => (typeof l === "string" ? l : l?.name))
		.filter(Boolean);
}

export function hasCheckPending(items) {
	for (const item of items ?? []) {
		const status = item.status ?? item.state ?? "";
		if (PENDING_STATUSES.has(status)) return true;
		if (item.conclusion == null || item.conclusion === "") return true;
	}
	return false;
}

export function rollupItems(statusCheckRollup) {
	if (!Array.isArray(statusCheckRollup)) return [];
	return statusCheckRollup.map((item) => ({
		conclusion: item.conclusion ?? null,
		name: item.name ?? item.context ?? item.workflowName ?? "unknown",
		status: item.status ?? item.state ?? "UNKNOWN",
		type: item.__typename ?? "unknown",
	}));
}

export function summarizeReviewThreads(reviewThreads) {
	const nodes = Array.isArray(reviewThreads?.nodes)
		? reviewThreads.nodes
		: Array.isArray(reviewThreads)
			? reviewThreads
			: [];
	const unresolved = nodes
		.filter((t) => t?.isResolved === false)
		.map((t) => ({
			commentAuthor:
				t.comments?.nodes?.[0]?.author?.login ??
				t.comments?.[0]?.author?.login ??
				null,
			isOutdated: t.isOutdated ?? false,
			line: t.line ?? null,
			path: t.path ?? null,
		}));
	return {
		total: nodes.length,
		unresolved,
		unresolvedCount: unresolved.length,
	};
}

export function queryDeployments(headSha) {
	const result = tryRunJson("gh", [
		"api",
		`repos/SollanSystems/buildplane/deployments?ref=${headSha}&per_page=20`,
		"--jq",
		"[.[] | {id, ref, environment, task, created_at}]",
	]);
	return Array.isArray(result) ? result : [];
}

export function prShortSha(sha) {
	if (!sha || sha.length < 7) return sha;
	return sha.slice(0, 7);
}

// ── query ────────────────────────────────────────────────────────────────────

export function buildReviewThreadsGraphqlArgs(prNumber) {
	const query = `query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ reviewThreads(first:100){ nodes { isResolved isOutdated path line comments(first:1){ nodes { author { login } } } } } } } }`;
	return [
		"api",
		"graphql",
		"-f",
		"owner=SollanSystems",
		"-f",
		"repo=buildplane",
		"-F",
		`number=${prNumber}`,
		"-f",
		`query=${query}`,
	];
}

export function queryReviewThreads(prNumber) {
	const result = tryRunJson("gh", buildReviewThreadsGraphqlArgs(prNumber));
	return result?.data?.repository?.pullRequest?.reviewThreads;
}

export function queryPr(prNumber) {
	const json = tryRunJson("gh", [
		"pr",
		"view",
		prNumber,
		"-R",
		"SollanSystems/buildplane",
		"--json",
		"number,url,state,isDraft,baseRefName,headRefName," +
			"headRefOid,mergeable,mergeStateStatus,reviewDecision," +
			"autoMergeRequest,statusCheckRollup,labels",
	]);
	if (!json) return undefined;

	const reviewThreads = queryReviewThreads(prNumber);

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
		labels: labelNames(json.labels),
		reviewThreads: summarizeReviewThreads(reviewThreads),
		checks: rollupItems(json.statusCheckRollup),
		hasLabel: labelNames(json.labels).includes(OPT_LABEL),
	};
}

// ── label helpers ────────────────────────────────────────────────────────────

export function repoHasLabel() {
	const labels = tryRunJson("gh", [
		"label",
		"list",
		"-R",
		"SollanSystems/buildplane",
		"--json",
		"name",
		"--limit",
		"200",
	]);
	if (!Array.isArray(labels)) return undefined;
	return labels.some((l) => l.name === OPT_LABEL);
}

export function createLabel() {
	runStdout("gh", [
		"label",
		"create",
		OPT_LABEL,
		"-R",
		"SollanSystems/buildplane",
		"--description",
		"Explicit steward opt-in for Buildplane auto-merge eligibility",
		"--color",
		"2ea44f",
	]);
}

export function addLabel(prNumber) {
	runStdout("gh", [
		"pr",
		"edit",
		prNumber,
		"-R",
		"SollanSystems/buildplane",
		"--add-label",
		OPT_LABEL,
	]);
}

export function markReady(prNumber) {
	runStdout("gh", ["pr", "ready", prNumber, "-R", "SollanSystems/buildplane"]);
}

// ── pre-checks ───────────────────────────────────────────────────────────────

export function runPreChecks(pr, expectedHead, markReadyFlag = false) {
	const blockers = [];

	if (pr.state === "MERGED") {
		blockers.push({
			status: BLOCKED_ALREADY_MERGED,
			reason: "PR is already merged",
		});
	}
	if (pr.state === "CLOSED" && pr.state !== "MERGED") {
		blockers.push({ status: BLOCKED_ALREADY_MERGED, reason: "PR is closed" });
	}

	if (!expectedHead) {
		blockers.push({
			status: BLOCKED_SHA_MISSING,
			reason: "--expected-head is required",
		});
	} else if (expectedHead !== pr.headRefOid) {
		blockers.push({
			status: BLOCKED_SHA_MISMATCH,
			reason: `expected head ${prShortSha(expectedHead)} != live head ${prShortSha(pr.headRefOid)}`,
		});
	}

	// Only block draft if --mark-ready is NOT requested
	if (pr.isDraft && !markReadyFlag) {
		blockers.push({ status: BLOCKED_DRAFT, reason: "PR is draft" });
	}

	// Block when no checks are observed (checks-visible precondition)
	if (pr.checks.length === 0) {
		blockers.push({
			status: BLOCKED_CHECKS_PENDING,
			reason: "no checks observed",
		});
	}

	if (pr.reviewThreads.unresolvedCount > 0) {
		blockers.push({
			status: BLOCKED_REVIEW_THREADS,
			reason: `${pr.reviewThreads.unresolvedCount} unresolved review thread(s)`,
		});
	}

	if (hasCheckPending(pr.checks)) {
		blockers.push({
			status: BLOCKED_CHECKS_PENDING,
			reason: "one or more checks are pending",
		});
	}

	return blockers;
}

// ── mutations ────────────────────────────────────────────────────────────────

export function planMutations(pr) {
	const ops = [];

	if (!repoHasLabel()) {
		ops.push({
			op: "create-label",
			label: OPT_LABEL,
			reason: "label does not exist on repo",
		});
	}

	if (!pr.hasLabel) {
		ops.push({ op: "add-label", label: OPT_LABEL, target: `PR #${pr.number}` });
	}

	return ops;
}

export function applyMutations(pr, markReadyFlag) {
	const ops = [];

	if (!repoHasLabel()) {
		createLabel();
		ops.push({ op: "create-label", label: OPT_LABEL, success: true });
	}

	if (!pr.hasLabel) {
		addLabel(pr.number);
		ops.push({
			op: "add-label",
			label: OPT_LABEL,
			target: `PR #${pr.number}`,
			success: true,
		});
	}

	if (markReadyFlag && pr.isDraft) {
		markReady(pr.number);
		ops.push({ op: "mark-ready", target: `PR #${pr.number}`, success: true });
	}

	return ops;
}

// ── receipt ──────────────────────────────────────────────────────────────────

export function emitReceipt(pr, ops, expectedHead, dryRunMap, blockers) {
	const receipt = {
		timestamp: new Date().toISOString(),
		pr: pr.number,
		url: pr.url,
		base: pr.baseRefName,
		headRefName: pr.headRefName,
		headSha: pr.headRefOid,
		expectedHeadSha: expectedHead,
		headMatch: expectedHead === pr.headRefOid,
		state: pr.state,
		isDraft: pr.isDraft,
		mergeStateStatus: pr.mergeStateStatus,
		mergeable: pr.mergeable,
		reviewDecision: pr.reviewDecision,
		unresolvedReviewThreads: pr.reviewThreads.unresolvedCount,
		labels: pr.labels,
		hasOptInLabel: pr.labels.includes(OPT_LABEL),
		checksPending: hasCheckPending(pr.checks),
		checks: pr.checks.map((c) => ({
			name: c.name,
			conclusion: c.conclusion,
			status: c.status,
		})),
		deployments: dryRunMap.deployments ?? [],
		autoMergeRequest: pr.autoMergeRequest,
		mutations: ops,
		blockers: blockers.map((b) => ({ status: b.status, reason: b.reason })),
		verdict: blockers.length > 0 ? "BLOCKED" : "OPT_IN_OK",
		reconciliation: dryRunMap.reconciliation ?? null,
	};

	process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
	return receipt;
}

// ── usage ────────────────────────────────────────────────────────────────────

export function usage(exitCode = 0) {
	const stream = exitCode === 0 ? process.stdout : process.stderr;
	stream.write(
		"Usage: node scripts/ci/pr-auto-merge-opt-in.mjs --pr <number> --expected-head <sha> [options]\n\n",
	);
	stream.write(
		"Explicit operator opt-in for Buildplane auto-merge eligibility.\n\n",
	);
	stream.write("Required:\n");
	stream.write("  --pr <number>              PR number to inspect and label\n");
	stream.write(
		"  --expected-head <sha>      Verified head SHA; blocks if it differs from live PR head\n\n",
	);
	stream.write("Modes:\n");
	stream.write(
		"  --dry-run                  Inspect only; print intended mutations, do not apply\n",
	);
	stream.write("  --json                     JSON-only output\n\n");
	stream.write("Options:\n");
	stream.write(
		"  --mark-ready               Mark draft PR as ready before opting in\n",
	);
	stream.write(
		"  --allow-deployments        Do not block if deployment objects exist\n",
	);
	stream.write("  --help                     Show this help\n");
	process.exit(exitCode);
}

// ── parse args ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
	const args = {
		allowDeployments: false,
		dryRun: false,
		expectedHead: undefined,
		jsonOnly: false,
		markReady: false,
		pr: undefined,
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") usage(0);
		if (a === "--dry-run") {
			args.dryRun = true;
			continue;
		}
		if (a === "--json") {
			args.jsonOnly = true;
			continue;
		}
		if (a === "--mark-ready") {
			args.markReady = true;
			continue;
		}
		if (a === "--allow-deployments") {
			args.allowDeployments = true;
			continue;
		}
		if (a === "--pr") {
			args.pr = argv[++i];
			continue;
		}
		if (a === "--expected-head") {
			args.expectedHead = argv[++i];
			continue;
		}
		throw new Error(`Unknown argument: ${a}`);
	}

	if (!args.pr || !/^\d+$/.test(args.pr))
		throw new Error("--pr <number> is required");
	if (!args.expectedHead) throw new Error("--expected-head <sha> is required");

	return args;
}

// ── main ─────────────────────────────────────────────────────────────────────

export function postMutationSafetyBlockers(pr, prAfter, markReadyFlag = false) {
	const postBlockers = [];
	const reconciliation = [];
	if (!prAfter) {
		postBlockers.push({
			status: ERROR_GITHUB_QUERY,
			reason: "Failed to re-query PR after opt-in mutations",
		});
		return { postBlockers, reconciliation };
	}
	if (prAfter.headRefOid !== pr.headRefOid) {
		postBlockers.push({
			status: BLOCKED_DRY_RUN_DIVERGED,
			reason: `PR head changed during opt-in: ${pr.headRefOid} → ${prAfter.headRefOid}`,
		});
		reconciliation.push(
			"PR head changed during opt-in. Re-run eligibility probe.",
		);
	}
	if (prAfter.isDraft && markReadyFlag) {
		postBlockers.push({
			status: BLOCKED_DRAFT,
			reason: "PR is still draft after --mark-ready",
		});
		reconciliation.push(
			"PR remained draft after mark-ready. Verify permissions and draft state.",
		);
	}
	if (prAfter.isDraft !== pr.isDraft && !markReadyFlag) {
		// Ready→draft would be unexpected; draft→ready without --mark-ready is also unexpected
		postBlockers.push({
			status: BLOCKED_DRY_RUN_DIVERGED,
			reason: `PR draft state changed during opt-in: ${pr.isDraft} → ${prAfter.isDraft}`,
		});
		reconciliation.push(
			"PR draft state changed unexpectedly. Verify whether this was intentional.",
		);
	}
	if (prAfter.state !== pr.state) {
		postBlockers.push({
			status: BLOCKED_DRY_RUN_DIVERGED,
			reason: `PR state changed during opt-in: ${pr.state} → ${prAfter.state}`,
		});
		reconciliation.push(
			`PR state changed from ${pr.state} to ${prAfter.state}. Re-inspect before proceeding.`,
		);
	}
	if (!prAfter.hasLabel) {
		postBlockers.push({
			status: BLOCKED_OPT_IN_LABEL_MISSING,
			reason: `Opt-in label ${OPT_LABEL} is missing after mutation`,
		});
		reconciliation.push(
			"Opt-in label is missing after mutation. Re-apply or investigate concurrent label changes before proceeding.",
		);
	}
	return { postBlockers, reconciliation };
}

export async function main() {
	const args = parseArgs(process.argv.slice(2));

	// Query live PR state
	const pr = queryPr(args.pr);
	if (!pr) {
		const err = {
			status: ERROR_GITHUB_QUERY,
			reason: `Failed to query PR #${args.pr}`,
		};
		process.stderr.write(JSON.stringify(err) + "\n");
		process.exit(1);
	}

	// Query deployments
	const deployments = queryDeployments(args.expectedHead);
	const deployBlocked = deployments.length > 0 && !args.allowDeployments;

	// Run pre-checks
	const blockers = runPreChecks(pr, args.expectedHead, args.markReady);
	if (deployBlocked) {
		blockers.push({
			status: BLOCKED_DEPLOYMENT_SIDE_EFFECT,
			reason: `${deployments.length} deployment object(s) exist for head SHA`,
		});
	}

	// Dry-run: print plan only
	if (args.dryRun) {
		let mutations = planMutations(pr);
		// Include mark-ready in planned mutations if applicable
		if (args.markReady && pr.isDraft) {
			mutations = [
				...mutations,
				{ op: "mark-ready", target: `PR #${args.pr}` },
			];
		}
		const dryRunMap = {
			deployments,
			dryRun: true,
			plannedMutations: mutations,
			blockers,
		};
		if (args.jsonOnly) {
			emitReceipt(pr, mutations, args.expectedHead, dryRunMap, blockers);
		} else {
			process.stdout.write(`\n=== DRY RUN for PR #${args.pr} ===\n`);
			process.stdout.write(`PR state:      ${pr.state}\n`);
			process.stdout.write(`Draft:         ${pr.isDraft}\n`);
			process.stdout.write(`Head SHA:      ${pr.headRefOid}\n`);
			process.stdout.write(`Base:          ${pr.baseRefName}\n`);
			process.stdout.write(
				`Labels:        ${pr.labels.join(", ") || "(none)"}\n`,
			);
			process.stdout.write(
				`Review threads: ${pr.reviewThreads.unresolvedCount} unresolved\n`,
			);
			process.stdout.write(`Has opt-in:    ${pr.hasLabel}\n`);
			process.stdout.write(`Deployments:   ${deployments.length}\n\n`);

			if (blockers.length > 0) {
				process.stdout.write(`BLOCKERS (${blockers.length}):\n`);
				for (const b of blockers)
					process.stdout.write(`  - ${b.status}: ${b.reason}\n`);
				process.stdout.write("\nNo mutations would be applied.\n");
			} else {
				process.stdout.write(`PLANNED MUTATIONS (${mutations.length}):\n`);
				for (const m of mutations)
					process.stdout.write(`  - [${m.op}] ${m.label ?? m.target}\n`);
			}
			emitReceipt(pr, mutations, args.expectedHead, dryRunMap, blockers);
		}

		if (blockers.length > 0) process.exit(1);
		process.exit(0);
	}

	// Live mode: only apply if no blockers
	if (blockers.length > 0) {
		emitReceipt(pr, [], args.expectedHead, { deployments }, blockers);
		if (!args.jsonOnly) {
			process.stderr.write(
				`BLOCKED: ${blockers.map((b) => b.status).join(", ")}\n`,
			);
		}
		process.exit(1);
	}

	// Apply mutations
	const ops = applyMutations(pr, args.markReady);

	// Re-query to confirm state
	const prAfter = queryPr(args.pr);
	const deploymentsAfter = queryDeployments(args.expectedHead);

	// Verify no unexpected side effects
	const { postBlockers, reconciliation } = postMutationSafetyBlockers(
		pr,
		prAfter,
		args.markReady,
	);

	// Compare deployments before and after
	if (!args.allowDeployments) {
		const beforeIds = new Set(deployments.map((d) => d.id));
		const newDeployments = (deploymentsAfter ?? []).filter(
			(d) => !beforeIds.has(d.id),
		);
		if (newDeployments.length > 0) {
			postBlockers.push({
				status: BLOCKED_DEPLOYMENT_SIDE_EFFECT,
				reason: `${newDeployments.length} new deployment object(s) appeared during opt-in`,
			});
			reconciliation.push(
				"New deployments appeared. Verify no side effects from opt-in before considering merge.",
			);
		}
	}

	const finalPr = prAfter ?? pr;
	const dryRunMap = {
		deployments: deploymentsAfter,
		postMutation: true,
		postBlockers,
		reconciliation,
	};

	emitReceipt(finalPr, ops, args.expectedHead, dryRunMap, postBlockers);

	if (postBlockers.length > 0) process.exit(1);
}

// Only run main() when executed directly (not imported by vitest/etc.)
const isMain =
	process.argv[1] &&
	(process.argv[1].endsWith("/pr-auto-merge-opt-in.mjs") ||
		process.argv[1].endsWith("\\pr-auto-merge-opt-in.mjs"));

if (isMain) {
	main().catch((err) => {
		process.stderr.write(`FATAL: ${err.message}\n`);
		process.exit(2);
	});
}
