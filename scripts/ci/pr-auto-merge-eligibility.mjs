#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BLOCKED_REVIEW = "BLOCKED_REVIEW";
export const BLOCKED_CHECKS = "BLOCKED_CHECKS";
export const BLOCKED_REVIEW_THREADS = "BLOCKED_REVIEW_THREADS";
export const BLOCKED_SHA_MISMATCH = "BLOCKED_SHA_MISMATCH";
export const BLOCKED_BASE_MISMATCH = "BLOCKED_BASE_MISMATCH";
export const BLOCKED_DEPLOYMENT_SIDE_EFFECT = "BLOCKED_DEPLOYMENT_SIDE_EFFECT";
export const BLOCKED_MERGE_STATE = "BLOCKED_MERGE_STATE";
export const BLOCKED_DRAFT = "BLOCKED_DRAFT";
export const BLOCKED_AUTO_MERGE_OPT_IN = "BLOCKED_AUTO_MERGE_OPT_IN";
export const AUTO_MERGE_READY = "AUTO_MERGE_READY";
export const RECONCILE_ALREADY_MERGED = "RECONCILE_ALREADY_MERGED";
export const ERROR_GITHUB_QUERY = "ERROR_GITHUB_QUERY";

const REVIEW_PASS_TOKENS = new Set(["PASS", "PASSED", "APPROVED", "LGTM"]);
const JSON_REVIEW_KEYS = [
	"verdict",
	"status",
	"decision",
	"reviewDecision",
	"result",
];

