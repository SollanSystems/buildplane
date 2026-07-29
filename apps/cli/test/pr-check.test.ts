import { describe, expect, it, vi } from "vitest";
import {
	authorizePrCheckPublish,
	authorizePrCommentPublish,
	defaultPrCheckRequest,
	defaultPrCommentRequest,
	defaultPrHeadVerifier,
	formatPrCommentHuman,
	loadCapabilityGrantsFromJson,
	mapFinalVerdictToCheckConclusion,
	planPrCheckOperation,
	planPrCommentOperation,
	publishPrCheckOperation,
	publishPrCommentOperation,
} from "../src/pr-check";

const report = {
	runId: "run-pr-check-pass",
	verdict: "PASSED",
	trustedReceipt: true,
	receipts: { verifier: 2, approvals: 1, rejections: 0 },
	criteria: [{ id: "command-exit:0", status: "PASSED" }],
	issues: [],
};

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const publishGrant = {
	id: "grant-pr-check-publish",
	capability: "github.pr_check",
	actions: ["publish"],
	targets: ["repo:SollanSystems/buildplane"],
};

const commentGrant = {
	id: "grant-pr-comment-publish",
	capability: "github.pr_comment",
	actions: ["publish"],
	targets: ["repo:SollanSystems/buildplane#pr:42"],
};

