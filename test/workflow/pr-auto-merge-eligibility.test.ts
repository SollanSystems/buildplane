import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const probeModule = import("../../scripts/ci/pr-auto-merge-eligibility.mjs");
const tempDirs: string[] = [];

function makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "bp-auto-merge-review-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { force: true, recursive: true });
	}
});

describe("pr auto-merge eligibility probe", () => {
	it("parses expected base and review receipt arguments", async () => {
		const { parseArgs } = await probeModule;
		const args = parseArgs([
			"--pr",
			"125",
			"--expected-head",
			"abc123",
			"--expected-base",
			"main",
			"--review-receipt",
			"/tmp/review.json",
			"--json",
		]);

		expect(args.pr).toBe("125");
		expect(args.expectedHead).toBe("abc123");
		expect(args.expectedBase).toBe("main");
		expect(args.reviewReceipt).toBe("/tmp/review.json");
		expect(args.reviewPass).toBe(false);
		expect(args.jsonOnly).toBe(true);
	});

	it("rejects missing review source", async () => {
		const { parseArgs } = await probeModule;
		expect(() => parseArgs(["--pr", "125"])).toThrow(
			"one review source is required",
		);
	});

	it("reads a structured PASS markdown review receipt with head binding", async () => {
		const { readReviewReceipt } = await probeModule;
		const dir = makeTempDir();
		const receipt = join(dir, "review.md");
		writeFileSync(
			receipt,
			[
				"## Review gate",
				"",
				"- Reviewed commit SHA: abc123",
				"- Current PR head SHA: abc123",
				"- Verdict: PASS",
			].join("\n"),
		);

		expect(readReviewReceipt(receipt)).toMatchObject({
			asserted: true,
			currentPrHeadSha: "abc123",
			reviewedCommitSha: "abc123",
			source: receipt,
			verdict: "PASS",
		});
	});

	it("rejects unstructured text even if it mentions PASS", async () => {
		const { readReviewReceipt } = await probeModule;
		const dir = makeTempDir();
		const receipt = join(dir, "review.txt");
		writeFileSync(receipt, "This template says PASS is an allowed verdict.\n");

		expect(readReviewReceipt(receipt)).toMatchObject({
			asserted: false,
			source: receipt,
			structured: false,
		});
	});

	it("rejects a structured receipt that omits reviewed head fields", async () => {
		const { readReviewReceipt } = await probeModule;
		const dir = makeTempDir();
		const receipt = join(dir, "review.md");
		writeFileSync(receipt, "- Verdict: PASS\n");

		expect(readReviewReceipt(receipt)).toMatchObject({
			asserted: false,
			missingFields: ["Reviewed commit SHA", "Current PR head SHA"],
		});
	});

	it("summarizes unresolved review threads without exposing bodies", async () => {
		const { summarizeReviewThreads } = await probeModule;
		const summary = summarizeReviewThreads({
			nodes: [
				{
					comments: {
						nodes: [{ author: { login: "codex" }, body: "Fix this" }],
					},
					isOutdated: false,
					isResolved: false,
					line: 89,
					path: "native/crates/bp-ledger/src/signing.rs",
				},
				{ isResolved: true, path: "ignored.ts" },
			],
		});

		expect(summary.total).toBe(2);
		expect(summary.unresolvedCount).toBe(1);
		expect(summary.unresolved[0]).toMatchObject({
			commentAuthor: "codex",
			line: 89,
			path: "native/crates/bp-ledger/src/signing.rs",
		});
		expect(summary.unresolved[0]).not.toHaveProperty("commentBody");
	});

	it("extracts required checks from branch protection and finds missing checks", async () => {
		const { missingRequiredChecks, requiredCheckNamesFromProtection } =
			await probeModule;
		const requiredChecks = requiredCheckNamesFromProtection({
			required_status_checks: {
				checks: [{ context: "verify" }],
				contexts: ["verify", "verify-wrong-node"],
			},
		});
		const missing = missingRequiredChecks(requiredChecks, [
			{ conclusion: "SUCCESS", name: "verify", status: "COMPLETED" },
		]);

		expect(requiredChecks).toEqual(["verify", "verify-wrong-node"]);
		expect(missing).toEqual(["verify-wrong-node"]);
	});

	it("blocks when base branch mismatches, required checks are missing, and unresolved review threads remain", async () => {
		const {
			BLOCKED_AUTO_MERGE_OPT_IN,
			BLOCKED_BASE_MISMATCH,
			BLOCKED_CHECKS,
			BLOCKED_REVIEW_THREADS,
			determineResult,
		} = await probeModule;

		const verdict = determineResult({
			args: {
				allowDeployments: false,
				allowMissingLabel: false,
				allowNoChecks: false,
				expectedBase: "main",
				expectedHead: "abc123",
				requireGithubApproval: false,
				requiredLabel: "buildplane:auto-merge",
			},
			deployments: [],
			missingChecks: ["verify-wrong-node"],
			pr: {
				baseRefName: "feat/m1-s3-signature-persistence-20260522225603",
				headRefOid: "abc123",
				isDraft: false,
				labels: [],
				mergeStateStatus: "CLEAN",
				reviewDecision: null,
				state: "OPEN",
			},
			requiredChecks: ["verify", "verify-wrong-node"],
			reviewAssertion: {
				asserted: true,
				currentPrHeadSha: "abc123",
				reason: "review PASS",
				reviewedCommitSha: "abc123",
				source: "--review-pass",
			},
			reviewThreads: {
				total: 1,
				unresolved: [
					{ line: 89, path: "native/crates/bp-ledger/src/signing.rs" },
				],
				unresolvedCount: 1,
			},
			rollupItems: [
				{ conclusion: "SUCCESS", name: "verify", status: "COMPLETED" },
			],
		});

		expect(verdict.eligible).toBe(false);
		expect(verdict.blockers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: BLOCKED_AUTO_MERGE_OPT_IN }),
				expect.objectContaining({ status: BLOCKED_BASE_MISMATCH }),
				expect.objectContaining({ status: BLOCKED_REVIEW_THREADS }),
				expect.objectContaining({ status: BLOCKED_CHECKS }),
			]),
		);
	});

	it("blocks when expected base is omitted", async () => {
		const { BLOCKED_BASE_MISMATCH, determineResult } = await probeModule;
		const verdict = determineResult({
			args: {
				allowDeployments: false,
				allowMissingLabel: true,
				allowNoChecks: false,
				expectedBase: undefined,
				expectedHead: "abc123",
				requireGithubApproval: false,
				requiredLabel: "buildplane:auto-merge",
			},
			deployments: [],
			missingChecks: [],
			pr: {
				baseRefName: "main",
				headRefOid: "abc123",
				isDraft: false,
				labels: [{ name: "buildplane:auto-merge" }],
				mergeStateStatus: "CLEAN",
				reviewDecision: null,
				state: "OPEN",
			},
			requiredChecks: [],
			reviewAssertion: {
				asserted: true,
				currentPrHeadSha: "abc123",
				reason: "review PASS",
				reviewedCommitSha: "abc123",
				source: "--review-pass",
			},
			reviewThreads: { total: 0, unresolved: [], unresolvedCount: 0 },
			rollupItems: [
				{ conclusion: "SUCCESS", name: "verify", status: "COMPLETED" },
			],
		});

		expect(verdict.blockers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: BLOCKED_BASE_MISMATCH }),
			]),
		);
	});

	it("returns AUTO_MERGE_READY only when all gates pass", async () => {
		const { AUTO_MERGE_READY, determineResult } = await probeModule;
		const verdict = determineResult({
			args: {
				allowDeployments: false,
				allowMissingLabel: false,
				allowNoChecks: false,
				expectedBase: "main",
				expectedHead: "abc123",
				requireGithubApproval: true,
				requiredLabel: "buildplane:auto-merge",
			},
			deployments: [],
			missingChecks: [],
			pr: {
				baseRefName: "main",
				headRefOid: "abc123",
				isDraft: false,
				labels: [{ name: "buildplane:auto-merge" }],
				mergeStateStatus: "CLEAN",
				reviewDecision: "APPROVED",
				state: "OPEN",
			},
			requiredChecks: ["verify", "verify-wrong-node"],
			reviewAssertion: {
				asserted: true,
				currentPrHeadSha: "abc123",
				reason: "review PASS",
				reviewedCommitSha: "abc123",
				source: "--review-pass",
			},
			reviewThreads: { total: 0, unresolved: [], unresolvedCount: 0 },
			rollupItems: [
				{ conclusion: "SUCCESS", name: "verify", status: "COMPLETED" },
				{
					conclusion: "SUCCESS",
					name: "verify-wrong-node",
					status: "COMPLETED",
				},
			],
		});

		expect(verdict).toMatchObject({
			eligible: true,
			status: AUTO_MERGE_READY,
		});
		expect(verdict.blockers).toHaveLength(0);
	});
});
