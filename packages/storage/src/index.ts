import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type {
	ApprovedPolicyDecision,
	BuildplaneStoragePort,
	RejectedPolicyDecision,
	Run,
	RunInfrastructureFailure,
} from "@buildplane/kernel";
import {
	assertBuildplaneDatabaseIsInitialized,
	insertProjectInitializedEvent,
	openBuildplaneDatabase,
} from "./database.js";
import { resolveProjectLayout } from "./project-layout.js";
import {
	assertBaselineStorageProjectionSchema,
	assertInitializableStorageProjectionSchema,
	bootstrapStorageProjectionSchema,
	createStorageStore,
} from "./store.js";

export type {
	ArtifactRecord,
	DecisionRecord,
	EvidenceRecord,
} from "./contracts";

export { createEventStore, type EventStore } from "./event-store.js";
export { createLearningStore } from "./learning-store.js";
export { resolveProjectLayout } from "./project-layout.js";
export type {
	ExportRunBundleOptions,
	FinalCriterionStatus,
	FinalRunVerdict,
	FinalVerdictCriterion,
	FinalVerdictIssue,
	FinalVerdictReport,
	RunBundle,
	RunBundleArtifactRecord,
	RunBundleEventRecord,
	RunBundleRunRecord,
	VerifyRunFinalVerdictOptions,
} from "./run-bundle.js";
export { exportRunBundle, verifyRunFinalVerdict } from "./run-bundle.js";
export type {
	CandidateAcceptanceRecord,
	CandidateArtifactProjection,
	CandidateArtifactProjectionInput,
	CandidateOutcomeInput,
	CandidatePromotionExecutionClaimStateV1,
	CandidatePromotionExecutionLeaseV1,
	CandidatePromotionIntent,
	CandidatePromotionIntentInput,
	CandidatePromotionOutcome,
	CandidatePromotionState,
	CandidateReviewRecord,
	RunHistoryEntry,
} from "./store.js";

export interface ProjectInitializationResult {
	readonly created: boolean;
	readonly projectRoot: string;
	readonly stateDbPath: string;
}

export interface BuildplaneStorage extends BuildplaneStoragePort {
	initializeProject(): ProjectInitializationResult;
	getRunHistory(): import("./store.js").RunHistoryEntry[];
	recordRunStrategyId(runId: string, strategyId: string): void;
	getPacketSnapshot(
		runId: string,
	): import("@buildplane/kernel").UnitPacket | null;
	recordWorkspacePrepared(
		runId: string,
		workspace: {
			path: string;
			headSha: string;
			sourceProjectRoot: string;
		},
	): void;
	commitRunFailureOutcome(
		runId: string,
		payload:
			| {
					decision: RejectedPolicyDecision;
					infrastructureFailure?: never;
					workspaceStatus: "retained";
			  }
			| {
					decision?: never;
					infrastructureFailure: RunInfrastructureFailure;
					workspaceStatus?: "retained";
			  },
	): Run;
	commitRunSuccessOutcome(runId: string, decision: ApprovedPolicyDecision): Run;
	commitRunCandidateOutcome(
		runId: string,
		input: import("./store.js").CandidateOutcomeInput,
	): Run;
	getCandidateArtifact(
		runId: string,
	): import("./store.js").CandidateArtifactProjection | null;
	prepareCandidatePromotion(
		input: import("./store.js").CandidatePromotionIntentInput,
	): import("./store.js").CandidatePromotionIntent;
	markCandidatePromotionRecorded(
		candidateDigest: string,
		idempotencyKey: string,
	): void;
	claimCandidatePromotionExecution(
		candidateDigest: string,
		idempotencyKey: string,
	): import("./store.js").CandidatePromotionExecutionLeaseV1;
	getCandidatePromotionExecutionClaimState(
		candidateDigest: string,
		idempotencyKey: string,
	): import("./store.js").CandidatePromotionExecutionClaimStateV1;
	markCandidatePromotionExecuted(
		candidateDigest: string,
		idempotencyKey: string,
		outcome: {
			outcome: import("./store.js").CandidatePromotionOutcome;
			mergedHeadSha?: string;
			promotionGitBinding?: import("@buildplane/kernel").PromotionGitBindingV1;
		},
		executionLeaseToken?: string,
	): void;
	listPendingCandidatePromotions(): readonly import("./store.js").CandidatePromotionIntent[];
	recordWorkspaceDeleted(runId: string): void;
	recordWorkspaceCleanupFailed(runId: string, message: string): void;
	recordWorkspaceCleanedUp(runId: string): void;
}

export function createBuildplaneStorage(
	projectRoot: string,
): BuildplaneStorage {
	const layout = resolveProjectLayout(projectRoot);

	const store = createStorageStore(projectRoot);

	return {
		...store,
		initializeProject() {
			const hasProjectJson = existsSync(layout.projectJsonPath);
			const hasStateDb = existsSync(layout.stateDbPath);
			const initializedAt = new Date().toISOString();

			if (hasProjectJson !== hasStateDb) {
				throw new Error(
					"Buildplane state is incomplete: project.json exists but state.db is missing. Remove .buildplane or repair the state before rerunning `buildplane init`.",
				);
			}

			const created = !hasProjectJson;

			mkdirSync(layout.buildplaneDir, { recursive: true });
			mkdirSync(layout.artifactsDir, { recursive: true });
			mkdirSync(layout.evidenceDir, { recursive: true });
			mkdirSync(layout.runsDir, { recursive: true });
			mkdirSync(layout.logsDir, { recursive: true });
			mkdirSync(layout.workspacesDir, { recursive: true });

			if (!created) {
				assertBuildplaneDatabaseIsInitialized(layout.stateDbPath, projectRoot);
			}

			const database = openBuildplaneDatabase(layout.stateDbPath);
			try {
				if (!created) {
					assertInitializableStorageProjectionSchema(database);
				}

				bootstrapStorageProjectionSchema(database);

				if (!created) {
					assertBaselineStorageProjectionSchema(database);
				}

				if (created) {
					writeFileSync(
						layout.projectJsonPath,
						JSON.stringify({
							schemaVersion: 1,
							defaultPolicyProfile: "default",
							initializedAt,
						}),
					);

					database
						.prepare(
							`INSERT INTO projects (project_root, initialized_at, default_policy_profile) VALUES (?, ?, ?)`,
						)
						.run(projectRoot, initializedAt, "default");

					insertProjectInitializedEvent(database, {
						projectRoot,
						defaultPolicyProfile: "default",
						initializedAt,
					});
				}

				return {
					created,
					projectRoot,
					stateDbPath: layout.stateDbPath,
				};
			} finally {
				database.close();
			}
		},
	};
}
