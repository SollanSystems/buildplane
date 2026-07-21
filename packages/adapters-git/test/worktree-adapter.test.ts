import {
	type SpawnSyncOptions,
	type SpawnSyncReturns,
	spawnSync,
} from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { CreateGovernedWorkspaceCandidateInput } from "@buildplane/kernel";
import {
	canonicalActionReceiptRecordedV2Digest,
	canonicalActionRequestedV2Digest,
} from "@buildplane/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createGitWorktreeAdapter,
	createGovernedGitWorktreeAdapter,
} from "../src";

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
	vi.unstubAllEnvs();
});

describe("git worktree adapter", () => {
	it.runIf(process.platform === "linux")(
		"write-aheads and durably receipts candidate Git materialization before it can be sealed",
		async () => {
			const repo = createCommittedRepo();
			const adapter = createGitWorktreeAdapter({
				now: () => "2026-07-18T12:00:00.000Z",
			});
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const workspace = adapter.prepareWorkspace(
				repo,
				"candidate-governed",
				baseSha,
			);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			const rootHeadBefore = readGitHead(repo);
			const rootTreeBefore = readGitTree(repo);
			const rootCommitCountBefore = commitCount(repo);
			const order: string[] = [];
			let actionRequestDigest = "";
			let actionReceiptDigest = "";
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async (actionRequest) => {
						order.push("request");
						actionRequestDigest =
							canonicalActionRequestedV2Digest(actionRequest);
						return {
							actionRequest,
							actionRequestRef: "event://action-request/candidate-governed",
							actionRequestDigest,
						};
					}),
					recordActionReceipt: vi.fn(async (receipt) => {
						order.push("receipt");
						const durableReceipt = {
							...receipt,
							actionReceiptRef: "event://action-receipt/candidate-governed",
						};
						actionReceiptDigest =
							canonicalActionReceiptRecordedV2Digest(durableReceipt);
						return {
							receipt: durableReceipt,
							actionReceiptDigest,
						};
					}),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const input = governedCandidateInput({
				path: workspace.path,
				projectRoot: repo,
				baseSha,
				candidateId: "candidate-governed",
				runId: "candidate-governed",
				attempt: 1,
				actionEvidencePort,
			});

			const created = await adapter.createGovernedWorkspaceCandidate(input);

			expect(order).toEqual(["request", "receipt"]);
			expect(actionEvidencePort.recordActionRequested).toHaveBeenCalledWith(
				expect.objectContaining({
					actionKind: "git",
					actionId:
						"git-candidate-create:candidate-governed/candidate-governed/1",
					governedPacketDigest: input.governedDispatch.governedPacketDigest,
				}),
			);
			expect(actionEvidencePort.recordActionReceipt).toHaveBeenCalledWith(
				expect.objectContaining({
					outcome: "succeeded",
					actionRequestDigest,
					resultRef: `git-ref:${created.candidate.candidateRef}`,
				}),
			);
			expect(created.actionReceipt).toEqual({
				actionId:
					"git-candidate-create:candidate-governed/candidate-governed/1",
				actionReceiptRef: "event://action-receipt/candidate-governed",
				actionReceiptDigest,
			});
			expect(readGitRef(repo, created.candidate.candidateRef)).toBe(
				created.candidate.candidateCommitSha,
			);
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitTree(repo)).toBe(rootTreeBefore);
			expect(commitCount(repo)).toBe(rootCommitCountBefore);
		},
	);

	it("rejects governed candidate materialization without an explicit repository root before write-ahead", async () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(
			repo,
			"candidate-governed-no-root",
			baseSha,
		);
		const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
			{
				recordActionRequested: vi.fn(),
				recordActionReceipt: vi.fn(),
				sealActionReceiptSet: vi.fn(),
				recordCandidateCreatedV2: vi.fn(),
			};
		const input = governedCandidateInput({
			path: workspace.path,
			baseSha,
			candidateId: "candidate-governed-no-root",
			runId: "candidate-governed-no-root",
			attempt: 1,
			actionEvidencePort,
		});

		await expect(
			adapter.createGovernedWorkspaceCandidate(input),
		).rejects.toThrow(/explicit non-empty projectRoot/i);
		expect(actionEvidencePort.recordActionRequested).not.toHaveBeenCalled();
		expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
	});

	it("rejects a root-path alias before governed candidate evidence, claims, or Git mutation", async () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const rootHeadBefore = readGitHead(repo);
		const rootTreeBefore = readGitTree(repo);
		const rootCommitCountBefore = commitCount(repo);
		const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
			{
				recordActionRequested: vi.fn(),
				recordActionReceipt: vi.fn(),
				sealActionReceiptSet: vi.fn(),
				recordCandidateCreatedV2: vi.fn(),
			};
		const activityClaimPort = governedCandidateActivityClaimPort();
		const claim = vi.spyOn(activityClaimPort, "claim");
		const recordResult = vi.spyOn(activityClaimPort, "recordResult");
		const input = governedCandidateInput({
			path: `${repo}${sep}.`,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-governed-root-alias",
			runId: "candidate-governed-root-alias",
			attempt: 1,
			actionEvidencePort,
			activityClaimPort,
		});

		await expect(
			adapter.createGovernedWorkspaceCandidate(input),
		).rejects.toThrow(/distinct detached linked Git worktree/i);

		expect(actionEvidencePort.recordActionRequested).not.toHaveBeenCalled();
		expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
		expect(recordResult).not.toHaveBeenCalled();
		expect(readGitHead(repo)).toBe(rootHeadBefore);
		expect(readGitTree(repo)).toBe(rootTreeBefore);
		expect(commitCount(repo)).toBe(rootCommitCountBefore);
	});

	it("rejects the direct target root before governed candidate evidence, claims, or Git mutation", async () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const rootHeadBefore = readGitHead(repo);
		const rootTreeBefore = readGitTree(repo);
		const rootCommitCountBefore = commitCount(repo);
		const actionEvidencePort = blockedGovernedCandidateEvidencePort();
		const activityClaimPort = governedCandidateActivityClaimPort();
		const claim = vi.spyOn(activityClaimPort, "claim");
		const recordResult = vi.spyOn(activityClaimPort, "recordResult");

		await expect(
			adapter.createGovernedWorkspaceCandidate(
				governedCandidateInput({
					path: repo,
					projectRoot: repo,
					baseSha,
					candidateId: "candidate-governed-direct-root",
					runId: "candidate-governed-direct-root",
					attempt: 1,
					actionEvidencePort,
					activityClaimPort,
				}),
			),
		).rejects.toThrow(/distinct detached linked Git worktree/i);

		expect(actionEvidencePort.recordActionRequested).not.toHaveBeenCalled();
		expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
		expect(recordResult).not.toHaveBeenCalled();
		expect(readGitHead(repo)).toBe(rootHeadBefore);
		expect(readGitTree(repo)).toBe(rootTreeBefore);
		expect(commitCount(repo)).toBe(rootCommitCountBefore);
	});

	it.runIf(process.platform === "linux")(
		"rejects a normal target-root subdirectory before governed candidate evidence or Git mutation",
		async () => {
			const repo = createCommittedRepo();
			const candidatePath = join(repo, "ordinary-subdirectory");
			mkdirSync(candidatePath, { recursive: true });
			const adapter = createGitWorktreeAdapter();
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const rootHeadBefore = readGitHead(repo);
			const rootTreeBefore = readGitTree(repo);
			const rootCommitCountBefore = commitCount(repo);
			const actionEvidencePort = blockedGovernedCandidateEvidencePort();
			const activityClaimPort = governedCandidateActivityClaimPort();
			const claim = vi.spyOn(activityClaimPort, "claim");

			await expect(
				adapter.createGovernedWorkspaceCandidate(
					governedCandidateInput({
						path: candidatePath,
						projectRoot: repo,
						baseSha,
						candidateId: "candidate-governed-root-subdirectory",
						runId: "candidate-governed-root-subdirectory",
						attempt: 1,
						actionEvidencePort,
						activityClaimPort,
					}),
				),
			).rejects.toThrow(/distinct detached linked Git worktree/i);

			expect(actionEvidencePort.recordActionRequested).not.toHaveBeenCalled();
			expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
			expect(claim).not.toHaveBeenCalled();
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitTree(repo)).toBe(rootTreeBefore);
			expect(commitCount(repo)).toBe(rootCommitCountBefore);
		},
	);

	it.runIf(process.platform === "linux")(
		"rejects an attached linked candidate before governed candidate evidence or Git mutation",
		async () => {
			const repo = createCommittedRepo();
			const adapter = createGitWorktreeAdapter();
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const workspace = adapter.prepareWorkspace(
				repo,
				"candidate-governed-attached-worktree",
				baseSha,
			);
			runGitOrThrow(workspace.path, [
				"checkout",
				"-b",
				"candidate-governed-attached-worktree",
			]);
			const rootHeadBefore = readGitHead(repo);
			const rootTreeBefore = readGitTree(repo);
			const rootCommitCountBefore = commitCount(repo);
			const actionEvidencePort = blockedGovernedCandidateEvidencePort();
			const activityClaimPort = governedCandidateActivityClaimPort();
			const claim = vi.spyOn(activityClaimPort, "claim");

			await expect(
				adapter.createGovernedWorkspaceCandidate(
					governedCandidateInput({
						path: workspace.path,
						projectRoot: repo,
						baseSha,
						candidateId: "candidate-governed-attached-worktree",
						runId: "candidate-governed-attached-worktree",
						attempt: 1,
						actionEvidencePort,
						activityClaimPort,
					}),
				),
			).rejects.toThrow(/distinct detached linked Git worktree/i);

			expect(actionEvidencePort.recordActionRequested).not.toHaveBeenCalled();
			expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
			expect(claim).not.toHaveBeenCalled();
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitTree(repo)).toBe(rootTreeBefore);
			expect(commitCount(repo)).toBe(rootCommitCountBefore);
		},
	);

	it.runIf(process.platform === "linux")(
		"rejects an unrelated repository before governed candidate evidence or Git mutation",
		async () => {
			const repo = createCommittedRepo();
			const unrelated = createCommittedRepo();
			const adapter = createGitWorktreeAdapter();
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const rootHeadBefore = readGitHead(repo);
			const rootTreeBefore = readGitTree(repo);
			const rootCommitCountBefore = commitCount(repo);
			const actionEvidencePort = blockedGovernedCandidateEvidencePort();
			const activityClaimPort = governedCandidateActivityClaimPort();
			const claim = vi.spyOn(activityClaimPort, "claim");

			await expect(
				adapter.createGovernedWorkspaceCandidate(
					governedCandidateInput({
						path: unrelated,
						projectRoot: repo,
						baseSha,
						candidateId: "candidate-governed-unrelated-repository",
						runId: "candidate-governed-unrelated-repository",
						attempt: 1,
						actionEvidencePort,
						activityClaimPort,
					}),
				),
			).rejects.toThrow(/distinct detached linked Git worktree/i);

			expect(actionEvidencePort.recordActionRequested).not.toHaveBeenCalled();
			expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
			expect(claim).not.toHaveBeenCalled();
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitTree(repo)).toBe(rootTreeBefore);
			expect(commitCount(repo)).toBe(rootCommitCountBefore);
		},
	);

	it.runIf(process.platform === "linux")(
		"revalidates candidate topology after an activity-claim race before candidate Git writes",
		async () => {
			const repo = createCommittedRepo();
			const adapter = createGitWorktreeAdapter({
				now: () => "2026-07-18T12:00:00.000Z",
			});
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const workspace = adapter.prepareWorkspace(
				repo,
				"candidate-governed-claim-race",
				baseSha,
			);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			const rootHeadBefore = readGitHead(repo);
			const rootTreeBefore = readGitTree(repo);
			const rootCommitCountBefore = commitCount(repo);
			let actionRequestDigest = "";
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async (actionRequest) => {
						actionRequestDigest =
							canonicalActionRequestedV2Digest(actionRequest);
						return {
							actionRequest,
							actionRequestRef:
								"event://action-request/candidate-governed-claim-race",
							actionRequestDigest,
						};
					}),
					recordActionReceipt: vi.fn(async (receipt) => {
						const durableReceipt = {
							...receipt,
							actionReceiptRef:
								"event://action-receipt/candidate-governed-claim-race",
						};
						return {
							receipt: durableReceipt,
							actionReceiptDigest:
								canonicalActionReceiptRecordedV2Digest(durableReceipt),
						};
					}),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			let attachedDuringClaim = false;
			const activityClaimPort = {
				claim: vi.fn(async (claimInput) => {
					runGitOrThrow(workspace.path, [
						"checkout",
						"-b",
						"candidate-governed-claim-race-attached",
					]);
					attachedDuringClaim = true;
					return {
						state: "granted" as const,
						activityId: claimInput.activityId,
						idempotencyKey: claimInput.idempotencyKey,
						claimEventId: "99999999-9999-4999-8999-999999999999",
						claimEventDigest: digest("9"),
						leaseId: "candidate-governed-claim-race-lease",
						leaseExpiresAt: "2026-07-18T12:05:00.000Z",
					};
				}),
				recordResult: vi.fn(async (result) => ({
					state: "recorded" as const,
					resultEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					resultEventDigest: digest("a"),
					resultOutcome: result.outcome,
				})),
			};

			await expect(
				adapter.createGovernedWorkspaceCandidate(
					governedCandidateInput({
						path: workspace.path,
						projectRoot: repo,
						baseSha,
						candidateId: "candidate-governed-claim-race",
						runId: "candidate-governed-claim-race",
						attempt: 1,
						actionEvidencePort,
						activityClaimPort,
					}),
				),
			).rejects.toThrow(/distinct detached linked Git worktree/i);

			expect(attachedDuringClaim).toBe(true);
			expect(actionEvidencePort.recordActionRequested).toHaveBeenCalledTimes(1);
			expect(activityClaimPort.claim).toHaveBeenCalledTimes(1);
			expect(activityClaimPort.recordResult).toHaveBeenCalledWith(
				expect.objectContaining({ outcome: "unknown" }),
			);
			expect(actionEvidencePort.recordActionReceipt).toHaveBeenCalledWith(
				expect.objectContaining({ outcome: "unknown" }),
			);
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitTree(repo)).toBe(rootTreeBefore);
			expect(commitCount(repo)).toBe(rootCommitCountBefore);
			expect(readGitHead(workspace.path)).toBe(baseSha);
			expect(gitStdoutOrThrow(workspace.path, ["status", "--porcelain"])).toBe(
				"?? candidate.txt",
			);
		},
	);

	it.runIf(process.platform === "linux")(
		"snapshots governed candidate identity, paths, dispatch, and evidence authority before an activity claim",
		async () => {
			const repo = createCommittedRepo();
			writeFileSync(join(repo, "later.txt"), "later\n");
			runGitOrThrow(repo, ["add", "later.txt"]);
			runGitOrThrow(repo, ["commit", "-m", "later"]);
			const unrelatedRepo = createCommittedRepo();
			const adapter = createGitWorktreeAdapter({
				now: () => "2026-07-18T12:00:00.000Z",
			});
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const alternateBaseSha = gitStdoutOrThrow(repo, ["rev-parse", "HEAD^"]);
			const workspace = adapter.prepareWorkspace(
				repo,
				"candidate-governed-input-snapshot",
				baseSha,
			);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			const rootHeadBefore = readGitHead(repo);
			const rootTreeBefore = readGitTree(repo);
			const rootCommitCountBefore = commitCount(repo);
			const unrelatedHeadBefore = readGitHead(unrelatedRepo);
			const originalCandidateId = "candidate-governed-input-snapshot";
			const originalRunId = "candidate-governed-input-snapshot";
			let actionRequestDigest = "";
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async (actionRequest) => {
						actionRequestDigest =
							canonicalActionRequestedV2Digest(actionRequest);
						return {
							actionRequest,
							actionRequestRef:
								"event://action-request/candidate-governed-input-snapshot",
							actionRequestDigest,
						};
					}),
					recordActionReceipt: vi.fn(async (receipt) => {
						const durableReceipt = {
							...receipt,
							actionReceiptRef:
								"event://action-receipt/candidate-governed-input-snapshot",
						};
						return {
							receipt: durableReceipt,
							actionReceiptDigest:
								canonicalActionReceiptRecordedV2Digest(durableReceipt),
						};
					}),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const replacementEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async () => {
						throw new Error(
							"mutated evidence authority must not receive request",
						);
					}),
					recordActionReceipt: vi.fn(async () => {
						throw new Error(
							"mutated evidence authority must not receive receipt",
						);
					}),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const input = governedCandidateInput({
				path: workspace.path,
				projectRoot: repo,
				baseSha,
				candidateId: originalCandidateId,
				runId: originalRunId,
				attempt: 1,
				actionEvidencePort,
				activityClaimPort: {
					claim: vi.fn(async (claimInput) => {
						expect(claimInput.dispatch).toMatchObject({
							runId: originalRunId,
							attempt: 1,
							baseCommitSha: baseSha,
							idempotencyKey: "governed-candidate-dispatch",
						});
						Object.assign(input, {
							candidateId: "candidate-mutated-after-claim",
							runId: "run-mutated-after-claim",
							attempt: 2,
							baseSha: alternateBaseSha,
							path: repo,
							projectRoot: unrelatedRepo,
							actionEvidencePort: replacementEvidencePort,
						});
						Object.assign(input.governedDispatch, {
							runId: "run-mutated-after-claim",
							attempt: 2,
							baseCommitSha: alternateBaseSha,
							workflowId: "workflow-mutated-after-claim",
							idempotencyKey: "dispatch-mutated-after-claim",
						});
						return {
							state: "granted" as const,
							activityId: claimInput.activityId,
							idempotencyKey: claimInput.idempotencyKey,
							claimEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
							claimEventDigest: digest("e"),
							leaseId: "candidate-governed-input-snapshot-lease",
							leaseExpiresAt: "2026-07-18T12:05:00.000Z",
						};
					}),
					recordResult: vi.fn(async (result) => {
						expect(result.dispatch).toMatchObject({
							runId: originalRunId,
							attempt: 1,
							baseCommitSha: baseSha,
							workflowId: "workflow-governed-candidate",
							idempotencyKey: "governed-candidate-dispatch",
						});
						return {
							state: "recorded" as const,
							resultEventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
							resultEventDigest: digest("f"),
							resultOutcome: result.outcome,
						};
					}),
				},
			});

			const created = await adapter.createGovernedWorkspaceCandidate(input);

			expect(created.candidate).toMatchObject({
				candidateId: originalCandidateId,
				runId: originalRunId,
				attempt: 1,
				baseSha,
			});
			expect(created.candidate.candidateRef).toContain(
				`${originalCandidateId}/${originalRunId}/1`,
			);
			expect(readGitRef(repo, created.candidate.candidateRef)).toBe(
				created.candidate.candidateCommitSha,
			);
			expect(readGitHead(workspace.path)).toBe(
				created.candidate.candidateCommitSha,
			);
			expect(actionEvidencePort.recordActionRequested).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: originalRunId,
					attempt: 1,
					actionId: `git-candidate-create:${originalCandidateId}/${originalRunId}/1`,
				}),
			);
			expect(actionEvidencePort.recordActionReceipt).toHaveBeenCalledTimes(1);
			expect(
				replacementEvidencePort.recordActionReceipt,
			).not.toHaveBeenCalled();
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitTree(repo)).toBe(rootTreeBefore);
			expect(commitCount(repo)).toBe(rootCommitCountBefore);
			expect(readGitHead(unrelatedRepo)).toBe(unrelatedHeadBefore);
		},
	);

	it.runIf(process.platform === "linux")(
		"accepts a detached linked candidate nested below a subdirectory projectRoot",
		async () => {
			const repo = createCommittedRepo();
			const projectRoot = join(repo, "packages", "cli");
			mkdirSync(projectRoot, { recursive: true });
			const adapter = createGitWorktreeAdapter({
				now: () => "2026-07-18T12:00:00.000Z",
			});
			const { headSha: baseSha } =
				adapter.assertRunnableRepository(projectRoot);
			const workspace = adapter.prepareWorkspace(
				projectRoot,
				"candidate-governed-subdirectory-project-root",
				baseSha,
			);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			let actionRequestDigest = "";
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async (actionRequest) => {
						actionRequestDigest =
							canonicalActionRequestedV2Digest(actionRequest);
						return {
							actionRequest,
							actionRequestRef:
								"event://action-request/candidate-governed-subdirectory-project-root",
							actionRequestDigest,
						};
					}),
					recordActionReceipt: vi.fn(async (receipt) => {
						const durableReceipt = {
							...receipt,
							actionReceiptRef:
								"event://action-receipt/candidate-governed-subdirectory-project-root",
						};
						return {
							receipt: durableReceipt,
							actionReceiptDigest:
								canonicalActionReceiptRecordedV2Digest(durableReceipt),
						};
					}),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const created = await adapter.createGovernedWorkspaceCandidate(
				governedCandidateInput({
					path: workspace.path,
					projectRoot,
					baseSha,
					candidateId: "candidate-governed-subdirectory-project-root",
					runId: "candidate-governed-subdirectory-project-root",
					attempt: 1,
					actionEvidencePort,
				}),
			);

			expect(created.candidate.baseSha).toBe(baseSha);
			expect(actionEvidencePort.recordActionRequested).toHaveBeenCalledTimes(1);
			expect(actionEvidencePort.recordActionReceipt).toHaveBeenCalledTimes(1);
			expect(readGitHead(repo)).toBe(baseSha);
		},
	);

	it.runIf(process.platform === "linux")(
		"claims and terminally records the candidate Git activity before sealing its receipt",
		async () => {
			const repo = createCommittedRepo();
			const adapter = createGitWorktreeAdapter({
				now: () => "2026-07-18T12:00:00.000Z",
			});
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const workspace = adapter.prepareWorkspace(
				repo,
				"candidate-governed-activity",
				baseSha,
			);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			const order: string[] = [];
			let actionRequestDigest = "";
			let actionReceiptDigest = "";
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async (actionRequest) => {
						order.push("request");
						actionRequestDigest =
							canonicalActionRequestedV2Digest(actionRequest);
						return {
							actionRequest,
							actionRequestRef:
								"event://action-request/candidate-governed-activity",
							actionRequestDigest,
						};
					}),
					recordActionReceipt: vi.fn(async (receipt) => {
						order.push("receipt");
						const durableReceipt = {
							...receipt,
							actionReceiptRef:
								"event://action-receipt/candidate-governed-activity",
						};
						actionReceiptDigest =
							canonicalActionReceiptRecordedV2Digest(durableReceipt);
						return {
							receipt: durableReceipt,
							actionReceiptDigest,
						};
					}),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const activityClaimPort = {
				claim: vi.fn(async () => {
					order.push("claim");
					return {
						state: "granted" as const,
						activityId:
							"git-candidate-create:candidate-governed-activity/candidate-governed-activity/1",
						idempotencyKey: "governed-candidate-dispatch:git-candidate-create",
						claimEventId: "11111111-1111-4111-8111-111111111111",
						claimEventDigest: digest("2"),
						leaseId: "candidate-git-lease",
						leaseExpiresAt: "2026-07-18T12:05:00.000Z",
					};
				}),
				recordResult: vi.fn(async () => {
					order.push("result");
					return {
						state: "recorded" as const,
						resultEventId: "22222222-2222-4222-8222-222222222222",
						resultEventDigest: digest("3"),
						resultOutcome: "succeeded" as const,
					};
				}),
			};
			const input = {
				...governedCandidateInput({
					path: workspace.path,
					projectRoot: repo,
					baseSha,
					candidateId: "candidate-governed-activity",
					runId: "candidate-governed-activity",
					attempt: 1,
					actionEvidencePort,
				}),
				activityClaimPort,
			};

			const created = await adapter.createGovernedWorkspaceCandidate(input);

			expect(order).toEqual(["request", "claim", "result", "receipt"]);
			expect(created.candidateCreateActionEvidence).toEqual({
				actionId:
					"git-candidate-create:candidate-governed-activity/candidate-governed-activity/1",
				actionRequestRef: "event://action-request/candidate-governed-activity",
				actionRequestDigest,
				activityClaimEventRef: "11111111-1111-4111-8111-111111111111",
				activityClaimEventDigest: digest("2"),
				activityResultEventRef: "22222222-2222-4222-8222-222222222222",
				activityResultEventDigest: digest("3"),
				actionReceiptRef: "event://action-receipt/candidate-governed-activity",
				actionReceiptDigest,
			});
			expect(activityClaimPort.claim).toHaveBeenCalledWith(
				expect.objectContaining({
					activityId:
						"git-candidate-create:candidate-governed-activity/candidate-governed-activity/1",
					idempotencyKey: "governed-candidate-dispatch:git-candidate-create",
					durableRequest: expect.objectContaining({
						actionRequest: expect.objectContaining({
							governedPacketDigest: input.governedDispatch.governedPacketDigest,
						}),
					}),
				}),
			);
			expect(activityClaimPort.recordResult).toHaveBeenCalledWith(
				expect.objectContaining({
					outcome: "succeeded",
					resultDigest: expect.any(String),
					resultRef: `git-ref:${created.candidate.candidateRef}`,
				}),
			);
		},
	);

	it.runIf(process.platform === "linux")(
		"fails closed before candidate Git materialization when the native activity claim is not granted",
		async () => {
			const repo = createCommittedRepo();
			const adapter = createGitWorktreeAdapter({
				now: () => "2026-07-18T12:00:00.000Z",
			});
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const workspace = adapter.prepareWorkspace(
				repo,
				"candidate-governed-claim-denied",
				baseSha,
			);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			const rootHeadBefore = readGitHead(repo);
			const rootTreeBefore = readGitTree(repo);
			const order: string[] = [];
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async (actionRequest) => {
						order.push("request");
						return {
							actionRequest,
							actionRequestRef:
								"event://action-request/candidate-governed-claim-denied",
							actionRequestDigest:
								canonicalActionRequestedV2Digest(actionRequest),
						};
					}),
					recordActionReceipt: vi.fn(),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const activityClaimPort = {
				claim: vi.fn(async () => {
					order.push("claim");
					return {
						state: "rejected" as const,
						code: "DUPLICATE_OR_DENIED",
						message: "native reducer denied the candidate Git activity",
					};
				}),
				recordResult: vi.fn(),
			};
			const input = {
				...governedCandidateInput({
					path: workspace.path,
					projectRoot: repo,
					baseSha,
					candidateId: "candidate-governed-claim-denied",
					runId: "candidate-governed-claim-denied",
					attempt: 1,
					actionEvidencePort,
				}),
				activityClaimPort,
			};

			await expect(
				adapter.createGovernedWorkspaceCandidate(input),
			).rejects.toThrow(/not granted a native activity lease/i);

			expect(order).toEqual(["request", "claim"]);
			expect(activityClaimPort.recordResult).not.toHaveBeenCalled();
			expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitTree(repo)).toBe(rootTreeBefore);
			expect(readGitHead(workspace.path)).toBe(baseSha);
		},
	);

	it.runIf(process.platform === "linux")(
		"records an unknown native result before the unknown receipt when candidate Git materialization fails closed",
		async () => {
			const repo = createCommittedRepo();
			const candidateId = "candidate-governed-unknown";
			const runId = "candidate-governed-unknown";
			const candidateRef = `refs/buildplane/candidates/${candidateId}/${runId}/1`;
			const adapter = createGitWorktreeAdapter({
				now: () => "2026-07-18T12:00:00.000Z",
			});
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const workspace = adapter.prepareWorkspace(repo, runId, baseSha);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			const candidateGitDir = gitStdoutOrThrow(workspace.path, [
				"rev-parse",
				"--absolute-git-dir",
			]);
			const rootHeadBefore = readGitHead(repo);
			const order: string[] = [];
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async (actionRequest) => {
						order.push("request");
						return {
							actionRequest,
							actionRequestRef:
								"event://action-request/candidate-governed-unknown",
							actionRequestDigest:
								canonicalActionRequestedV2Digest(actionRequest),
						};
					}),
					recordActionReceipt: vi.fn(async (receipt) => {
						order.push(`receipt:${receipt.outcome}`);
						const durableReceipt = {
							...receipt,
							actionReceiptRef:
								"event://action-receipt/candidate-governed-unknown",
						};
						return {
							receipt: durableReceipt,
							actionReceiptDigest:
								canonicalActionReceiptRecordedV2Digest(durableReceipt),
						};
					}),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const activityClaimPort = {
				claim: vi.fn(async (claimInput) => {
					order.push("claim");
					// This is a real, local Git write denial after the native grant. The
					// governed runner remains pinned; no injectable raw runner is used.
					writeFileSync(join(candidateGitDir, "index.lock"), "locked\n");
					return {
						state: "granted" as const,
						activityId: claimInput.activityId,
						idempotencyKey: claimInput.idempotencyKey,
						claimEventId: "55555555-5555-4555-8555-555555555555",
						claimEventDigest: digest("6"),
						leaseId: "candidate-unknown-lease",
						leaseExpiresAt: "2026-07-18T12:05:00.000Z",
					};
				}),
				recordResult: vi.fn(async (resultInput) => {
					order.push(`result:${resultInput.outcome}`);
					return {
						state: "recorded" as const,
						resultEventId: "66666666-6666-4666-8666-666666666666",
						resultEventDigest: digest("7"),
						resultOutcome: resultInput.outcome,
					};
				}),
			};
			const input = {
				...governedCandidateInput({
					path: workspace.path,
					projectRoot: repo,
					baseSha,
					candidateId,
					runId,
					attempt: 1,
					actionEvidencePort,
				}),
				activityClaimPort,
			};

			await expect(
				adapter.createGovernedWorkspaceCandidate(input),
			).rejects.toThrow(/candidate staging failed|unknown effect state/i);

			expect(order).toEqual([
				"request",
				"claim",
				"result:unknown",
				"receipt:unknown",
			]);
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitHead(workspace.path)).toBe(baseSha);
			expect(
				runGit(repo, ["rev-parse", "--verify", `${candidateRef}^{commit}`])
					.status,
			).not.toBe(0);
		},
	);

	it.runIf(process.platform === "linux")(
		"does not write a V2 receipt when the terminal native candidate activity result is ambiguous",
		async () => {
			const repo = createCommittedRepo();
			const candidateId = "candidate-governed-result-ambiguous";
			const runId = "candidate-governed-result-ambiguous";
			const candidateRef = `refs/buildplane/candidates/${candidateId}/${runId}/1`;
			const adapter = createGitWorktreeAdapter({
				now: () => "2026-07-18T12:00:00.000Z",
			});
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const workspace = adapter.prepareWorkspace(repo, runId, baseSha);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			const rootHeadBefore = readGitHead(repo);
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async (actionRequest) => ({
						actionRequest,
						actionRequestRef:
							"event://action-request/candidate-governed-result-ambiguous",
						actionRequestDigest:
							canonicalActionRequestedV2Digest(actionRequest),
					})),
					recordActionReceipt: vi.fn(),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const activityClaimPort = {
				claim: vi.fn(async (claimInput) => ({
					state: "granted" as const,
					activityId: claimInput.activityId,
					idempotencyKey: claimInput.idempotencyKey,
					claimEventId: "77777777-7777-4777-8777-777777777777",
					claimEventDigest: digest("8"),
					leaseId: "candidate-result-ambiguous-lease",
					leaseExpiresAt: "2026-07-18T12:05:00.000Z",
				})),
				recordResult: vi.fn(async () => {
					throw new Error("native activity result write became ambiguous");
				}),
			};
			const input = {
				...governedCandidateInput({
					path: workspace.path,
					projectRoot: repo,
					baseSha,
					candidateId,
					runId,
					attempt: 1,
					actionEvidencePort,
				}),
				activityClaimPort,
			};

			await expect(
				adapter.createGovernedWorkspaceCandidate(input),
			).rejects.toThrow(/unknown effect state and requires reconciliation/i);

			expect(activityClaimPort.recordResult).toHaveBeenCalledWith(
				expect.objectContaining({ outcome: "succeeded" }),
			);
			expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
			expect(readGitRef(repo, candidateRef)).not.toBe(baseSha);
			expect(readGitHead(repo)).toBe(rootHeadBefore);
		},
	);

	it.runIf(process.platform === "linux")(
		"does not materialize a candidate when durable Git action intent fails",
		async () => {
			const repo = createCommittedRepo();
			const adapter = createGitWorktreeAdapter();
			const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
			const workspace = adapter.prepareWorkspace(
				repo,
				"candidate-governed-request-fail",
				baseSha,
			);
			writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
			const rootHeadBefore = readGitHead(repo);
			const rootTreeBefore = readGitTree(repo);
			const actionEvidencePort: CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] =
				{
					recordActionRequested: vi.fn(async () => {
						throw new Error("tape unavailable");
					}),
					recordActionReceipt: vi.fn(),
					sealActionReceiptSet: vi.fn(),
					recordCandidateCreatedV2: vi.fn(),
				};
			const input = governedCandidateInput({
				path: workspace.path,
				projectRoot: repo,
				baseSha,
				candidateId: "candidate-governed-request-fail",
				runId: "candidate-governed-request-fail",
				attempt: 1,
				actionEvidencePort,
			});

			await expect(
				adapter.createGovernedWorkspaceCandidate(input),
			).rejects.toThrow("tape unavailable");

			expect(actionEvidencePort.recordActionReceipt).not.toHaveBeenCalled();
			expect(readGitHead(repo)).toBe(rootHeadBefore);
			expect(readGitTree(repo)).toBe(rootTreeBefore);
			expect(
				runGit(repo, [
					"rev-parse",
					"--verify",
					"refs/buildplane/candidates/candidate-governed-request-fail/candidate-governed-request-fail/1^{commit}",
				]).status,
			).not.toBe(0);
		},
	);

	it.skipIf(process.platform === "linux")(
		"blocks governed repository preparation instead of falling back to host Git",
		() => {
			const repo = createCommittedRepo();
			const headBefore = readGitHead(repo);
			const adapter = createGovernedGitWorktreeAdapter();

			expect(() => adapter.assertRunnableRepository(repo)).toThrow(
				/Linux or WSL|host-shell fallback/i,
			);
			expect(readGitHead(repo)).toBe(headBefore);
		},
	);

	it("does not expose raw target or candidate mutation primitives from the governed adapter", () => {
		const repo = createCommittedRepo();
		const rootHeadBefore = readGitHead(repo);
		const rootTreeBefore = readGitTree(repo);
		const rootCommitCountBefore = commitCount(repo);
		const adapter = createGovernedGitWorktreeAdapter();
		const typeExposesRawCandidateWriter: "createWorkspaceCandidate" extends keyof typeof adapter
			? true
			: false = false;
		const rawCandidateWriter = (
			adapter as unknown as { readonly createWorkspaceCandidate?: unknown }
		).createWorkspaceCandidate;

		expect(Object.hasOwn(adapter, "commitAndMergeWorkspace")).toBe(false);
		expect(Object.hasOwn(adapter, "createWorkspaceCandidate")).toBe(false);
		expect(Object.hasOwn(adapter, "promoteWorkspaceCandidate")).toBe(false);
		expect(Object.hasOwn(adapter, "promoteGovernedWorkspaceCandidate")).toBe(
			false,
		);
		expect(typeExposesRawCandidateWriter).toBe(false);
		expect(rawCandidateWriter).toBeUndefined();
		expect(readGitHead(repo)).toBe(rootHeadBefore);
		expect(readGitTree(repo)).toBe(rootTreeBefore);
		expect(commitCount(repo)).toBe(rootCommitCountBefore);
	});

	it.runIf(process.platform === "linux")(
		"uses the marked governed boundary while permitting worktreeConfig after effective-config scanning",
		() => {
			const repo = createCommittedRepo();
			runGitOrThrow(repo, ["config", "extensions.worktreeConfig", "true"]);
			const adapter = createGovernedGitWorktreeAdapter();

			expect(adapter.governedWorkspaceBoundary).toBe("pinned-governed-git-v1");
			expect(adapter.assertRunnableRepository(repo).headSha).toBe(
				readGitHead(repo),
			);
		},
	);

	it.runIf(process.platform === "linux")(
		"rejects a helper-bearing local Git configuration before governed Git can mutate the repository",
		() => {
			const repo = createCommittedRepo();
			const headBefore = readGitHead(repo);
			runGitOrThrow(repo, ["config", "filter.untrusted.process", "/bin/true"]);
			const adapter = createGovernedGitWorktreeAdapter();

			expect(() => adapter.assertRunnableRepository(repo)).toThrow(
				/filter\.untrusted\.process|unsafe Git configuration/i,
			);
			expect(readGitHead(repo)).toBe(headBefore);
		},
	);

	it("pins HEAD, creates a deterministic worktree, and deletes it", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		const { headSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "run-1", headSha);

		expect(workspace).toEqual({
			path: join(repo, ".buildplane", "workspaces", "run-1"),
			headSha,
		});
		expect(readGitHead(workspace.path)).toBe(headSha);
		expect(existsSync(workspace.path)).toBe(true);

		const deleted = adapter.deleteWorkspace(workspace);

		expect(deleted).toEqual({ deleted: true });
		expect(existsSync(workspace.path)).toBe(false);
	});

	it("creates from the supplied pinned headSha even after source HEAD moves", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha } = adapter.assertRunnableRepository(repo);

		writeFileSync(join(repo, "future.txt"), "future\n");
		runGitOrThrow(repo, ["add", "future.txt"]);
		runGitOrThrow(repo, ["commit", "-m", "future"]);
		const movedHeadSha = readGitHead(repo);

		const workspace = adapter.prepareWorkspace(repo, "run-2", headSha);

		expect(movedHeadSha).not.toBe(headSha);
		expect(readGitHead(workspace.path)).toBe(headSha);
		expect(existsSync(join(workspace.path, "future.txt"))).toBe(false);
	});

	it("fails clearly when the git binary is unavailable", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter({
			gitBinary: "git-definitely-missing-buildplane",
		});

		expect(() => adapter.assertRunnableRepository(repo)).toThrow(
			/git .* unavailable/i,
		);
	});

	it("fails clearly when the project root is not a git repository", () => {
		const root = createTempRoot("buildplane-not-git-");
		const adapter = createGitWorktreeAdapter();

		expect(() => adapter.assertRunnableRepository(root)).toThrow(
			/not a git repository|does not appear to be inside a git repository/i,
		);
	});

	it("ignores inherited git environment when targeting a repository", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		vi.stubEnv("GIT_DIR", "/definitely/not/the/repo/.git");
		vi.stubEnv("GIT_WORK_TREE", "/definitely/not/the/repo");
		vi.stubEnv("GIT_INDEX_FILE", "/definitely/not/the/repo/index");

		expect(adapter.assertRunnableRepository(repo)).toEqual({
			headSha: readGitHead(repo),
		});
	});

	it("rejects dirty repositories while ignoring persisted buildplane state", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		mkdirSync(join(repo, ".buildplane", "logs"), { recursive: true });
		mkdirSync(join(repo, ".buildplane", "vcr", "run-1", "outputs"), {
			recursive: true,
		});
		writeFileSync(join(repo, ".buildplane", "state.db"), "sqlite\n");
		writeFileSync(
			join(repo, ".buildplane", "project.json"),
			'{"schemaVersion":1}\n',
		);
		writeFileSync(
			join(repo, ".buildplane", "logs", "run-1.stdout.log"),
			"ignored\n",
		);
		writeFileSync(
			join(repo, ".buildplane", "vcr", "run-1", "outputs", "result.txt"),
			"ignored\n",
		);

		expect(adapter.assertRunnableRepository(repo)).toEqual({
			headSha: readGitHead(repo),
		});

		writeFileSync(join(repo, "dirty.txt"), "dirty\n");

		expect(() => adapter.assertRunnableRepository(repo)).toThrow(
			/working tree is not clean/i,
		);
	});

	it("does not let retained leftovers under .buildplane/workspaces poison cleanliness checks", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		mkdirSync(join(repo, ".buildplane", "workspaces", "run-retained"), {
			recursive: true,
		});
		writeFileSync(
			join(repo, ".buildplane", "workspaces", "run-retained", "log.txt"),
			"left behind\n",
		);

		expect(adapter.assertRunnableRepository(repo)).toEqual({
			headSha: readGitHead(repo),
		});
	});

	it("rejects dirty packet inputs stored under .buildplane", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();

		mkdirSync(join(repo, ".buildplane", "packets"), { recursive: true });
		writeFileSync(
			join(repo, ".buildplane", "packets", "packet.json"),
			'{"name":"baseline"}\n',
		);
		runGitOrThrow(repo, ["add", ".buildplane/packets/packet.json"]);
		runGitOrThrow(repo, ["commit", "-m", "add packet fixture"]);
		writeFileSync(
			join(repo, ".buildplane", "packets", "packet.json"),
			'{"name":"dirty"}\n',
		);

		expect(() => adapter.assertRunnableRepository(repo)).toThrow(
			/working tree is not clean/i,
		);
	});

	it("checks cleanliness from the repository root even when invoked from a subdirectory", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const nestedRoot = join(repo, "packages", "cli");
		mkdirSync(nestedRoot, { recursive: true });
		writeFileSync(join(repo, "root-dirty.txt"), "dirty\n");

		expect(() => adapter.assertRunnableRepository(nestedRoot)).toThrow(
			/working tree is not clean/i,
		);
	});

	it("rejects unresolved HEAD in an empty repository", () => {
		const repo = createEmptyRepo();
		const adapter = createGitWorktreeAdapter();

		expect(() => adapter.assertRunnableRepository(repo)).toThrow(
			/unresolved HEAD|HEAD/i,
		);
	});

	it("surfaces worktree creation failures cleanly", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				if (args[0] === "worktree" && args[1] === "add") {
					return failureResult(
						options,
						"fatal: synthetic worktree add failure",
					);
				}
				return spawnSync("git", args, options);
			}),
		});
		const { headSha } = adapter.assertRunnableRepository(repo);

		expect(() => adapter.prepareWorkspace(repo, "run-3", headSha)).toThrow(
			/worktree add failed|synthetic worktree add failure/i,
		);
	});

	it("uses a buildplane git identity when repo config is absent", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const isolatedHome = createTempRoot("buildplane-git-home-");
		const isolatedConfigHome = createTempRoot("buildplane-git-xdg-");
		vi.stubEnv("HOME", isolatedHome);
		vi.stubEnv("XDG_CONFIG_HOME", isolatedConfigHome);
		vi.stubEnv("GIT_CONFIG_GLOBAL", join(isolatedHome, ".gitconfig"));
		runGitOrThrow(repo, ["config", "--unset", "user.name"]);
		runGitOrThrow(repo, ["config", "--unset", "user.email"]);
		const { headSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "run-identity", headSha);
		writeFileSync(join(workspace.path, "generated.txt"), "generated\n");

		expect(() =>
			adapter.commitAndMergeWorkspace({
				path: workspace.path,
				runId: "run-identity",
				projectRoot: repo,
			}),
		).not.toThrow();
		expect(existsSync(join(repo, "generated.txt"))).toBe(true);
	});

	it("surfaces delete failures cleanly", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				if (args[0] === "worktree" && args[1] === "remove") {
					return failureResult(
						options,
						"fatal: synthetic worktree remove failure",
					);
				}
				return spawnSync("git", args, options);
			}),
		});
		const { headSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "run-4", headSha);

		expect(adapter.deleteWorkspace(workspace)).toEqual({
			deleted: false,
			cleanupError: expect.stringMatching(
				/worktree remove failed|synthetic worktree remove failure/i,
			),
		});
		expect(existsSync(workspace.path)).toBe(true);
	});

	it("returns the project-root post-merge HEAD as mergedHeadSha", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "run-merge", baseSha);
		writeFileSync(join(workspace.path, "feature.txt"), "feature\n");

		const result = adapter.commitAndMergeWorkspace({
			path: workspace.path,
			runId: "run-merge",
			projectRoot: repo,
		});

		const projectHeadAfterMerge = readGitHead(repo);
		expect(result).toEqual({ mergedHeadSha: projectHeadAfterMerge });
		// --no-ff always creates a new merge commit, so the anchor advanced off base
		expect(result.mergedHeadSha).not.toBe(baseSha);
		// and it is the project root tip, not the worktree's own commit tip
		expect(result.mergedHeadSha).not.toBe(readGitHead(workspace.path));
	});

	it("creates an immutable candidate ref without mutating the target root", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "candidate-run", baseSha);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const rootHeadBefore = readGitHead(repo);
		const rootTreeBefore = readGitTree(repo);
		const rootCommitCountBefore = commitCount(repo);

		const candidate = adapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-a",
			runId: "candidate-run",
			attempt: 1,
		});

		expect(candidate).toMatchObject({
			schemaVersion: 1,
			candidateKey: "candidate-a/candidate-run/1",
			candidateRef: "refs/buildplane/candidates/candidate-a/candidate-run/1",
			baseSha,
		});
		expect(candidate.candidateCommitSha).toMatch(/^[a-f0-9]{40,64}$/);
		for (const digest of [
			candidate.commitDigest,
			candidate.treeDigest,
			candidate.patchDigest,
			candidate.changedFilesDigest,
			candidate.candidateDigest,
		]) {
			expect(digest).toMatch(/^[a-f0-9]{64}$/);
		}
		expect(readGitRef(repo, candidate.candidateRef)).toBe(
			candidate.candidateCommitSha,
		);
		expect(readGitHead(repo)).toBe(rootHeadBefore);
		expect(readGitTree(repo)).toBe(rootTreeBefore);
		expect(commitCount(repo)).toBe(rootCommitCountBefore);
	});

	it("rejects candidate identity segments that cannot form a canonical candidate ref", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "candidate-lock", baseSha);
		const rootHeadBefore = readGitHead(repo);
		const rootCommitCountBefore = commitCount(repo);

		expect(
			captureThrown(() =>
				adapter.createWorkspaceCandidate({
					path: workspace.path,
					projectRoot: repo,
					baseSha,
					candidateId: "candidate.lock",
					runId: "candidate-lock",
					attempt: 1,
				}),
			),
		).toMatchObject({ code: "CANDIDATE_INVALID_IDENTITY" });
		expect(readGitHead(repo)).toBe(rootHeadBefore);
		expect(commitCount(repo)).toBe(rootCommitCountBefore);
	});

	it("returns the durable candidate ref unchanged when candidate creation is replayed", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "candidate-idem", baseSha);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const input = {
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-idem",
			runId: "candidate-idem",
			attempt: 2,
		};

		const first = adapter.createWorkspaceCandidate(input);
		const rootHeadAfterFirst = readGitHead(repo);
		const second = adapter.createWorkspaceCandidate(input);

		expect(second).toEqual(first);
		expect(readGitRef(repo, first.candidateRef)).toBe(first.candidateCommitSha);
		expect(readGitHead(repo)).toBe(rootHeadAfterFirst);
	});

	it("fails closed instead of reusing an ambiguous candidate commit before its ref exists", () => {
		const repo = createCommittedRepo();
		let failCandidateRefCreation = true;
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				if (
					failCandidateRefCreation &&
					args[0] === "update-ref" &&
					args[1]?.startsWith("refs/buildplane/candidates/")
				) {
					failCandidateRefCreation = false;
					return failureResult(options, "synthetic candidate ref failure");
				}
				return spawnSync("git", args, options);
			}),
		});
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(
			repo,
			"candidate-pre-ref",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const input = {
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-pre-ref",
			runId: "candidate-pre-ref",
			attempt: 1,
		};
		const rootHeadBefore = readGitHead(repo);
		const rootCommitCountBefore = commitCount(repo);

		expect(
			captureThrown(() => adapter.createWorkspaceCandidate(input)),
		).toMatchObject({
			code: "CANDIDATE_REF_MISMATCH",
		});
		expect(readGitHead(workspace.path)).not.toBe(baseSha);
		expect(readGitHead(repo)).toBe(rootHeadBefore);
		expect(commitCount(repo)).toBe(rootCommitCountBefore);
		expect(
			runGit(repo, [
				"rev-parse",
				"--verify",
				"refs/buildplane/candidates/candidate-pre-ref/candidate-pre-ref/1^{commit}",
			]).status,
		).not.toBe(0);

		// A matching subject and parent are not proof that this is the original
		// candidate. Without the durable ref, retrying must require reconciliation.
		expect(
			captureThrown(() => adapter.createWorkspaceCandidate(input)),
		).toMatchObject({
			code: "CANDIDATE_WORKSPACE_HEAD_MISMATCH",
		});
		expect(readGitHead(repo)).toBe(rootHeadBefore);
		expect(commitCount(repo)).toBe(rootCommitCountBefore);
	});

	it("does not recover a same-parent promotion whose tree differs from the candidate", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(
			repo,
			"candidate-forged-promotion",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = adapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-forged-promotion",
			runId: "candidate-forged-promotion",
			attempt: 1,
		});
		const baseTree = gitStdoutOrThrow(repo, ["rev-parse", `${baseSha}^{tree}`]);
		const forgedPromotion = gitStdoutOrThrow(repo, [
			"commit-tree",
			baseTree,
			"-p",
			baseSha,
			"-p",
			candidate.candidateCommitSha,
			"-m",
			`feat: promote buildplane candidate ${candidate.candidateDigest}`,
		]);
		runGitOrThrow(repo, ["update-ref", "HEAD", forgedPromotion, baseSha]);

		expect(readGitHead(repo)).toBe(forgedPromotion);
		expect(readGitTree(repo)).toBe(baseTree);
		expect(readGitTreeAt(repo, candidate.candidateCommitSha)).not.toBe(
			baseTree,
		);

		// The forged merge has the right subject and parents, but its tree is not
		// the reviewed candidate. It is stale, not an idempotent prior promotion.
		expect(
			captureThrown(() =>
				adapter.promoteWorkspaceCandidate({
					projectRoot: repo,
					candidate,
					targetRef: readGitTargetRef(repo),
				}),
			),
		).toMatchObject({ code: "CANDIDATE_STALE_BASE" });
		expect(readGitHead(repo)).toBe(forgedPromotion);
		expect(existsSync(join(repo, "candidate.txt"))).toBe(false);
	});

	it("denies stale-base and digest-mismatched candidate promotion without advancing root", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "candidate-deny", baseSha);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = adapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-deny",
			runId: "candidate-deny",
			attempt: 1,
		});
		const rootHeadBeforeMismatch = readGitHead(repo);

		expect(
			captureThrown(() =>
				adapter.promoteWorkspaceCandidate({
					projectRoot: repo,
					targetRef: readGitTargetRef(repo),
					candidate: {
						...candidate,
						candidateRef:
							"refs/buildplane/candidates/candidate-deny/not-this-run/1",
					},
				}),
			),
		).toMatchObject({ code: "CANDIDATE_REF_MISMATCH" });
		expect(readGitHead(repo)).toBe(rootHeadBeforeMismatch);

		expect(
			captureThrown(() =>
				adapter.promoteWorkspaceCandidate({
					projectRoot: repo,
					targetRef: readGitTargetRef(repo),
					candidate: { ...candidate, candidateDigest: "0".repeat(64) },
				}),
			),
		).toMatchObject({ code: "CANDIDATE_DIGEST_MISMATCH" });
		expect(readGitHead(repo)).toBe(rootHeadBeforeMismatch);

		writeFileSync(join(repo, "intervening.txt"), "intervening\n");
		runGitOrThrow(repo, ["add", "intervening.txt"]);
		runGitOrThrow(repo, ["commit", "-m", "intervening target change"]);
		const rootHeadAfterIntervening = readGitHead(repo);

		expect(
			captureThrown(() =>
				adapter.promoteWorkspaceCandidate({
					projectRoot: repo,
					candidate,
					targetRef: readGitTargetRef(repo),
				}),
			),
		).toMatchObject({ code: "CANDIDATE_STALE_BASE" });
		expect(readGitHead(repo)).toBe(rootHeadAfterIntervening);
	});

	it("promotes an exact candidate once and replays it without a second target merge", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(
			repo,
			"candidate-promote",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = adapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-promote",
			runId: "candidate-promote",
			attempt: 1,
		});

		const targetRef = readGitTargetRef(repo);
		const first = adapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});
		const rootHeadAfterFirst = readGitHead(repo);
		const rootCommitCountAfterFirst = commitCount(repo);
		const expectedBinding = {
			targetRef,
			targetHeadBeforeSha: baseSha,
			targetHeadAfterSha: rootHeadAfterFirst,
			mergedHeadSha: rootHeadAfterFirst,
			candidateCommitSha: candidate.candidateCommitSha,
			mergeParentShas: [baseSha, candidate.candidateCommitSha],
			mergedTreeSha: readGitTreeAt(repo, rootHeadAfterFirst),
			mergedTreeDigest: candidate.treeDigest,
			promotionReceiptRef: `refs/buildplane/promotions/${candidate.candidateKey}`,
			worktreeSyncState: "pending_reconciliation",
		};
		const second = adapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});

		expect(first).toEqual({
			status: "promoted",
			mergedHeadSha: rootHeadAfterFirst,
			candidateDigest: candidate.candidateDigest,
			promotionGitBinding: expectedBinding,
		});
		expect(second).toEqual({
			status: "already_promoted",
			mergedHeadSha: rootHeadAfterFirst,
			candidateDigest: candidate.candidateDigest,
			promotionGitBinding: expectedBinding,
		});
		expect(readGitHead(repo)).toBe(rootHeadAfterFirst);
		expect(commitCount(repo)).toBe(rootCommitCountAfterFirst);
		// Promotion advances only the target ref. The root checkout is deliberately
		// left untouched until an explicit reconciliation step, so it must not be
		// reset to the candidate tree behind an operator's back.
		expect(existsSync(join(repo, "candidate.txt"))).toBe(false);
		expect(
			gitStdoutOrThrow(repo, ["show", `${rootHeadAfterFirst}:candidate.txt`]),
		).toBe("candidate");
		expect(promotionCommitCount(repo, candidate.candidateDigest)).toBe(1);
	});

	it("does not overwrite an operator edit injected immediately after the target CAS", () => {
		const repo = createCommittedRepo();
		const setupAdapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = setupAdapter.assertRunnableRepository(repo);
		const workspace = setupAdapter.prepareWorkspace(
			repo,
			"candidate-post-cas-edit",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = setupAdapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-post-cas-edit",
			runId: "candidate-post-cas-edit",
			attempt: 1,
		});
		const targetRef = readGitTargetRef(repo);
		const gitCalls: string[][] = [];
		let injected = false;
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				const result = spawnSync("git", args, options);
				gitCalls.push([...args]);
				if (
					!injected &&
					isAtomicPromotionTransaction(args, options, targetRef) &&
					result.status === 0
				) {
					injected = true;
					writeFileSync(join(repo, "tracked.txt"), "operator edit\n");
				}
				return result;
			}),
		});

		const result = adapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});

		expect(injected).toBe(true);
		expect(result.status).toBe("promoted");
		expect(result.promotionGitBinding.worktreeSyncState).toBe(
			"pending_reconciliation",
		);
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe(
			"operator edit\n",
		);
		expect(
			gitStdoutOrThrow(repo, ["show", `${result.mergedHeadSha}:tracked.txt`]),
		).toBe("initial");
		expect(gitCalls.some((args) => args[0] === "read-tree")).toBe(false);
	});

	it("records reconciliation_required when the target ref is replaced after the CAS without retrying or syncing the root", () => {
		const repo = createCommittedRepo();
		const setupAdapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = setupAdapter.assertRunnableRepository(repo);
		const workspace = setupAdapter.prepareWorkspace(
			repo,
			"candidate-post-cas-replace",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = setupAdapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-post-cas-replace",
			runId: "candidate-post-cas-replace",
			attempt: 1,
		});
		const targetRef = readGitTargetRef(repo);
		const gitCalls: string[][] = [];
		let replacementHead = "";
		let injected = false;
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				const result = spawnSync("git", args, options);
				gitCalls.push([...args]);
				if (
					!injected &&
					isAtomicPromotionTransaction(args, options, targetRef) &&
					result.status === 0
				) {
					injected = true;
					const mergedHeadSha = promotionMergeShaFromTransaction(
						options,
						targetRef,
					);
					const baseTree = readGitTreeAt(repo, baseSha);
					replacementHead = gitStdoutOrThrow(repo, [
						"commit-tree",
						baseTree,
						"-p",
						baseSha,
						"-m",
						"external target replacement",
					]);
					const replacement = spawnSync(
						"git",
						["update-ref", targetRef, replacementHead, mergedHeadSha],
						options,
					);
					if (replacement.status !== 0) {
						throw new Error(
							"test fixture could not replace target ref after CAS",
						);
					}
				}
				return result;
			}),
		});

		const result = adapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});

		expect(injected).toBe(true);
		expect(result).toMatchObject({
			status: "reconciliation_required",
			candidateDigest: candidate.candidateDigest,
			promotionGitBinding: {
				targetHeadAfterSha: replacementHead,
				mergedHeadSha: result.mergedHeadSha,
				worktreeSyncState: "target_advanced",
			},
		});
		expect(readGitHead(repo)).toBe(replacementHead);
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("initial\n");
		expect(gitCalls.some((args) => args[0] === "read-tree")).toBe(false);
	});

	it("recovers the immutable receipt after a result-recording crash and target replacement without another promotion CAS", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(
			repo,
			"candidate-crash-replace",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = adapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-crash-replace",
			runId: "candidate-crash-replace",
			attempt: 1,
		});
		const targetRef = readGitTargetRef(repo);

		// The target CAS and immutable receipt completed, but the hypothetical
		// ledger result write did not. A later actor then replaces the target
		// branch before recovery can inspect it.
		const promoted = adapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});
		const baseTree = readGitTreeAt(repo, baseSha);
		const replacementHead = gitStdoutOrThrow(repo, [
			"commit-tree",
			baseTree,
			"-p",
			baseSha,
			"-m",
			"external replacement after result-recording crash",
		]);
		runGitOrThrow(repo, [
			"update-ref",
			targetRef,
			replacementHead,
			promoted.mergedHeadSha,
		]);

		let recoveryPromotionTransactions = 0;
		const recoveryAdapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				if (isAtomicPromotionTransaction(args, options, targetRef)) {
					recoveryPromotionTransactions += 1;
				}
				return spawnSync("git", args, options);
			}),
		});

		const recovered = recoveryAdapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});

		expect(recovered).toMatchObject({
			status: "reconciliation_required",
			mergedHeadSha: promoted.mergedHeadSha,
			promotionGitBinding: {
				targetHeadAfterSha: replacementHead,
				promotionReceiptRef: promoted.promotionGitBinding.promotionReceiptRef,
				worktreeSyncState: "target_advanced",
			},
		});
		expect(
			gitStdoutOrThrow(repo, [
				"rev-parse",
				promoted.promotionGitBinding.promotionReceiptRef,
			]),
		).toBe(promoted.mergedHeadSha);
		expect(recoveryPromotionTransactions).toBe(0);
		expect(readGitHead(repo)).toBe(replacementHead);
	});

	it("inspects an immutable receipt read-only after the target advances", () => {
		const repo = createCommittedRepo();
		const setupAdapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = setupAdapter.assertRunnableRepository(repo);
		const workspace = setupAdapter.prepareWorkspace(
			repo,
			"candidate-inspect-advanced",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = setupAdapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-inspect-advanced",
			runId: "candidate-inspect-advanced",
			attempt: 1,
		});
		const targetRef = readGitTargetRef(repo);
		const promoted = setupAdapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});
		const replacementHead = gitStdoutOrThrow(repo, [
			"commit-tree",
			readGitTreeAt(repo, baseSha),
			"-p",
			baseSha,
			"-m",
			"external target replacement",
		]);
		runGitOrThrow(repo, [
			"update-ref",
			targetRef,
			replacementHead,
			promoted.mergedHeadSha,
		]);

		const gitCalls: string[][] = [];
		const recoveryAdapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				gitCalls.push([...args]);
				return spawnSync("git", args, options);
			}),
		});
		const inspector = recoveryAdapter as typeof recoveryAdapter & {
			inspectWorkspaceCandidatePromotion(
				input: Parameters<typeof recoveryAdapter.promoteWorkspaceCandidate>[0],
			): ReturnType<typeof recoveryAdapter.promoteWorkspaceCandidate> | null;
		};

		const recovered = inspector.inspectWorkspaceCandidatePromotion({
			projectRoot: repo,
			candidate,
			targetRef,
		});

		expect(recovered).toMatchObject({
			status: "reconciliation_required",
			mergedHeadSha: promoted.mergedHeadSha,
			promotionGitBinding: {
				targetHeadAfterSha: replacementHead,
				worktreeSyncState: "target_advanced",
			},
		});
		expect(readGitHead(repo)).toBe(replacementHead);
		expect(
			gitCalls.filter((args) =>
				["commit-tree", "update-ref", "read-tree"].includes(args[0] ?? ""),
			),
		).toEqual([]);
	});

	it("returns no receipt and rejects a mismatched target without a Git mutation", () => {
		const repo = createCommittedRepo();
		const setupAdapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = setupAdapter.assertRunnableRepository(repo);
		const workspace = setupAdapter.prepareWorkspace(
			repo,
			"candidate-inspect-missing",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = setupAdapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-inspect-missing",
			runId: "candidate-inspect-missing",
			attempt: 1,
		});
		const targetRef = readGitTargetRef(repo);
		const rootHeadBefore = readGitHead(repo);
		const gitCalls: string[][] = [];
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				gitCalls.push([...args]);
				return spawnSync("git", args, options);
			}),
		});
		const inspector = adapter as typeof adapter & {
			inspectWorkspaceCandidatePromotion(
				input: Parameters<typeof adapter.promoteWorkspaceCandidate>[0],
			): ReturnType<typeof adapter.promoteWorkspaceCandidate> | null;
		};

		expect(
			inspector.inspectWorkspaceCandidatePromotion({
				projectRoot: repo,
				candidate,
				targetRef,
			}),
		).toBeNull();
		expect(
			captureThrown(() =>
				inspector.inspectWorkspaceCandidatePromotion({
					projectRoot: repo,
					candidate,
					targetRef: "refs/heads/other",
				}),
			),
		).toMatchObject({ code: "CANDIDATE_TARGET_REF_MISMATCH" });
		expect(readGitHead(repo)).toBe(rootHeadBefore);
		expect(
			gitCalls.filter((args) =>
				["commit-tree", "update-ref", "read-tree"].includes(args[0] ?? ""),
			),
		).toEqual([]);
	});

	it("recovers the immutable receipt after a result-recording crash without overwriting an operator edit", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(
			repo,
			"candidate-crash-edit",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = adapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-crash-edit",
			runId: "candidate-crash-edit",
			attempt: 1,
		});
		const targetRef = readGitTargetRef(repo);

		const promoted = adapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});
		writeFileSync(join(repo, "tracked.txt"), "operator edit\n");

		const gitCalls: string[][] = [];
		let recoveryPromotionTransactions = 0;
		const recoveryAdapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				gitCalls.push([...args]);
				if (isAtomicPromotionTransaction(args, options, targetRef)) {
					recoveryPromotionTransactions += 1;
				}
				return spawnSync("git", args, options);
			}),
		});

		const recovered = recoveryAdapter.promoteWorkspaceCandidate({
			projectRoot: repo,
			candidate,
			targetRef,
		});

		expect(recovered).toMatchObject({
			status: "already_promoted",
			mergedHeadSha: promoted.mergedHeadSha,
			promotionGitBinding: {
				promotionReceiptRef: promoted.promotionGitBinding.promotionReceiptRef,
				worktreeSyncState: "pending_reconciliation",
			},
		});
		expect(recoveryPromotionTransactions).toBe(0);
		expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe(
			"operator edit\n",
		);
		expect(existsSync(join(repo, "candidate.txt"))).toBe(false);
		expect(gitCalls.some((args) => args[0] === "read-tree")).toBe(false);
	});

	it("requires a signed target ref before it performs any promotion Git lookup", () => {
		const repo = createCommittedRepo();
		const setupAdapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = setupAdapter.assertRunnableRepository(repo);
		const workspace = setupAdapter.prepareWorkspace(
			repo,
			"candidate-missing-target-ref",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = setupAdapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-missing-target-ref",
			runId: "candidate-missing-target-ref",
			attempt: 1,
		});
		const rootHeadBefore = readGitHead(repo);
		const gitCalls: string[][] = [];
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				gitCalls.push(args);
				return spawnSync("git", args, options);
			}),
		});

		// An untyped caller can still omit a required TypeScript field at runtime.
		// The mutation boundary must reject it before asking Git which branch is
		// checked out.
		expect(
			captureThrown(() =>
				adapter.promoteWorkspaceCandidate({
					projectRoot: repo,
					candidate,
				} as Parameters<typeof adapter.promoteWorkspaceCandidate>[0]),
			),
		).toMatchObject({ code: "CANDIDATE_TARGET_REF_REQUIRED" });
		expect(gitCalls).toEqual([]);
		expect(readGitHead(repo)).toBe(rootHeadBefore);
	});

	it("requires a checked-out branch matching the signed target before promotion", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(
			repo,
			"candidate-target-ref",
			baseSha,
		);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = adapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-target-ref",
			runId: "candidate-target-ref",
			attempt: 1,
		});
		const targetRef = readGitTargetRef(repo);

		expect(
			captureThrown(() =>
				adapter.promoteWorkspaceCandidate({
					projectRoot: repo,
					candidate,
					targetRef: "refs/heads/other",
				}),
			),
		).toMatchObject({ code: "CANDIDATE_TARGET_REF_MISMATCH" });
		expect(readGitHead(repo)).toBe(baseSha);

		runGitOrThrow(repo, ["checkout", "--detach", baseSha]);
		expect(
			captureThrown(() =>
				adapter.promoteWorkspaceCandidate({
					projectRoot: repo,
					candidate,
					targetRef,
				}),
			),
		).toMatchObject({ code: "CANDIDATE_TARGET_REF_UNAVAILABLE" });
		expect(readGitHead(repo)).toBe(baseSha);
	});

	it("fails closed when target HEAD advances between base validation and promotion CAS", () => {
		const repo = createCommittedRepo();
		let injectConcurrentAdvance = true;
		let targetRef = "";
		const adapter = createGitWorktreeAdapter({
			runGit: createSeam((args, options) => {
				if (
					injectConcurrentAdvance &&
					targetRef.length > 0 &&
					isAtomicPromotionTransaction(args, options, targetRef)
				) {
					injectConcurrentAdvance = false;
					writeFileSync(join(repo, "racing-target.txt"), "race\n");
					const add = spawnSync("git", ["add", "racing-target.txt"], options);
					if (add.status !== 0)
						throw new Error("Could not create race commit.");
					const commit = spawnSync(
						"git",
						["commit", "-m", "racing target advance"],
						options,
					);
					if (commit.status !== 0)
						throw new Error("Could not create race commit.");
				}
				return spawnSync("git", args, options);
			}),
		});
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "candidate-race", baseSha);
		writeFileSync(join(workspace.path, "candidate.txt"), "candidate\n");
		const candidate = adapter.createWorkspaceCandidate({
			path: workspace.path,
			projectRoot: repo,
			baseSha,
			candidateId: "candidate-race",
			runId: "candidate-race",
			attempt: 1,
		});
		targetRef = readGitTargetRef(repo);

		expect(
			captureThrown(() =>
				adapter.promoteWorkspaceCandidate({
					projectRoot: repo,
					candidate,
					targetRef,
				}),
			),
		).toMatchObject({ code: "CANDIDATE_STALE_BASE" });
		expect(readGitHead(repo)).not.toBe(baseSha);
		expect(existsSync(join(repo, "candidate.txt"))).toBe(false);
		expect(promotionCommitCount(repo, candidate.candidateDigest)).toBe(0);
	});

	// M5-S4 F1 — crash-window idempotency. A SECOND commitAndMergeWorkspace for
	// the same run (the reconciler re-drive after a crash between merge and the
	// execution marker) MUST detect the prior merge in the project git history
	// and return its SHA WITHOUT creating a second merge commit.
	it("is idempotent by runId: a second merge for the same run creates no new commit", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);
		const workspace = adapter.prepareWorkspace(repo, "run-idem", baseSha);
		writeFileSync(join(workspace.path, "feature.txt"), "feature\n");

		const first = adapter.commitAndMergeWorkspace({
			path: workspace.path,
			runId: "run-idem",
			projectRoot: repo,
		});
		const headAfterFirst = readGitHead(repo);
		const logCountAfterFirst = mergeCommitCount(repo, "run-idem");
		expect(logCountAfterFirst).toBe(1);

		// Re-drive: must NOT advance HEAD or add a second merge commit.
		const second = adapter.commitAndMergeWorkspace({
			path: workspace.path,
			runId: "run-idem",
			projectRoot: repo,
		});

		expect(second).toEqual({ mergedHeadSha: first.mergedHeadSha });
		expect(readGitHead(repo)).toBe(headAfterFirst);
		expect(mergeCommitCount(repo, "run-idem")).toBe(1);
	});

	// The idempotency probe must be runId-scoped: a different run's prior merge
	// must not be mistaken for this run's, so a genuine second run still merges.
	it("does not treat another run's merge as this run's", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha: baseSha } = adapter.assertRunnableRepository(repo);

		const wsA = adapter.prepareWorkspace(repo, "run-a", baseSha);
		writeFileSync(join(wsA.path, "a.txt"), "a\n");
		adapter.commitAndMergeWorkspace({
			path: wsA.path,
			runId: "run-a",
			projectRoot: repo,
		});
		const headAfterA = readGitHead(repo);

		const wsB = adapter.prepareWorkspace(repo, "run-b", baseSha);
		writeFileSync(join(wsB.path, "b.txt"), "b\n");
		adapter.commitAndMergeWorkspace({
			path: wsB.path,
			runId: "run-b",
			projectRoot: repo,
		});

		expect(readGitHead(repo)).not.toBe(headAfterA);
		expect(mergeCommitCount(repo, "run-a")).toBe(1);
		expect(mergeCommitCount(repo, "run-b")).toBe(1);
	});

	it("rejects a base sha that does not resolve to a commit before cutting a worktree", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const bogusSha = "0000000000000000000000000000000000000000";

		expect(() => adapter.prepareWorkspace(repo, "run-bogus", bogusSha)).toThrow(
			/base commit .* does not resolve to a commit/i,
		);
		// and it must NOT leave a half-created worktree behind
		expect(
			existsSync(join(repo, ".buildplane", "workspaces", "run-bogus")),
		).toBe(false);
	});

	it("accepts the pinned base sha from assertRunnableRepository", () => {
		const repo = createCommittedRepo();
		const adapter = createGitWorktreeAdapter();
		const { headSha } = adapter.assertRunnableRepository(repo);

		const workspace = adapter.prepareWorkspace(repo, "run-ok", headSha);
		expect(readGitHead(workspace.path)).toBe(headSha);
	});
});

