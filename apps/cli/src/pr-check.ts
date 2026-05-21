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

export interface PrCheckCriterionLike {
	readonly id?: string;
	readonly label?: string;
	readonly status?: string;
}

export interface PrCheckFinalVerdictReport {
	readonly runId: string;
	readonly verdict: string;
	readonly receipts?: unknown;
	readonly criteria?: readonly PrCheckCriterionLike[];
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

export interface PrCommentOperation {
	readonly method: "POST";
	readonly path: string;
	readonly body: {
		readonly body: string;
	};
}

export interface PrCommentPreflightOperation {
	readonly method: "GET";
	readonly path: string;
}

export interface PrHeadVerificationResult {
	readonly number: number;
	readonly headSha: string;
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

export interface PlannedPrComment {
	readonly mode: "dry-run";
	readonly preflight: PrCommentPreflightOperation;
	readonly operation: PrCommentOperation;
	readonly sideEffect: SideEffectReceipt;
}

export interface PublishedPrComment {
	readonly mode: "published";
	readonly preflight: PrCommentPreflightOperation;
	readonly operation: PrCommentOperation;
	readonly sideEffect: SideEffectReceipt;
	readonly grantId: string;
	readonly verifiedHead: PrHeadVerificationResult;
	readonly response: unknown;
}

export type PrCheckRequest = (
	operation: PrCheckOperation,
	options: { readonly credential: string },
) => Promise<unknown>;

export type PrCommentRequest = (
	operation: PrCommentOperation,
	options: { readonly credential: string },
) => Promise<unknown>;

export type PrHeadVerifier = (
	operation: PrCommentPreflightOperation,
	options: { readonly credential: string },
) => Promise<PrHeadVerificationResult>;

export interface PlanPrCheckOptions {
	readonly report: PrCheckFinalVerdictReport;
	readonly repository: string;
	readonly headSha: string;
	readonly name?: string;
	readonly detailsUrl?: string;
	readonly bundleUrl?: string;
}

export interface PlanPrCommentOptions extends PlanPrCheckOptions {
	readonly prNumber: number;
}

export type PrCheckCredentialProvider = () => string | undefined;

export interface PublishPrCheckOptions extends PlanPrCheckOptions {
	readonly grants: readonly CapabilityGrant[];
	readonly grantId: string;
	readonly credential: PrCheckCredentialProvider;
	readonly request: PrCheckRequest;
}

export interface PublishPrCommentOptions extends PlanPrCommentOptions {
	readonly grants: readonly CapabilityGrant[];
	readonly grantId: string;
	readonly credential: PrCheckCredentialProvider;
	readonly verifyPrHead?: PrHeadVerifier;
	readonly request: PrCommentRequest;
}

interface ParsedRepository {
	readonly owner: string;
	readonly repo: string;
	readonly target: string;
}

const PUBLISH_CAPABILITY = "github.pr_check";
const COMMENT_PUBLISH_CAPABILITY = "github.pr_comment";
const PUBLISH_ACTION = "publish";
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const URL_SEMANTIC_DELIMITERS = new Set(["/", "?", "#", "%", "\\"]);

export function planPrCheckOperation(
	options: PlanPrCheckOptions,
): PlannedPrCheck {
	const repository = parseRepository(options.repository);
	const headSha = parseHeadSha(options.headSha);
	const name = options.name?.trim() || "Buildplane";
	const conclusion = mapFinalVerdictToCheckConclusion(options.report.verdict);
	const operation: PrCheckOperation = {
		method: "POST",
		path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/check-runs`,
		body: {
			name,
			head_sha: headSha,
			status: "completed",
			conclusion,
			external_id: options.report.runId,
			...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
			output: {
				title: `${name}: ${options.report.verdict}`,
				summary: summarizeReport(options.report, conclusion),
				text: formatEvidenceMarkdown(options.report, {
					conclusion,
					headSha,
					detailsUrl: options.detailsUrl,
					bundleUrl: options.bundleUrl,
				}),
			},
		},
	};

	return {
		mode: "dry-run",
		operation,
		sideEffect: buildPublishSideEffect({
			runId: options.report.runId,
			repository,
			capability: PUBLISH_CAPABILITY,
			target: repository.target,
			idPrefix: "side-effect-pr-check-publish",
		}),
	};
}

export function planPrCommentOperation(
	options: PlanPrCommentOptions,
): PlannedPrComment {
	const repository = parseRepository(options.repository);
	const prNumber = parsePrNumber(options.prNumber);
	const headSha = parseHeadSha(options.headSha);
	const preflight: PrCommentPreflightOperation = {
		method: "GET",
		path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${prNumber}`,
	};
	const operation: PrCommentOperation = {
		method: "POST",
		path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues/${prNumber}/comments`,
		body: {
			body: formatPrEvidenceComment(options.report, {
				headSha,
				prNumber,
				detailsUrl: options.detailsUrl,
				bundleUrl: options.bundleUrl,
			}),
		},
	};

	return {
		mode: "dry-run",
		preflight,
		operation,
		sideEffect: buildPublishSideEffect({
			runId: options.report.runId,
			repository,
			capability: COMMENT_PUBLISH_CAPABILITY,
			target: `${repository.target}#pr:${prNumber}`,
			idPrefix: "side-effect-pr-comment-publish",
			idSuffix: `pr-${prNumber}`,
			metadata: { headSha, prNumber },
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

export async function publishPrCommentOperation(
	options: PublishPrCommentOptions,
): Promise<PublishedPrComment> {
	const planned = planPrCommentOperation(options);
	const authorizedSideEffect = authorizePrCommentPublish({
		sideEffect: planned.sideEffect,
		grants: options.grants,
		grantId: options.grantId,
	});
	const credential = (options.credential() ?? "").trim();
	if (!credential) {
		throw new Error("Missing GitHub credential for pr-comment publish.");
	}
	const verifiedHead = await (options.verifyPrHead ?? defaultPrHeadVerifier)(
		planned.preflight,
		{ credential },
	);
	assertVerifiedPrHead(verifiedHead, {
		expectedPrNumber: parsePrNumber(options.prNumber),
		expectedHeadSha: parseHeadSha(options.headSha),
	});
	const response = await options.request(planned.operation, { credential });
	return {
		mode: "published",
		preflight: planned.preflight,
		operation: planned.operation,
		sideEffect: authorizedSideEffect,
		grantId: authorizedSideEffect.grantId ?? options.grantId.trim(),
		verifiedHead,
		response,
	};
}

export function authorizePrCheckPublish(options: {
	readonly sideEffect: SideEffectReceipt;
	readonly grants: readonly CapabilityGrant[];
	readonly grantId: string;
}): SideEffectReceipt {
	return authorizePublishOperation({
		...options,
		operationLabel: "pr-check publish",
	});
}

export function authorizePrCommentPublish(options: {
	readonly sideEffect: SideEffectReceipt;
	readonly grants: readonly CapabilityGrant[];
	readonly grantId: string;
}): SideEffectReceipt {
	return authorizePublishOperation({
		...options,
		operationLabel: "pr-comment publish",
	});
}

function authorizePublishOperation(options: {
	readonly sideEffect: SideEffectReceipt;
	readonly grants: readonly CapabilityGrant[];
	readonly grantId: string;
	readonly operationLabel: string;
}): SideEffectReceipt {
	const grantId = options.grantId.trim();
	if (!grantId) {
		throw unauthorizedPublishError(
			options.sideEffect,
			options.operationLabel,
			"missing grant id",
		);
	}
	const sideEffect: SideEffectReceipt = {
		...options.sideEffect,
		grantId,
	};
	const grant = options.grants.find((candidate) =>
		matchesGrant(sideEffect, candidate),
	);
	if (!grant) {
		throw unauthorizedPublishError(
			sideEffect,
			options.operationLabel,
			"no matching capability grant",
		);
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
	return postGitHubOperation(operation, options, "check-run");
}

export async function defaultPrCommentRequest(
	operation: PrCommentOperation,
	options: { readonly credential: string },
): Promise<unknown> {
	return postGitHubOperation(operation, options, "PR comment");
}

export async function defaultPrHeadVerifier(
	operation: PrCommentPreflightOperation,
	options: { readonly credential: string },
): Promise<PrHeadVerificationResult> {
	const response = await fetch(`https://api.github.com${operation.path}`, {
		method: operation.method,
		redirect: "manual",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${options.credential}`,
			"User-Agent": "buildplane-cli",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	const bodyText = await response.text();
	const body = parseResponseBody(bodyText);
	if (!response.ok) {
		throw new Error(
			`GitHub PR preflight failed: ${response.status} ${response.statusText}`,
		);
	}
	const record = asRecord(body, "GitHub PR preflight response");
	const rawNumber = record.number;
	if (typeof rawNumber !== "number") {
		throw new Error("GitHub PR preflight response.number must be a number.");
	}
	const head = asRecord(record.head, "GitHub PR preflight response.head");
	return {
		number: parsePrNumber(rawNumber),
		headSha: parseHeadSha(
			readString(head.sha, "GitHub PR preflight response.head.sha"),
		),
	};
}

async function postGitHubOperation(
	operation: PrCheckOperation | PrCommentOperation,
	options: { readonly credential: string },
	label: string,
): Promise<unknown> {
	const response = await fetch(`https://api.github.com${operation.path}`, {
		method: operation.method,
		redirect: "manual",
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
			`GitHub ${label} publish failed: ${response.status} ${response.statusText}`,
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

export function formatPrCommentHuman(
	result: PlannedPrComment | PublishedPrComment,
): string[] {
	const headSha = result.sideEffect.metadata?.headSha;
	return [
		`pr-comment: ${result.mode}`,
		`preflight: ${result.preflight.method} ${result.preflight.path}`,
		`operation: ${result.operation.method} ${result.operation.path}`,
		`target: ${result.sideEffect.target}`,
		`verified-head: ${typeof headSha === "string" ? headSha : "unknown"}`,
		"comment-body:",
		result.operation.body.body,
		"operation-json:",
		JSON.stringify(result.operation, null, 2),
	];
}

function buildPublishSideEffect(options: {
	readonly runId: string;
	readonly repository: ParsedRepository;
	readonly capability: string;
	readonly target: string;
	readonly idPrefix: string;
	readonly idSuffix?: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}): SideEffectReceipt {
	return {
		id: [options.idPrefix, options.runId, options.idSuffix]
			.filter((part): part is string => Boolean(part))
			.join("-"),
		capability: options.capability,
		action: PUBLISH_ACTION,
		target: options.target,
		...(options.metadata ? { metadata: options.metadata } : {}),
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
	operationLabel: string,
	reason: string,
): Error {
	return new Error(
		`UNSAFE_TO_RUN: ${operationLabel} ${sideEffect.capability}.${sideEffect.action} target ${sideEffect.target} is not authorized (${reason}); matching capability grant required before GitHub is called.`,
	);
}

function summarizeReport(
	report: PrCheckFinalVerdictReport,
	conclusion: GitHubCheckConclusion,
): string {
	const verifierReceipts = readReceiptCount(report.receipts, "verifier");
	const failedOrMissingGates = collectFailedOrMissingGates(report).map(
		escapeBotVisibleMarkdown,
	);
	const gateClause =
		failedOrMissingGates.length > 0
			? `${failedOrMissingGates.length} failed/missing ${pluralize(failedOrMissingGates.length, "gate", "gates")}: ${failedOrMissingGates.join(", ")}`
			: "0 failed/missing gates";
	return `${escapeBotVisibleMarkdown(report.verdict)} · ${escapeBotVisibleMarkdown(conclusion)} · ${verifierReceipts} verifier ${pluralize(verifierReceipts, "receipt", "receipts")} · ${gateClause} · run ${escapeBotVisibleMarkdown(report.runId)}`;
}

function formatPrEvidenceComment(
	report: PrCheckFinalVerdictReport,
	options: {
		readonly headSha: string;
		readonly prNumber: number;
		readonly detailsUrl?: string;
		readonly bundleUrl?: string;
	},
): string {
	return [
		`<!-- buildplane:pr-evidence run=${escapeCommentMarkerValue(report.runId)} sha=${options.headSha} pr=${options.prNumber} -->`,
		"## Buildplane evidence",
		"",
		formatEvidenceMarkdown(report, {
			headSha: options.headSha,
			prNumber: options.prNumber,
			detailsUrl: options.detailsUrl,
			bundleUrl: options.bundleUrl,
		}),
	].join("\n");
}

function formatEvidenceMarkdown(
	report: PrCheckFinalVerdictReport,
	options: {
		readonly conclusion?: GitHubCheckConclusion;
		readonly headSha?: string;
		readonly prNumber?: number;
		readonly detailsUrl?: string;
		readonly bundleUrl?: string;
	} = {},
): string {
	const rows: Array<readonly [string, string]> = [
		["Final verdict", report.verdict],
	];
	if (options.conclusion) rows.push(["GitHub conclusion", options.conclusion]);
	rows.push(["Run ID", `\`${report.runId}\``]);
	if (options.prNumber) rows.push(["Pull request", `#${options.prNumber}`]);
	if (options.headSha) rows.push(["Head SHA", `\`${options.headSha}\``]);
	rows.push(
		[
			"Verifier receipts",
			String(readReceiptCount(report.receipts, "verifier")),
		],
		[
			"Policy approvals",
			String(readReceiptCount(report.receipts, "approvals")),
		],
		["Rejections", String(readReceiptCount(report.receipts, "rejections"))],
		[
			"Failed/missing gates",
			formatFailedOrMissingGates(collectFailedOrMissingGates(report)),
		],
		[
			"Pass authority",
			"verifier receipts only; worker claims are not authoritative",
		],
		["Run Inspector", options.detailsUrl ?? "not provided"],
		["Evidence bundle", options.bundleUrl ?? "not provided"],
	);

	return [
		"### Buildplane evidence",
		"",
		"| Field | Value |",
		"|---|---|",
		...rows.map(
			([field, value]) =>
				`| ${escapeMarkdownTableValue(field)} | ${escapeMarkdownTableValue(value)} |`,
		),
	].join("\n");
}

function readReceiptCount(receipts: unknown, key: string): number {
	if (
		typeof receipts !== "object" ||
		receipts === null ||
		Array.isArray(receipts)
	) {
		return 0;
	}
	const value = (receipts as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function collectFailedOrMissingGates(
	report: PrCheckFinalVerdictReport,
): string[] {
	const gates: string[] = [];
	for (const criterion of report.criteria ?? []) {
		const status = criterion.status?.trim();
		if (status && status !== "PASSED") {
			gates.push(
				`${criterion.id ?? criterion.label ?? "criterion"}: ${status}`,
			);
		}
	}
	for (const issue of report.issues ?? []) {
		const code = issue.code?.trim();
		if (code && !gates.includes(code)) gates.push(code);
	}
	return gates;
}

function formatFailedOrMissingGates(gates: readonly string[]): string {
	return gates.length > 0 ? gates.join("; ") : "none";
}

function pluralize(count: number, singular: string, plural: string): string {
	return count === 1 ? singular : plural;
}

function escapeCommentMarkerValue(value: string): string {
	const escaped = value.replace(/[^A-Za-z0-9_.-]/g, "-");
	return escaped.length > 0 ? escaped : "unknown";
}

function escapeMarkdownTableValue(value: string): string {
	return escapeBotVisibleMarkdown(value);
}

function escapeBotVisibleMarkdown(value: string): string {
	const sanitized = sanitizeBotVisibleText(value);
	return escapeMarkdownBackticks(sanitized).replace(/\|/g, "\\|");
}

function sanitizeBotVisibleText(value: string): string {
	return replaceAsciiControlCharacters(value)
		.replace(/-->/g, "---")
		.replace(/>/g, "-")
		.replace(/\s*@([A-Za-z0-9][A-Za-z0-9_-]*)/g, "​ $1")
		.replace(/@([A-Za-z0-9][A-Za-z0-9_-]*)/g, "​ $1");
}

function replaceAsciiControlCharacters(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		result += code < 32 || code === 127 ? " " : character;
	}
	return result;
}

function escapeMarkdownBackticks(value: string): string {
	if (value.length >= 2 && value.startsWith("`") && value.endsWith("`")) {
		return `\`${value.slice(1, -1).replace(/`/g, "\\`")}\``;
	}
	return value.replace(/`/g, "\\`");
}

function assertVerifiedPrHead(
	actual: PrHeadVerificationResult,
	expected: {
		readonly expectedPrNumber: number;
		readonly expectedHeadSha: string;
	},
): void {
	if (actual.number !== expected.expectedPrNumber) {
		throw new Error(
			`PR preflight returned pull request #${actual.number}; expected #${expected.expectedPrNumber}.`,
		);
	}
	if (actual.headSha !== expected.expectedHeadSha) {
		throw new Error(
			`PR head SHA mismatch for #${expected.expectedPrNumber}: expected ${expected.expectedHeadSha}, got ${actual.headSha}.`,
		);
	}
}

function parseHeadSha(value: string): string {
	if (value !== value.trim()) {
		throw new Error(
			"Head SHA must be a 40-character hexadecimal Git commit SHA without surrounding whitespace.",
		);
	}
	if (!GIT_COMMIT_SHA_PATTERN.test(value)) {
		throw new Error(
			"Head SHA must be a 40-character hexadecimal Git commit SHA.",
		);
	}
	return value.toLowerCase();
}

function parsePrNumber(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(
			"PR number must be a positive decimal integer within JavaScript's safe integer range.",
		);
	}
	return value;
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