export function usage(exitCode = 0) {
	const stream = exitCode === 0 ? process.stdout : process.stderr;
	stream.write(
		`Usage: node scripts/ci/pr-auto-merge-eligibility.mjs --pr <number> [review source] [options]\n\n`,
	);
	stream.write(
		`Read-only PR auto-merge eligibility probe. Emits JSON and never merges.\n\n`,
	);
	stream.write(`Review source (one required):\n`);
	stream.write(
		`  --review-pass                 Assert an independent review receipt is PASS.\n`,
	);
	stream.write(
		`  --review-receipt <path>       Read a review receipt file and require a PASS-like verdict.\n\n`,
	);
	stream.write(`Options:\n`);
	stream.write(
		`  --pr <number>                 Pull request number to inspect.\n`,
	);
	stream.write(
		`  --expected-head <sha>          Required reviewed head SHA; block unless PR head equals it.\n`,
	);
	stream.write(
		`  --expected-base <branch>       Require the PR base branch to match the provided branch.\n`,
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
	stream.write(
		`  --required-label <label>       Required opt-in label. Default: buildplane:auto-merge.\n`,
	);
	stream.write(
		`  --allow-missing-label          Do not block if the opt-in label is absent.\n`,
	);
	stream.write(`  --json                         Emit JSON only.\n`);
	stream.write(`  --help                         Show this help.\n`);
	process.exit(exitCode);
}

export function parseArgs(argv) {
	const args = {
		allowDeployments: false,
		allowMissingLabel: false,
		allowNoChecks: false,
		expectedBase: undefined,
		expectedHead: undefined,
		jsonOnly: false,
		pr: undefined,
		requireGithubApproval: false,
		requiredLabel: "buildplane:auto-merge",
		reviewPass: false,
		reviewReceipt: undefined,
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
		if (arg === "--review-receipt") {
			args.reviewReceipt = argv[++index];
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
		if (arg === "--allow-missing-label") {
			args.allowMissingLabel = true;
			continue;
		}
		if (arg === "--required-label") {
			args.requiredLabel = argv[++index];
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
		if (arg === "--expected-base") {
			args.expectedBase = argv[++index];
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!args.pr || !/^\d+$/.test(args.pr)) {
		throw new Error("--pr <number> is required");
	}

	if (!args.requiredLabel || args.requiredLabel.trim() === "") {
		throw new Error("--required-label must not be empty");
	}

	if (args.reviewPass && args.reviewReceipt) {
		throw new Error("use either --review-pass or --review-receipt, not both");
	}

	if (!args.reviewPass && !args.reviewReceipt) {
		throw new Error(
			"one review source is required: --review-pass or --review-receipt",
		);
	}

	return args;
}

export function runJson(command, args) {
	const output = execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(output);
}

export function runText(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export function tryRunText(command, args) {
	try {
		return runText(command, args);
	} catch {
		return undefined;
	}
}

export function statusRollupItems(statusCheckRollup) {
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

export function checksVerdict(items, allowNoChecks) {
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

export function uniqueStatuses(blockers) {
	return [...new Set(blockers.map((blocker) => blocker.status))];
}

export function labelNames(labels) {
	if (Array.isArray(labels?.nodes)) return labelNames(labels.nodes);
	if (!Array.isArray(labels)) return [];
	return labels
		.map((label) => (typeof label === "string" ? label : label?.name))
		.filter((name) => typeof name === "string" && name.length > 0);
}

export function hasLabel(labels, requiredLabel) {
	return labelNames(labels).includes(requiredLabel);
}

function normalizeReviewToken(value) {
	return String(value ?? "")
		.trim()
		.toUpperCase();
}

function jsonReviewVerdict(data) {
	if (!data || typeof data !== "object" || Array.isArray(data))
		return undefined;
	for (const key of JSON_REVIEW_KEYS) {
		const value = data[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	if (typeof data.pass === "boolean") return data.pass ? "PASS" : "FAIL";
	if (typeof data.approved === "boolean")
		return data.approved ? "APPROVED" : "FAIL";
	if (typeof data.ok === "boolean") return data.ok ? "PASS" : "FAIL";
	return undefined;
}

export function readReviewReceipt(path) {
	if (!path || path.trim() === "") {
		return {
			asserted: false,
			reason: "review receipt path is empty",
			source: "review-receipt",
		};
	}
	if (!existsSync(path)) {
		return {
			asserted: false,
			reason: `review receipt not found: ${path}`,
			source: "review-receipt",
		};
	}

	const content = readFileSync(path, "utf8");
	const trimmed = content.trim();
	let verdict;
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			verdict = jsonReviewVerdict(JSON.parse(trimmed));
		} catch {
			verdict = undefined;
		}
	}
	if (!verdict) {
		const match = trimmed.match(/\b(PASS(?:ED)?|APPROVED|LGTM|FAIL(?:ED)?)\b/i);
		verdict = match?.[1];
	}
	const normalized = normalizeReviewToken(verdict);
	const asserted = REVIEW_PASS_TOKENS.has(normalized);
	return {
		asserted,
		reason: asserted
			? `review receipt indicates ${normalized}`
			: verdict
				? `review receipt indicates ${normalized}`
				: "review receipt does not contain a PASS-like verdict",
		source: path,
		verdict: normalized || undefined,
	};
}

export function reviewAssertionFromArgs(args) {
	if (args.reviewPass) {
		return {
			asserted: true,
			reason: "independent review PASS asserted by flag",
			source: "--review-pass",
			verdict: "PASS",
		};
	}
	return readReviewReceipt(args.reviewReceipt);
}

export function summarizeReviewThreads(reviewThreads) {
	const nodes = Array.isArray(reviewThreads?.nodes)
		? reviewThreads.nodes
		: Array.isArray(reviewThreads)
			? reviewThreads
			: [];
	const unresolved = nodes
		.filter((thread) => thread?.isResolved === false)
		.map((thread) => ({
			commentAuthor:
				thread.comments?.nodes?.[0]?.author?.login ??
				thread.comments?.[0]?.author?.login ??
				null,
			commentBody:
				thread.comments?.nodes?.[0]?.body ?? thread.comments?.[0]?.body ?? null,
			isOutdated: thread.isOutdated ?? false,
			line: thread.line ?? null,
			path: thread.path ?? null,
		}));
	return {
		total: nodes.length,
		unresolved,
		unresolvedCount: unresolved.length,
	};
}

export function determineResult({
	args,
	deployments,
	pr,
	reviewAssertion,
	reviewThreads,
	rollupItems,
}) {
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

	if (!reviewAssertion.asserted) {
		blockers.push({
			status: BLOCKED_REVIEW,
			reason: reviewAssertion.reason,
		});
	}

	if (args.requireGithubApproval && pr.reviewDecision !== "APPROVED") {
		blockers.push({
			status: BLOCKED_REVIEW,
			reason: `GitHub reviewDecision is ${pr.reviewDecision ?? "unknown"}`,
		});
	}

	if (!args.allowMissingLabel && !hasLabel(pr.labels, args.requiredLabel)) {
		blockers.push({
			status: BLOCKED_AUTO_MERGE_OPT_IN,
			reason: `missing required auto-merge opt-in label: ${args.requiredLabel}`,
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

	if (args.expectedBase && pr.baseRefName !== args.expectedBase) {
		blockers.push({
			status: BLOCKED_BASE_MISMATCH,
			reason: `expected base ${args.expectedBase} but PR base is ${pr.baseRefName}`,
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

	if (reviewThreads.unresolvedCount > 0) {
		blockers.push({
			status: BLOCKED_REVIEW_THREADS,
			reason: `${reviewThreads.unresolvedCount} unresolved review thread(s) remain`,
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

function formatDeployments(deployments) {
	return deployments.map((deployment) => ({
		created_at: deployment.created_at,
		environment: deployment.environment,
		id: deployment.id,
		ref: deployment.ref,
		sha: deployment.sha,
	}));
}

export function buildGithubErrorResult({ args, error, stage }) {
	return {
		autoMergeOptIn: {
			allowMissingLabel: args.allowMissingLabel,
			labelPresent: false,
			requiredLabel: args.requiredLabel,
		},
		blockers: [
			{
				reason: `${stage}: ${error instanceof Error ? error.message : String(error)}`,
				status: ERROR_GITHUB_QUERY,
			},
		],
		checks: {
			failing: [],
			observed: [],
			pending: [],
			reason: "GitHub query failed before checks could be evaluated",
			skipped: [],
		},
		deployments: [],
		eligible: false,
		pr: {
			baseRefName: null,
			headRefName: null,
			headRefOid: null,
			isDraft: null,
			labels: [],
			mergeStateStatus: null,
			number: Number(args.pr),
			reviewDecision: null,
			state: null,
			url: null,
			viewerCanEnableAutoMerge: null,
		},
		repository: null,
		review: {
			expectedBase: args.expectedBase ?? null,
			expectedHead: args.expectedHead ?? null,
			githubApprovalRequired: args.requireGithubApproval,
			reviewAssertion: reviewAssertionFromArgs(args),
			reviewThreads: { total: 0, unresolved: [], unresolvedCount: 0 },
		},
		status: ERROR_GITHUB_QUERY,
	};
}

function emitResult({ args, result, originMain }) {
	if (!args.jsonOnly) {
		process.stderr.write(`PR #${args.pr}: ${result.status}\n`);
		if (originMain) process.stderr.write(`origin/main: ${originMain}\n`);
		for (const blocker of result.blockers) {
			process.stderr.write(`- ${blocker.status}: ${blocker.reason}\n`);
		}
	}
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function main(argv = process.argv.slice(2)) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		process.stderr.write(`${error.message}\n\n`);
		usage(2);
	}

	const reviewAssertion = reviewAssertionFromArgs(args);
	const originMain = tryRunText("git", ["rev-parse", "--short", "origin/main"]);

	try {
		const pr = runJson("gh", [
			"pr",
			"view",
			args.pr,
			"--json",
			"number,state,isDraft,headRefOid,headRefName,baseRefName,mergeStateStatus,reviewDecision,statusCheckRollup,labels,url",
		]);
		const repo = runJson("gh", ["repo", "view", "--json", "nameWithOwner"]);
		const [owner, name] = String(repo.nameWithOwner).split("/");
		const reviewThreadQuery = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){viewerCanEnableAutoMerge reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:1){nodes{body author{login}}}}}}}}`;
		const graph = runJson("gh", [
			"api",
			"graphql",
			"-F",
			`owner=${owner}`,
			"-F",
			`repo=${name}`,
			"-F",
			`number=${args.pr}`,
			"-f",
			`query=${reviewThreadQuery}`,
		]);
		const graphPr = graph?.data?.repository?.pullRequest;
		const deploymentPath = `repos/${repo.nameWithOwner}/deployments?ref=${encodeURIComponent(pr.headRefOid)}&per_page=20`;
		const deployments = runJson("gh", ["api", deploymentPath]);
		const rollupItems = statusRollupItems(pr.statusCheckRollup);
		const reviewThreads = summarizeReviewThreads(graphPr?.reviewThreads);
		const verdict = determineResult({
			args,
			deployments,
			pr,
			reviewAssertion,
			reviewThreads,
			rollupItems,
		});
		const result = {
			autoMergeOptIn: {
				allowMissingLabel: args.allowMissingLabel,
				labelPresent: hasLabel(pr.labels, args.requiredLabel),
				requiredLabel: args.requiredLabel,
			},
			blockers: verdict.blockers,
			checks: {
				failing: verdict.checkState.failing,
				observed: rollupItems,
				pending: verdict.checkState.pending,
				reason: verdict.checkState.reason,
				skipped: verdict.checkState.skipped,
			},
			deployments: formatDeployments(deployments),
			eligible: verdict.eligible,
			pr: {
				baseRefName: pr.baseRefName,
				headRefName: pr.headRefName,
				headRefOid: pr.headRefOid,
				isDraft: pr.isDraft,
				labels: labelNames(pr.labels),
				mergeStateStatus: pr.mergeStateStatus,
				number: pr.number,
				reviewDecision: pr.reviewDecision,
				state: pr.state,
				url: pr.url,
				viewerCanEnableAutoMerge: graphPr?.viewerCanEnableAutoMerge ?? null,
			},
			repository: repo.nameWithOwner,
			review: {
				expectedBase: args.expectedBase ?? null,
				expectedHead: args.expectedHead ?? null,
				githubApprovalRequired: args.requireGithubApproval,
				reviewAssertion,
				reviewThreads,
			},
			status: verdict.status,
		};
		emitResult({ args, originMain, result });
		process.exit(verdict.eligible ? 0 : 1);
	} catch (error) {
		const result = buildGithubErrorResult({
			args,
			error,
			stage: "GitHub query failed",
		});
		emitResult({ args, originMain, result });
		process.exit(2);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