function digest(character: string): string {
	return `sha256:${character.repeat(64)}`;
}

function governedCandidateInput(
	input: Omit<
		CreateGovernedWorkspaceCandidateInput,
		"governedDispatch" | "activityClaimPort"
	> &
		Partial<Pick<CreateGovernedWorkspaceCandidateInput, "activityClaimPort">>,
): CreateGovernedWorkspaceCandidateInput {
	return {
		...input,
		activityClaimPort:
			input.activityClaimPort ?? governedCandidateActivityClaimPort(),
		governedDispatch: {
			schemaVersion: 3,
			runId: input.runId,
			workflowId: "workflow-governed-candidate",
			workflowRevision: "r1",
			unitId: "implement",
			attempt: input.attempt,
			provenanceRef: "event://admission/governed-candidate",
			dispatchEnvelopeRef: "event://dispatch/governed-candidate",
			envelopeDigest: digest("a"),
			baseCommitSha: input.baseSha,
			repositoryBindingDigest: digest("2"),
			ledgerAuthorityRealmDigest: digest("3"),
			governedPacketDigest: digest("4"),
			executionRole: "implementer",
			commitMode: "atomic",
			trustTier: "governed",
			capabilityBundleDigest: digest("b"),
			acceptanceContractDigest: digest("c"),
			policyDigest: digest("d"),
			contextManifestDigest: digest("e"),
			workerManifestDigest: digest("f"),
			sandboxProfileDigest: digest("1"),
			budget: {},
			idempotencyKey: "governed-candidate-dispatch",
			authorityActor: "kernel",
			actionEvidenceVersion: "sealed_v3",
			issuedAt: "2026-07-18T12:00:00.000Z",
			expiresAt: "2026-07-18T13:00:00.000Z",
		},
	};
}

