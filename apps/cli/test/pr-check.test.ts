import { describe, expect, it, vi } from "vitest";
import {
	authorizePrCheckPublish,
	loadCapabilityGrantsFromJson,
	mapFinalVerdictToCheckConclusion,
	planPrCheckOperation,
	publishPrCheckOperation,
} from "../src/pr-check";

const report = {
	runId: "run-pr-check-pass",
	verdict: "PASSED",
	receipts: { verifier: 2, approvals: 1, rejections: 0 },
	criteria: [{ id: "command-exit:0", status: "PASSED" }],
	issues: [],
};

const publishGrant = {
	id: "grant-pr-check-publish",
	capability: "github.pr_check",
	actions: ["publish"],
	targets: ["repo:SollanSystems/buildplane"],
};

describe("pr-check planning and publishing", () => {
	it("plans the exact GitHub check-run operation for a dry-run", () => {
		const dryRun = planPrCheckOperation({
			report,
			repository: "SollanSystems/buildplane",
			headSha: "abc1234",
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
		expect(dryRun.operation).toStrictEqual({
			method: "POST",
			path: "/repos/SollanSystems/buildplane/check-runs",
			body: {
				name: "Buildplane Evidence",
				head_sha: "abc1234",
				status: "completed",
				conclusion: "success",
				external_id: "run-pr-check-pass",
				details_url: "https://example.test/runs/run-pr-check-pass",
				output: {
					title: "Buildplane Evidence: PASSED",
					summary:
						"Final verdict PASSED for run run-pr-check-pass; GitHub conclusion success.",
					text: JSON.stringify(
						{
							runId: report.runId,
							verdict: report.verdict,
							receipts: report.receipts,
							criteria: report.criteria,
							issues: report.issues,
						},
						null,
						2,
					),
				},
			},
		});
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
					headSha: "abc1234",
				}),
			).toThrow(/Repository/);
		}
	});

	it("fails closed before credential and network for malformed publish repositories", async () => {
		const request = vi.fn();
		const credential = vi.fn(() => "cred");
		const unsafeRepository = "SollanSystems/buildplane?state=passed";

		await expect(
			publishPrCheckOperation({
				report,
				repository: unsafeRepository,
				headSha: "abc1234",
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
				issues: [
					{ code: "MISSING_VERIFIER_RECEIPT", message: "No verifier event" },
					{ code: "UNRESOLVED_BLOCKER", message: "architecture.diff_scope" },
				],
			},
			repository: "SollanSystems/buildplane",
			headSha: "def5678",
		});

		expect(dryRun.operation.body.conclusion).toBe("action_required");
		expect(dryRun.operation.body.output.summary).toContain(
			"MISSING_VERIFIER_RECEIPT",
		);
		expect(dryRun.operation.body.output.summary).toContain(
			"UNRESOLVED_BLOCKER",
		);
	});

	it("fails closed before network when publish lacks a matching grant", async () => {
		const request = vi.fn();

		await expect(
			publishPrCheckOperation({
				report,
				repository: "SollanSystems/buildplane",
				headSha: "abc1234",
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
				headSha: "abc1234",
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
				headSha: "abc1234",
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
				headSha: "abc1234",
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
			headSha: "abc1234",
		});

		const published = await publishPrCheckOperation({
			report,
			repository: "SollanSystems/buildplane",
			headSha: "abc1234",
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
			loadCapabilityGrantsFromJson({ capabilityGrants: [publishGrant] }),
		).toStrictEqual([publishGrant]);
	});
});
