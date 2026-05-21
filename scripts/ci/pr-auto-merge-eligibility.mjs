#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const BLOCKED_REVIEW = "BLOCKED_REVIEW";
const BLOCKED_CHECKS = "BLOCKED_CHECKS";
const BLOCKED_SHA_MISMATCH = "BLOCKED_SHA_MISMATCH";
const BLOCKED_DEPLOYMENT_SIDE_EFFECT = "BLOCKED_DEPLOYMENT_SIDE_EFFECT";
const BLOCKED_MERGE_STATE = "BLOCKED_MERGE_STATE";
const BLOCKED_DRAFT = "BLOCKED_DRAFT";
const AUTO_MERGE_READY = "AUTO_MERGE_READY";
const RECONCILE_ALREADY_MERGED = "RECONCILE_ALREADY_MERGED";

function usage(exitCode = 0) {
	const stream = exitCode === 0 ? process.stdout : process.stderr;
	stream.write(
		`Usage: node scripts/ci/pr-auto-merge-eligibility.mjs --pr <number> --review-pass [options]\n\n`,
	);
	stream.write(
		`Read-only PR auto-merge eligibility probe. Emits JSON and never merges.\n\n`,
	);
	stream.write(`Options:\n`);
	stream.write(
		`  --pr <number>                 Pull request number to inspect.\n`,
	);
	stream.write(
		`  --expected-head <sha>          Required reviewed head SHA; block unless PR head equals it.\n`,
	);
	stream.write(
		`  --review-pass                 Assert an independent review receipt is PASS.\n`,
	);
	stream.write(
		`  --require-github-approval      Also require GitHub reviewDecision=APPROVED.\n`,
	);
	stream.write(
		`  --allow-no-checks              Do not block open PRs with no observed checks.\n`,
	);
	stream.write(
		`  --allow-deployments            Do not block if deployment objects exist for the head SHA.\n`,
	);
	stream.write(`  --json                         Emit JSON only.\n`);
	stream.write(`  --help                         Show this help.\n`);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const args = {
		allowDeployments: false,
		allowNoChecks: false,
		expectedHead: undefined,
		jsonOnly: false,
		pr: undefined,
		requireGithubApproval: false,
		reviewPass: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") usage(0);
		if (arg === "--json") {
			args.jsonOnly = true;
			continue;
		}
		if (arg === "--review-pass") {
			args.reviewPass = true;
			continue;
		}
		if (arg === "--require-github-approval") {
			args.requireGithubApproval = true;
			continue;
		}
		if (arg === "--allow-no-checks") {
			args.allowNoChecks = true;
			continue;
		}
		if (arg === "--allow-deployments") {
			args.allowDeployments = true;
			continue;
		}
		if (arg === "--pr") {
			args.pr = argv[++index];
			continue;
		}
		if (arg === "--expected-head") {
			args.expectedHead = argv[++index];
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!args.pr || !/^\d+$/.test(args.pr)) {
		throw new Error("--pr <number> is required");
	}

	return args;
}

function runJson(command, args) {
	const output = execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(output);
}

function runText(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function tryRunText(command, args) {
	try {
		return runText(command, args);
	} catch {
		return undefined;
	}
}

function statusRollupItems(statusCheckRollup) {
	if (!Array.isArray(statusCheckRollup)) return [];
	return statusCheckRollup.map((item) => {
		const name =
			item.name ??
			item.context ??
			item.workflowName ??
			item.__typename ??
			"unknown";
		const status = item.status ?? item.state ?? "UNKNOWN";
		const conclusion = item.conclusion ?? item.state ?? null;
		return { conclusion, name, status, type: item.__typename ?? "unknown" };
	});
}

function checksVerdict(items, allowNoChecks) {
	if (items.length === 0) {
		return allowNoChecks
			? {
					ok: true,
					pending: [],
					failing: [],
					skipped: [],
					reason: "no checks observed; allowed by flag",
				}
			: {
					ok: false,
					pending: [],
					failing: [],
					skipped: [],
					reason: "no checks observed",
				};
	}

	const terminalSuccess = new Set([
		"SUCCESS",
		"success",
		"neutral",
		"NEUTRAL",
		"skipped",
		"SKIPPED",
	]);
	const terminalSkipped = new Set(["skipped", "SKIPPED", "neutral", "NEUTRAL"]);
	const pendingStatuses = new Set([
		"QUEUED",
		"IN_PROGRESS",
		"PENDING",
		"REQUESTED",
		"WAITING",
		"pending",
	]);
	const pending = [];
	const failing = [];
	const skipped = [];

	for (const item of items) {
		const status = item.status ?? "UNKNOWN";
		const conclusion = item.conclusion;
		if (terminalSkipped.has(conclusion)) skipped.push(item);
		if (
			pendingStatuses.has(status) ||
			conclusion === null ||
			conclusion === undefined ||
			conclusion === ""
		) {
			pending.push(item);
			continue;
		}
		if (!terminalSuccess.has(conclusion)) failing.push(item);
	}

	return {
		failing,
		ok: pending.length === 0 && failing.length === 0,
		pending,
		reason:
			pending.length > 0
				? "checks pending"
				: failing.length > 0
					? "checks failing"
					: "all observed checks passed",
		skipped,
	};
}

function uniqueStatuses(blockers) {
	return [...new Set(blockers.map((blocker) => blocker.status))];
}

function determineResult({ args, deployments, pr, rollupItems }) {
	const blockers = [];
	const checkState = checksVerdict(rollupItems, args.allowNoChecks);

	if (pr.state === "MERGED" || pr.state === "CLOSED") {
		blockers.push({
			status: RECONCILE_ALREADY_MERGED,
			reason: `PR state is ${pr.state}`,
		});
		return {
			blockers,
			checkState,
			eligible: false,
			status: RECONCILE_ALREADY_MERGED,
		};
	}

	if (!args.reviewPass) {
		blockers.push({
			status: BLOCKED_REVIEW,
			reason: "independent review PASS was not asserted",
		});
	}

	if (args.requireGithubApproval && pr.reviewDecision !== "APPROVED") {
		blockers.push({
			status: BLOCKED_REVIEW,
			reason: `GitHub reviewDecision is ${pr.reviewDecision ?? "unknown"}`,
		});
	}

	if (!args.expectedHead) {
		blockers.push({
			reason: "reviewed head SHA was not provided with --expected-head",
			status: BLOCKED_SHA_MISMATCH,
		});
	} else if (pr.headRefOid !== args.expectedHead) {
		blockers.push({
			reason: `expected head ${args.expectedHead} but PR head is ${pr.headRefOid}`,
			status: BLOCKED_SHA_MISMATCH,
		});
	}

	if (pr.isDraft) {
		blockers.push({ status: BLOCKED_DRAFT, reason: "PR is draft" });
	}

	if (!["CLEAN", "HAS_HOOKS"].includes(pr.mergeStateStatus)) {
		blockers.push({
			status: BLOCKED_MERGE_STATE,
			reason: `mergeStateStatus is ${pr.mergeStateStatus ?? "unknown"}`,
		});
	}

	if (!checkState.ok) {
		blockers.push({ status: BLOCKED_CHECKS, reason: checkState.reason });
	}

	if (!args.allowDeployments && deployments.length > 0) {
		blockers.push({
			reason: `${deployments.length} deployment object(s) exist for PR head`,
			status: BLOCKED_DEPLOYMENT_SIDE_EFFECT,
		});
	}

	const eligible = blockers.length === 0;
	return {
		blockers,
		checkState,
		eligible,
		status: eligible ? AUTO_MERGE_READY : uniqueStatuses(blockers)[0],
	};
}

function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error.message}\n\n`);
		usage(2);
	}

	const pr = runJson("gh", [
		"pr",
		"view",
		args.pr,
		"--json",
		"number,state,isDraft,headRefOid,headRefName,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup,url",
	]);
	const repo = runJson("gh", ["repo", "view", "--json", "nameWithOwner"]);
	const deploymentPath = `repos/${repo.nameWithOwner}/deployments?ref=${encodeURIComponent(pr.headRefOid)}&per_page=20`;
	const deployments = runJson("gh", ["api", deploymentPath]);
	const originMain = tryRunText("git", ["rev-parse", "--short", "origin/main"]);
	const rollupItems = statusRollupItems(pr.statusCheckRollup);
	const verdict = determineResult({ args, deployments, pr, rollupItems });

	const result = {
		blockers: verdict.blockers,
		checks: {
			failing: verdict.checkState.failing,
			observed: rollupItems,
			pending: verdict.checkState.pending,
			reason: verdict.checkState.reason,
			skipped: verdict.checkState.skipped,
		},
		deployments: deployments.map((deployment) => ({
			created_at: deployment.created_at,
			environment: deployment.environment,
			id: deployment.id,
			ref: deployment.ref,
			sha: deployment.sha,
		})),
		eligible: verdict.eligible,
		pr: {
			baseRefName: pr.baseRefName,
			headRefName: pr.headRefName,
			headRefOid: pr.headRefOid,
			isDraft: pr.isDraft,
			mergeStateStatus: pr.mergeStateStatus,
			number: pr.number,
			reviewDecision: pr.reviewDecision,
			state: pr.state,
			url: pr.url,
		},
		repository: repo.nameWithOwner,
		status: verdict.status,
	};

	if (!args.jsonOnly) {
		process.stderr.write(`PR #${pr.number}: ${result.status}\n`);
		if (originMain) process.stderr.write(`origin/main: ${originMain}\n`);
		for (const blocker of result.blockers) {
			process.stderr.write(`- ${blocker.status}: ${blocker.reason}\n`);
		}
	}
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	process.exit(verdict.eligible ? 0 : 1);
}

main();