function governedCandidateActivityClaimPort(): CreateGovernedWorkspaceCandidateInput["activityClaimPort"] {
	return {
		async claim(input) {
			return {
				state: "granted",
				activityId: input.activityId,
				idempotencyKey: input.idempotencyKey,
				claimEventId: "33333333-3333-4333-8333-333333333333",
				claimEventDigest: digest("4"),
				leaseId: "candidate-git-test-lease",
				leaseExpiresAt: "2026-07-18T12:05:00.000Z",
			};
		},
		async recordResult(input) {
			return {
				state: "recorded",
				resultEventId: "44444444-4444-4444-8444-444444444444",
				resultEventDigest: digest("5"),
				resultOutcome: input.outcome,
			};
		},
	};
}

function blockedGovernedCandidateEvidencePort(): CreateGovernedWorkspaceCandidateInput["actionEvidencePort"] {
	return {
		recordActionRequested: vi.fn(),
		recordActionReceipt: vi.fn(),
		sealActionReceiptSet: vi.fn(),
		recordCandidateCreatedV2: vi.fn(),
	};
}

function createCommittedRepo(): string {
	const root = createEmptyRepo();
	writeFileSync(join(root, "tracked.txt"), "initial\n");
	runGitOrThrow(root, ["add", "tracked.txt"]);
	runGitOrThrow(root, ["commit", "-m", "initial"]);
	return root;
}

