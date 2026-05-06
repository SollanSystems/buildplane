import type { CapabilityGrant, SideEffectReceipt } from "@buildplane/kernel";

export type GitHubCheckConclusion =
	| "success"
	| "failure"
	| "neutral"
	| "cancelled"
	| "skipped"
	| "timed_out"
	| "action_required";

export interface PrCheckIssueLike {
	readonly code?: string;
	readonly message?: string;
}

export interface PrCheckFinalVerdictReport {
	readonly runId: string;
	readonly verdict: string;
	readonly receipts?: unknown;
	readonly criteria?: unknown;
	readonly issues?: readonly PrCheckIssueLike[];
}

export interface PrCheckOperation {
	readonly method: "POST";
	readonly path: string;
	readonly body: {
		readonly name: string;
		readonly head_sha: string;
		readonly status: "completed";
		readonly conclusion: GitHubCheckConclusion;
		readonly external_id: string;
		readonly details_url?: string;
		readonly output: {
			readonly title: string;
			readonly summary: string;
			readonly text: string;
		};
	};
}

export interface PlannedPrCheck {
	readonly mode: "dry-run";
	readonly operation: PrCheckOperation;
	readonly sideEffect: SideEffectReceipt;
}

export interface PublishedPrCheck {
	readonly mode: "published";
	readonly operation: PrCheckOperation;
	readonly sideEffect: SideEffectReceipt;
	readonly grantId: string;
	readonly response: unknown;
}

export type PrCheckRequest = (
	operation: PrCheckOperation,
	options: { readonly credential: string },
) => Promise<unknown>;

export interface PlanPrCheckOptions {
	readonly report: PrCheckFinalVerdictReport;
	readonly repository: string;
	readonly headSha: string;
	readonly name?: string;
	readonly detailsUrl?: string;
}

export type PrCheckCredentialProvider = () => string | undefined;

export interface PublishPrCheckOptions extends PlanPrCheckOptions {
	readonly grants: readonly CapabilityGrant[];
	readonly grantId: string;
	readonly credential: PrCheckCredentialProvider;
	readonly request: PrCheckRequest;
}

interface ParsedRepository {
	readonly owner: string;
	readonly repo: string;
	readonly target: string;
}

const PUBLISH_CAPABILITY = "github.pr_check";
const PUBLISH_ACTION = "publish";
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const URL_SEMANTIC_DELIMITERS = new Set(["/", "?", "#", "%", "\\"]);