describe("pr-check planning and publishing", () => {
	it("plans the exact GitHub check-run operation for a dry-run", () => {
		const dryRun = planPrCheckOperation({
			report,
			repository: "SollanSystems/buildplane",
			headSha: HEAD_SHA,
			name: "Buildplane Evidence",
			detailsUrl: "https://example.test/runs/run-pr-check-pass",
		});

		expect(dryRun).toMatchObject({
			mode: "dry-run",
			sideEffect: {
				capability: "github.pr_check",
				action: "publish",
				target: "repo:SollanSystems/buildplane",
			},
		});
		expect(dryRun.operation).toMatchObject({
			method: "POST",
			path: "/repos/SollanSystems/buildplane/check-runs",
			body: {
				name: "Buildplane Evidence",
				head_sha: HEAD_SHA,
				status: "completed",
				conclusion: "success",
				external_id: "run-pr-check-pass",
				details_url: "https://example.test/runs/run-pr-check-pass",
				output: {
					title: "Buildplane Evidence: PASSED",
					summary:
						"PASSED · success · 2 verifier receipts · 0 failed/missing gates · run run-pr-check-pass",
				},
			},
		});
		expect(dryRun.operation.body.output.text).toContain(
			"| Final verdict | PASSED |",
		);
		expect(dryRun.operation.body.output.text).toContain(
			"| Pass authority | verifier receipts only; worker claims are not authoritative |",
		);
		expect(dryRun.operation.body.output.text).toContain(
			"| Run Inspector | https://example.test/runs/run-pr-check-pass |",
		);
	});

	it("refuses to project an explicitly untrusted receipt into PR evidence", () => {
		const unsafeReport = { ...report, trustedReceipt: false };
		expect(() =>
			planPrCheckOperation({
				report: unsafeReport,
				repository: "SollanSystems/buildplane",
				headSha: HEAD_SHA,
			}),
		).toThrow(/UNTRUSTED_RECEIPT/);
		expect(() =>
			planPrCommentOperation({
				report: unsafeReport,
				repository: "SollanSystems/buildplane",
				prNumber: 42,
				headSha: HEAD_SHA,
			}),
		).toThrow(/UNTRUSTED_RECEIPT/);
	});

	it("refuses a report that omits the governed receipt marker", () => {
		const legacyShapedReport = {
			runId: "run-pr-check-legacy",
			verdict: "PASSED",
		} as never;
		expect(() =>
			planPrCheckOperation({
				report: legacyShapedReport,
				repository: "SollanSystems/buildplane",
				headSha: HEAD_SHA,
			}),
		).toThrow(/UNTRUSTED_RECEIPT/);
	});

	it("rejects repositories that could alter GitHub request URL semantics", () => {
		const unsafeRepositories = [
			"SollanSystems/buildplane?state=passed",
			"SollanSystems/buildplane#fragment",
			"../buildplane",
			"SollanSystems/..",
			"SollanSystems/.",
			"SollanSystems/build plane",
			"SollanSystems/buildplane%2Fother",
			"SollanSystems/buildplane\nother",
		];

		for (const repository of unsafeRepositories) {
			expect(() =>
				planPrCheckOperation({
					report,
					repository,
					headSha: HEAD_SHA,
				}),
			).toThrow(/Repository/);
		}
	});

	it("rejects malformed commit SHAs before planning GitHub side effects", () => {
		const malformedShas = [
			"abc1234",
			"0123456789abcdef0123456789abcdef0123456",
			"0123456789abcdef0123456789abcdef012345678",
			"0123456789abcdef0123456789abcdef0123456g",
			" 0123456789abcdef0123456789abcdef01234567",
		];

		for (const headSha of malformedShas) {
			expect(() =>
				planPrCheckOperation({
					report,
					repository: "SollanSystems/buildplane",
					headSha,
				}),
			).toThrow(/Head SHA/);
			expect(() =>
				planPrCommentOperation({
					report,
					repository: "SollanSystems/buildplane",
					prNumber: 42,
					headSha,
				}),
			).toThrow(/Head SHA/);
		}
	});

	it("fails closed before credential and network for malformed publish SHAs", async () => {
		const request = vi.fn();
		const credential = vi.fn(() => "cred");

		await expect(
			publishPrCheckOperation({
				report,
				repository: "SollanSystems/buildplane",
				headSha: "abc1234",
				grants: [publishGrant],
				grantId: publishGrant.id,
				credential,
				request,
			}),
		).rejects.toThrow(/Head SHA/);
		expect(credential).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("fails closed before credential and network for malformed publish repositories", async () => {
		const request = vi.fn();
		const credential = vi.fn(() => "cred");
		const unsafeRepository = "SollanSystems/buildplane?state=passed";

		await expect(
			publishPrCheckOperation({
				report,
				repository: unsafeRepository,
				headSha: HEAD_SHA,
				grants: [
					{
						id: publishGrant.id,
						capability: publishGrant.capability,
						actions: publishGrant.actions,
						targets: [`repo:${unsafeRepository}`],
					},
				],
				grantId: publishGrant.id,
				credential,
				request,
			}),
		).rejects.toThrow(/Repository/);
		expect(credential).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("maps final verdicts into non-green conclusions for blocked and unsafe gates", () => {
		expect(mapFinalVerdictToCheckConclusion("PASSED")).toBe("success");
		expect(mapFinalVerdictToCheckConclusion("BLOCKED")).toBe("action_required");
		expect(mapFinalVerdictToCheckConclusion("FAILED")).toBe("failure");
		expect(mapFinalVerdictToCheckConclusion("UNSAFE_TO_RUN")).toBe("failure");
	});

	it("includes gate issue codes in the check output summary", () => {
		const dryRun = planPrCheckOperation({
			report: {
				runId: "run-pr-check-blocked",
				verdict: "BLOCKED",
				trustedReceipt: true,
				issues: [
					{ code: "MISSING_VERIFIER_RECEIPT", message: "No verifier event" },
					{ code: "UNRESOLVED_BLOCKER", message: "architecture.diff_scope" },
				],
			},
			repository: "SollanSystems/buildplane",
			headSha: OTHER_HEAD_SHA,
		});

		expect(dryRun.operation.body.conclusion).toBe("action_required");
		expect(dryRun.operation.body.output.summary).toContain(
			"MISSING_VERIFIER_RECEIPT",
		);
		expect(dryRun.operation.body.output.summary).toContain(
			"UNRESOLVED_BLOCKER",
		);
	});

	it("sanitizes bot-visible check-run summaries from marker and mention injection", () => {
		const dryRun = planPrCheckOperation({
			report: {
				runId: "run--> @here | `boom`",
				verdict: "BLOCKED",
				trustedReceipt: true,
				receipts: { verifier: 0, approvals: 0, rejections: 0 },
				criteria: [
					{
						id: "gate--> @team | `bad`",
						status: "INSUFFICIENT_EVIDENCE",
					},
				],
				issues: [{ code: "ISSUE--> @here | `boom`", message: "x" }],
			},
			repository: "SollanSystems/buildplane",
			headSha: OTHER_HEAD_SHA,
		});
		const { summary } = dryRun.operation.body.output;

		expect(summary).not.toContain("-->");
		expect(summary).not.toContain("@here");
		expect(summary).not.toContain("@team");
		expect(summary).toContain("run---​ here \\| \\`boom\\`");
		expect(summary).toContain(
			"gate---​ team \\| \\`bad\\`: INSUFFICIENT_EVIDENCE",
		);
		expect(summary).toContain("ISSUE---​ here \\| \\`boom\\`");
	});

	it("fails closed before network when publish lacks a matching grant", async () => {
		const request = vi.fn();

		await expect(
			publishPrCheckOperation({
				report,
				repository: "SollanSystems/buildplane",
				headSha: HEAD_SHA,
				grants: [],
				grantId: "grant-pr-check-publish",
				credential: () => "cred",
				request,
			}),
		).rejects.toThrow(/UNSAFE_TO_RUN.*matching capability grant/);
		expect(request).not.toHaveBeenCalled();
	});

	it("fails closed before network when publish omits the grant id", () => {
		expect(() =>
			authorizePrCheckPublish({
				sideEffect: {
					id: "side-effect-pr-check-publish-run",
					capability: "github.pr_check",
					action: "publish",
					target: "repo:SollanSystems/buildplane",
				},
				grants: [publishGrant],
				grantId: "",
			}),
		).toThrow(/UNSAFE_TO_RUN.*missing grant id/);
	});

	it("fails closed before network when publish cites the wrong grant id", async () => {
		const request = vi.fn();

		await expect(
			publishPrCheckOperation({
				report,
				repository: "SollanSystems/buildplane",
				headSha: HEAD_SHA,
				grants: [publishGrant],
				grantId: "grant-other",
				credential: () => "cred",
				request,
			}),
		).rejects.toThrow(/UNSAFE_TO_RUN.*matching capability grant/);
		expect(request).not.toHaveBeenCalled();
	});

	it("fails closed before network when publish targets a repo outside the grant", async () => {
		const request = vi.fn();

		await expect(
			publishPrCheckOperation({
				report,
				repository: "SollanSystems/other",
				headSha: HEAD_SHA,
				grants: [publishGrant],
				grantId: publishGrant.id,
				credential: () => "cred",
				request,
			}),
		).rejects.toThrow(/UNSAFE_TO_RUN.*repo:SollanSystems\/other/);
		expect(request).not.toHaveBeenCalled();
	});

	it("fails closed before network when publish lacks a credential", async () => {
		const request = vi.fn();

		await expect(
			publishPrCheckOperation({
				report,
				repository: "SollanSystems/buildplane",
				headSha: HEAD_SHA,
				grants: [publishGrant],
				grantId: publishGrant.id,
				credential: () => "   ",
				request,
			}),
		).rejects.toThrow(/Missing GitHub credential/);
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects malformed grant file entries instead of silently authorizing", () => {
		expect(() =>
			loadCapabilityGrantsFromJson({
				capabilityGrants: [
					{
						id: "grant-pr-check-publish",
						capability: "github.pr_check",
						actions: ["publish"],
					},
				],
			}),
		).toThrow(/grant\[0\]\.targets/);
	});

	it("publishes the same operation dry-run planned after grant authorization", async () => {
		const request = vi.fn().mockResolvedValue({ status: 201, ok: true });
		const dryRun = planPrCheckOperation({
			report,
			repository: "SollanSystems/buildplane",
			headSha: HEAD_SHA,
		});

		const published = await publishPrCheckOperation({
			report,
			repository: "SollanSystems/buildplane",
			headSha: HEAD_SHA,
			grants: [publishGrant],
			grantId: publishGrant.id,
			credential: () => "cred",
			request,
		});

		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(dryRun.operation, {
			credential: "cred",
		});
		expect(published.operation).toStrictEqual(dryRun.operation);
		expect(published.sideEffect).toMatchObject({ grantId: publishGrant.id });
	});

	it("loads capability grants from a grants file shape", () => {
		expect(
			loadCapabilityGrantsFromJson({
				capabilityGrants: [publishGrant, commentGrant],
			}),
		).toStrictEqual([publishGrant, commentGrant]);
	});

	it("uses manual redirect mode for GitHub PR preflight and publish requests", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: "OK",
				text: async () =>
					JSON.stringify({ number: 42, head: { sha: HEAD_SHA } }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 201,
				statusText: "Created",
				text: async () => JSON.stringify({ id: 123 }),
			});
		vi.stubGlobal("fetch", fetchMock);
		try {
			await defaultPrHeadVerifier(
				{
					method: "GET",
					path: "/repos/SollanSystems/buildplane/pulls/42",
				},
				{ credential: "cred" },
			);
			await defaultPrCommentRequest(
				{
					method: "POST",
					path: "/repos/SollanSystems/buildplane/issues/42/comments",
					body: { body: "ok" },
				},
				{ credential: "cred" },
			);

			expect(fetchMock).toHaveBeenNthCalledWith(
				1,
				"https://api.github.com/repos/SollanSystems/buildplane/pulls/42",
				expect.objectContaining({ method: "GET", redirect: "manual" }),
			);
			expect(fetchMock).toHaveBeenNthCalledWith(
				2,
				"https://api.github.com/repos/SollanSystems/buildplane/issues/42/comments",
				expect.objectContaining({ method: "POST", redirect: "manual" }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("fails closed on GitHub redirects instead of following renamed repository targets", async () => {
		const redirectResponse = {
			ok: false,
			status: 301,
			statusText: "Moved Permanently",
			text: async () => JSON.stringify({ message: "Moved Permanently" }),
		};
		const fetchMock = vi.fn().mockResolvedValue(redirectResponse);
		vi.stubGlobal("fetch", fetchMock);
		try {
			await expect(
				defaultPrHeadVerifier(
					{
						method: "GET",
						path: "/repos/SollanSystems/buildplane/pulls/42",
					},
					{ credential: "cred" },
				),
			).rejects.toThrow(/301 Moved Permanently/);
			expect(fetchMock).toHaveBeenLastCalledWith(
				"https://api.github.com/repos/SollanSystems/buildplane/pulls/42",
				expect.objectContaining({ redirect: "manual" }),
			);

			await expect(
				defaultPrCheckRequest(
					{
						method: "POST",
						path: "/repos/SollanSystems/buildplane/check-runs",
						body: {
							name: "Buildplane Evidence",
							head_sha: HEAD_SHA,
							status: "completed",
							conclusion: "success",
							external_id: "run-pr-check-pass",
							output: { title: "ok", summary: "ok" },
						},
					},
					{ credential: "cred" },
				),
			).rejects.toThrow(/301 Moved Permanently/);
			expect(fetchMock).toHaveBeenLastCalledWith(
				"https://api.github.com/repos/SollanSystems/buildplane/check-runs",
				expect.objectContaining({ redirect: "manual" }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("plans a compact PR evidence comment bound to a PR, run, repo, and commit", () => {
		const dryRun = planPrCommentOperation({
			report,
			repository: "SollanSystems/buildplane",
			prNumber: 42,
			headSha: HEAD_SHA,
			detailsUrl: "https://mission-control.example/runs/run-pr-check-pass",
			bundleUrl: "https://artifacts.example/run-pr-check-pass.json",
		});

		expect(dryRun).toMatchObject({
			mode: "dry-run",
			sideEffect: {
				capability: "github.pr_comment",
				action: "publish",
				target: "repo:SollanSystems/buildplane#pr:42",
				metadata: { headSha: HEAD_SHA, prNumber: 42 },
			},
			preflight: {
				method: "GET",
				path: "/repos/SollanSystems/buildplane/pulls/42",
			},
			operation: {
				method: "POST",
				path: "/repos/SollanSystems/buildplane/issues/42/comments",
			},
		});
		const body = dryRun.operation.body.body;
		expect(body).toContain(
			`<!-- buildplane:pr-evidence run=run-pr-check-pass sha=${HEAD_SHA} pr=42 -->`,
		);
		expect(body).toContain("| Final verdict | PASSED |");
		expect(body).toContain("| Pull request | #42 |");
		expect(body).toContain(`| Head SHA | \`${HEAD_SHA}\` |`);
		expect(body).toContain("| Verifier receipts | 2 |");
		expect(body).toContain("| Failed/missing gates | none |");
		expect(body).toContain(
			"| Pass authority | verifier receipts only; worker claims are not authoritative |",
		);
		expect(body).toContain(
			"| Run Inspector | https://mission-control.example/runs/run-pr-check-pass |",
		);
		expect(body).toContain(
			"| Evidence bundle | https://artifacts.example/run-pr-check-pass.json |",
		);
		expect(body).not.toMatch(/merge-ready|auto-merge|deployed/i);
	});

	it("summarizes blocked PR comments with gate issue evidence", () => {
		const dryRun = planPrCommentOperation({
			report: {
				runId: "run-pr-check-blocked",
				verdict: "BLOCKED",
				trustedReceipt: true,
				receipts: { verifier: 0, approvals: 0, rejections: 0 },
				criteria: [{ id: "command-exit:0", status: "INSUFFICIENT_EVIDENCE" }],
				issues: [
					{ code: "MISSING_VERIFIER_RECEIPT", message: "No verifier event" },
				],
			},
			repository: "SollanSystems/buildplane",
			prNumber: 42,
			headSha: OTHER_HEAD_SHA,
		});

		expect(dryRun.operation.body.body).toContain("| Final verdict | BLOCKED |");
		expect(dryRun.operation.body.body).toContain(
			"| Failed/missing gates | command-exit:0: INSUFFICIENT_EVIDENCE; MISSING_VERIFIER_RECEIPT |",
		);
	});

	it("sanitizes PR comment marker and table fields from markdown or mention injection", () => {
		const dryRun = planPrCommentOperation({
			report: {
				...report,
				runId: "run--> @here | `boom`",
			},
			repository: "SollanSystems/buildplane",
			prNumber: 42,
			headSha: HEAD_SHA,
		});
		const [marker] = dryRun.operation.body.body.split("\n");

		expect(marker).toBe(
			`<!-- buildplane:pr-evidence run=run-----here----boom- sha=${HEAD_SHA} pr=42 -->`,
		);
		expect(dryRun.operation.body.body).not.toContain("--> @here");
		expect(dryRun.operation.body.body).not.toContain("@here");
		const runIdLine = dryRun.operation.body.body
			.split("\n")
			.find((line) => line.startsWith("| Run ID |"));
		expect(runIdLine).toContain("run---​ here");
		expect(runIdLine).toContain("\\|");
		expect(runIdLine).toContain("\\`boom\\`");
	});

	it("surfaces PR preflight and bound target metadata in human output", () => {
		const dryRun = planPrCommentOperation({
			report,
			repository: "SollanSystems/buildplane",
			prNumber: 42,
			headSha: HEAD_SHA,
		});

		expect(formatPrCommentHuman(dryRun)).toEqual(
			expect.arrayContaining([
				"preflight: GET /repos/SollanSystems/buildplane/pulls/42",
				"target: repo:SollanSystems/buildplane#pr:42",
				`verified-head: ${HEAD_SHA}`,
			]),
		);
	});

	it("rejects malformed PR comment targets before credential and network", async () => {
		const request = vi.fn();
		const credential = vi.fn(() => "cred");

		await expect(
			publishPrCommentOperation({
				report,
				repository: "SollanSystems/buildplane",
				prNumber: 0,
				headSha: HEAD_SHA,
				grants: [commentGrant],
				grantId: commentGrant.id,
				credential,
				request,
			}),
		).rejects.toThrow(/PR number/);
		expect(credential).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it("fails closed before network when PR comment publish lacks a matching grant", async () => {
		const request = vi.fn();

		await expect(
			publishPrCommentOperation({
				report,
				repository: "SollanSystems/buildplane",
				prNumber: 42,
				headSha: HEAD_SHA,
				grants: [],
				grantId: commentGrant.id,
				credential: () => "cred",
				request,
			}),
		).rejects.toThrow(/UNSAFE_TO_RUN.*matching capability grant/);
		expect(request).not.toHaveBeenCalled();
	});

	it("verifies the requested PR head before publishing a PR comment", async () => {
		const calls: string[] = [];
		const verifyPrHead = vi.fn().mockImplementation(async () => {
			calls.push("preflight");
			return { number: 42, headSha: HEAD_SHA };
		});
		const request = vi.fn().mockImplementation(async () => {
			calls.push("comment");
			return { status: 201, ok: true };
		});

		await publishPrCommentOperation({
			report,
			repository: "SollanSystems/buildplane",
			prNumber: 42,
			headSha: HEAD_SHA,
			grants: [commentGrant],
			grantId: commentGrant.id,
			credential: () => "cred",
			verifyPrHead,
			request,
		});

		expect(verifyPrHead).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "GET",
				path: "/repos/SollanSystems/buildplane/pulls/42",
			}),
			{ credential: "cred" },
		);
		expect(calls).toEqual(["preflight", "comment"]);
	});

	it("refuses to publish a PR comment when preflight does not confirm the requested PR head", async () => {
		const verifyPrHead = vi.fn().mockResolvedValue({
			number: 42,
			headSha: OTHER_HEAD_SHA,
		});
		const request = vi.fn();

		await expect(
			publishPrCommentOperation({
				report,
				repository: "SollanSystems/buildplane",
				prNumber: 42,
				headSha: HEAD_SHA,
				grants: [commentGrant],
				grantId: commentGrant.id,
				credential: () => "cred",
				verifyPrHead,
				request,
			}),
		).rejects.toThrow(/PR head SHA mismatch/);
		expect(request).not.toHaveBeenCalled();
	});

	it("refuses to publish a PR comment when preflight resolves a different PR number", async () => {
		const verifyPrHead = vi.fn().mockResolvedValue({
			number: 99,
			headSha: HEAD_SHA,
		});
		const request = vi.fn();

		await expect(
			publishPrCommentOperation({
				report,
				repository: "SollanSystems/buildplane",
				prNumber: 42,
				headSha: HEAD_SHA,
				grants: [commentGrant],
				grantId: commentGrant.id,
				credential: () => "cred",
				verifyPrHead,
				request,
			}),
		).rejects.toThrow(/PR preflight returned pull request #99/);
		expect(request).not.toHaveBeenCalled();
	});

	it("publishes the exact PR comment dry-run operation after grant authorization", async () => {
		const request = vi.fn().mockResolvedValue({ status: 201, ok: true });
		const verifyPrHead = vi.fn().mockResolvedValue({
			number: 42,
			headSha: HEAD_SHA,
		});
		const dryRun = planPrCommentOperation({
			report,
			repository: "SollanSystems/buildplane",
			prNumber: 42,
			headSha: HEAD_SHA,
		});

		const published = await publishPrCommentOperation({
			report,
			repository: "SollanSystems/buildplane",
			prNumber: 42,
			headSha: HEAD_SHA,
			grants: [commentGrant],
			grantId: commentGrant.id,
			credential: () => "cred",
			verifyPrHead,
			request,
		});

		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(dryRun.operation, {
			credential: "cred",
		});
		expect(published.operation).toStrictEqual(dryRun.operation);
		expect(published.sideEffect).toMatchObject({ grantId: commentGrant.id });
	});

	it("does not authorize issue-scoped or different-PR grants for PR comments", () => {
		for (const grantTarget of [
			"repo:SollanSystems/buildplane#issue:42",
			"repo:SollanSystems/buildplane#pr:43",
		]) {
			expect(() =>
				authorizePrCommentPublish({
					sideEffect: {
						id: "side-effect-pr-comment-publish-run-pr-check-pass-pr-42",
						capability: "github.pr_comment",
						action: "publish",
						target: "repo:SollanSystems/buildplane#pr:42",
					},
					grants: [
						{
							...commentGrant,
							targets: [grantTarget],
						},
					],
					grantId: commentGrant.id,
				}),
			).toThrow(/UNSAFE_TO_RUN.*matching capability grant/);
		}
	});

	it("authorizes PR comment publish only for the bound PR target", () => {
		expect(
			authorizePrCommentPublish({
				sideEffect: {
					id: "side-effect-pr-comment-publish-run-pr-check-pass-pr-42",
					capability: "github.pr_comment",
					action: "publish",
					target: "repo:SollanSystems/buildplane#pr:42",
				},
				grants: [commentGrant],
				grantId: commentGrant.id,
			}),
		).toMatchObject({ grantId: commentGrant.id });
	});
});