function createEmptyRepo(): string {
	const root = createTempRoot("buildplane-git-adapter-");
	runGitOrThrow(root, ["init"]);
	runGitOrThrow(root, ["config", "user.name", "Buildplane Test"]);
	runGitOrThrow(root, ["config", "user.email", "test@example.com"]);
	return root;
}

function createTempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function readGitHead(cwd: string): string {
	const result = runGit(cwd, ["rev-parse", "HEAD"]);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
	return result.stdout.trim();
}

function readGitTargetRef(cwd: string): string {
	const result = runGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
	return result.stdout.trim();
}

function readGitTree(cwd: string): string {
	return readGitTreeAt(cwd, "HEAD");
}

function readGitTreeAt(cwd: string, revision: string): string {
	return gitStdoutOrThrow(cwd, ["rev-parse", `${revision}^{tree}`]);
}

function readGitRef(cwd: string, ref: string): string {
	const result = runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
	return result.stdout.trim();
}

function commitCount(cwd: string): number {
	const result = runGit(cwd, ["rev-list", "--count", "HEAD"]);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
	return Number(result.stdout.trim());
}

function promotionCommitCount(cwd: string, candidateDigest: string): number {
	const result = runGit(cwd, ["log", "--format=%s", "HEAD"]);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
	const subject = `feat: promote buildplane candidate ${candidateDigest}`;
	return result.stdout.split("\n").filter((line) => line === subject).length;
}