export function planPrCheckOperation(
	options: PlanPrCheckOptions,
): PlannedPrCheck {
	const repository = parseRepository(options.repository);
	const name = options.name?.trim() || "Buildplane";
	const conclusion = mapFinalVerdictToCheckConclusion(options.report.verdict);
	const operation: PrCheckOperation = {
		method: "POST",
		path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/check-runs`,
		body: {
			name,
			head_sha: options.headSha,
			status: "completed",
			conclusion,
			external_id: options.report.runId,
			...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
			output: {
				title: `${name}: ${options.report.verdict}`,
				summary: summarizeReport(options.report, conclusion),
				text: formatReportDetails(options.report),
			},
		},
	};

	return {
		mode: "dry-run",
		operation,
		sideEffect: buildPublishSideEffect({
			runId: options.report.runId,
			repository,
		}),
	};
}

export async function publishPrCheckOperation(
	options: PublishPrCheckOptions,
): Promise<PublishedPrCheck> {
	const planned = planPrCheckOperation(options);
	const authorizedSideEffect = authorizePrCheckPublish({
		sideEffect: planned.sideEffect,
		grants: options.grants,
		grantId: options.grantId,
	});
	const credential = (options.credential() ?? "").trim();
	if (!credential) {
		throw new Error("Missing GitHub credential for pr-check publish.");
	}
	const response = await options.request(planned.operation, { credential });
	return {
		mode: "published",
		operation: planned.operation,
		sideEffect: authorizedSideEffect,
		grantId: authorizedSideEffect.grantId ?? options.grantId.trim(),
		response,
	};
}

export function authorizePrCheckPublish(options: {
	readonly sideEffect: SideEffectReceipt;
	readonly grants: readonly CapabilityGrant[];
	readonly grantId: string;
}): SideEffectReceipt {
	const grantId = options.grantId.trim();
	if (!grantId) {
		throw unauthorizedPublishError(options.sideEffect, "missing grant id");
	}
	const sideEffect: SideEffectReceipt = {
		...options.sideEffect,
		grantId,
	};
	const grant = options.grants.find((candidate) =>
		matchesGrant(sideEffect, candidate),
	);
	if (!grant) {
		throw unauthorizedPublishError(sideEffect, "no matching capability grant");
	}
	return sideEffect;
}

export function loadCapabilityGrantsFromJson(raw: unknown): CapabilityGrant[] {
	let grants: unknown;
	if (Array.isArray(raw)) {
		grants = raw;
	} else {
		const record = asRecord(raw, "grant file");
		const rawGrants =
			record.capabilityGrants ?? record.grants ?? record.profile;
		grants = Array.isArray(rawGrants)
			? rawGrants
			: asRecord(rawGrants, "grant profile").capabilityGrants;
	}
	if (!Array.isArray(grants)) {
		throw new Error(
			"Grant file must be an array of grants or an object with capabilityGrants/grants.",
		);
	}
	return grants.map((grant, index) => parseCapabilityGrant(grant, index));
}

export function mapFinalVerdictToCheckConclusion(
	verdict: string,
): GitHubCheckConclusion {
	switch (verdict) {
		case "PASSED":
			return "success";
		case "BLOCKED":
			return "action_required";
		case "FAILED":
		case "UNSAFE_TO_RUN":
			return "failure";
		default:
			return "failure";
	}
}

export async function defaultPrCheckRequest(
	operation: PrCheckOperation,
	options: { readonly credential: string },
): Promise<unknown> {
	const response = await fetch(`https://api.github.com${operation.path}`, {
		method: operation.method,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${options.credential}`,
			"Content-Type": "application/json",
			"User-Agent": "buildplane-cli",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify(operation.body),
	});
	const bodyText = await response.text();
	const body = parseResponseBody(bodyText);
	if (!response.ok) {
		throw new Error(
			`GitHub check-run publish failed: ${response.status} ${response.statusText}`,
		);
	}
	return { status: response.status, ok: response.ok, body };
}

export function formatPrCheckHuman(
	result: PlannedPrCheck | PublishedPrCheck,
): string[] {
	return [
		`pr-check: ${result.mode}`,
		`operation: ${result.operation.method} ${result.operation.path}`,
		`check: ${result.operation.body.name}`,
		`run-id: ${result.operation.body.external_id}`,
		`head-sha: ${result.operation.body.head_sha}`,
		`conclusion: ${result.operation.body.conclusion}`,
		"operation-json:",
		JSON.stringify(result.operation, null, 2),
	];
}

function buildPublishSideEffect(options: {
	readonly runId: string;
	readonly repository: ParsedRepository;
}): SideEffectReceipt {
	return {
		id: `side-effect-pr-check-publish-${options.runId}`,
		capability: PUBLISH_CAPABILITY,
		action: PUBLISH_ACTION,
		target: options.repository.target,
	};
}

function matchesGrant(
	sideEffect: SideEffectReceipt,
	grant: CapabilityGrant,
): boolean {
	if (!sideEffect.grantId || grant.id !== sideEffect.grantId) return false;
	return (
		grant.capability === sideEffect.capability &&
		matchesGrantScope(sideEffect.action, grant.actions) &&
		matchesGrantScope(sideEffect.target, grant.targets)
	);
}

function matchesGrantScope(
	value: string,
	allowedValues: readonly string[],
): boolean {
	return allowedValues.includes("*") || allowedValues.includes(value);
}

function unauthorizedPublishError(
	sideEffect: SideEffectReceipt,
	reason: string,
): Error {
	return new Error(
		`UNSAFE_TO_RUN: pr-check publish ${sideEffect.capability}.${sideEffect.action} target ${sideEffect.target} is not authorized (${reason}); matching capability grant required before GitHub is called.`,
	);
}

function summarizeReport(
	report: PrCheckFinalVerdictReport,
	conclusion: GitHubCheckConclusion,
): string {
	const issueCodes =
		report.issues
			?.map((issue) => issue.code)
			.filter(
				(code): code is string => typeof code === "string" && code.length > 0,
			) ?? [];
	const issueClause =
		issueCodes.length > 0 ? ` Issues: ${issueCodes.join(", ")}.` : "";
	return `Final verdict ${report.verdict} for run ${report.runId}; GitHub conclusion ${conclusion}.${issueClause}`;
}

function formatReportDetails(report: PrCheckFinalVerdictReport): string {
	return JSON.stringify(
		{
			runId: report.runId,
			verdict: report.verdict,
			receipts: report.receipts,
			criteria: report.criteria,
			issues: report.issues,
		},
		null,
		2,
	);
}

function parseRepository(repository: string): ParsedRepository {
	if (repository !== repository.trim()) {
		throw new Error(
			"Repository must be in owner/repo form without surrounding whitespace.",
		);
	}
	const [owner, repo, ...extra] = repository.split("/");
	if (!owner || !repo || extra.length > 0) {
		throw new Error("Repository must be in owner/repo form.");
	}
	if (!isSafeGitHubOwner(owner)) {
		throw new Error(
			"Repository owner must be a GitHub-safe slug without URL delimiters or dot segments.",
		);
	}
	if (!isSafeGitHubRepositoryName(repo)) {
		throw new Error(
			"Repository name must be a GitHub-safe slug without URL delimiters or dot segments.",
		);
	}
	return { owner, repo, target: `repo:${owner}/${repo}` };
}

function isSafeGitHubOwner(owner: string): boolean {
	return (
		!hasUrlSemanticDelimiterOrControlCharacter(owner) &&
		owner !== "." &&
		owner !== ".." &&
		GITHUB_OWNER_PATTERN.test(owner)
	);
}

function isSafeGitHubRepositoryName(repo: string): boolean {
	return (
		!hasUrlSemanticDelimiterOrControlCharacter(repo) &&
		repo !== "." &&
		repo !== ".." &&
		GITHUB_REPO_PATTERN.test(repo)
	);
}

function hasUrlSemanticDelimiterOrControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (
			code <= 0x20 ||
			code === 0x7f ||
			URL_SEMANTIC_DELIMITERS.has(character)
		) {
			return true;
		}
	}
	return false;
}

function parseCapabilityGrant(raw: unknown, index: number): CapabilityGrant {
	const record = asRecord(raw, `grant[${index}]`);
	const id = readString(record.id, `grant[${index}].id`);
	const capability = readString(
		record.capability,
		`grant[${index}].capability`,
	);
	const actions = readStringArray(record.actions, `grant[${index}].actions`);
	const targets = readStringArray(record.targets, `grant[${index}].targets`);
	return { id, capability, actions, targets };
}

function readString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string.`);
	}
	return value;
}

function readStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`${label} must be an array of strings.`);
	}
	return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function parseResponseBody(bodyText: string): unknown {
	if (!bodyText.trim()) return undefined;
	try {
		return JSON.parse(bodyText);
	} catch {
		return bodyText;
	}
}