function captureThrown(invoke: () => void): unknown {
	try {
		invoke();
	} catch (error) {
		return error;
	}
	throw new Error("Expected operation to throw.");
}

function mergeCommitCount(cwd: string, runId: string): number {
	const result = runGit(cwd, ["log", "--format=%s", "HEAD"]);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
	const needle = `feat: merge buildplane run ${runId}`;
	return result.stdout.split("\n").filter((subject) => subject === needle)
		.length;
}

function runGitOrThrow(cwd: string, args: string[]): void {
	gitStdoutOrThrow(cwd, args);
}

function gitStdoutOrThrow(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim());
	}
	return result.stdout.trim();
}

function runGit(cwd: string, args: string[]) {
	return spawnSync("git", args, {
		cwd,
		env: isolatedGitEnv(),
		encoding: "utf8",
	});
}

function isolatedGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) {
			delete env[key];
		}
	}
	return env;
}

function isAtomicPromotionTransaction(
	args: readonly string[],
	options: SpawnSyncOptions,
	targetRef: string,
): boolean {
	return (
		args[0] === "update-ref" &&
		args[1] === "--stdin" &&
		typeof options.input === "string" &&
		options.input
			.split(/\r?\n/)
			.some((line) => line.startsWith(`update ${targetRef} `))
	);
}

function promotionMergeShaFromTransaction(
	options: SpawnSyncOptions,
	targetRef: string,
): string {
	if (typeof options.input !== "string") {
		throw new Error("Expected the atomic promotion transaction input.");
	}
	const targetUpdate = options.input
		.split(/\r?\n/)
		.find((line) => line.startsWith(`update ${targetRef} `));
	const mergedHeadSha = targetUpdate?.split(" ")[2];
	if (!mergedHeadSha) {
		throw new Error("Expected a target update in the promotion transaction.");
	}
	return mergedHeadSha;
}

function createSeam(
	implementation: (
		args: string[],
		options: SpawnSyncOptions,
	) => SpawnSyncReturns<string>,
) {
	return (
		args: string[],
		options: SpawnSyncOptions,
	): SpawnSyncReturns<string> =>
		implementation(args, {
			...options,
			env: {
				...isolatedGitEnv(),
				...options.env,
			},
		});
}

function failureResult(
	options: SpawnSyncOptions,
	stderr: string,
): SpawnSyncReturns<string> {
	const encoding = options.encoding === "buffer" ? undefined : "utf8";
	return {
		status: 1,
		signal: null,
		output: ["", "", stderr],
		pid: 0,
		stdout: encoding ? "" : Buffer.alloc(0),
		stderr: encoding ? stderr : Buffer.from(stderr),
		error: undefined,
	} as SpawnSyncReturns<string>;
}
