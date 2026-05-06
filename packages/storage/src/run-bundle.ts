import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SideEffectReceipt, UnitPacket } from "@buildplane/kernel";
import {
	assertBuildplaneDatabaseIsInitialized,
	openBuildplaneDatabase,
} from "./database.js";
import { resolveProjectLayout } from "./project-layout.js";

export type RunBundleStatus = "running" | "blocked" | "passed" | "failed";
export type RunBundleVerdict = "passed" | "blocked" | "failed";
export type RunBundleVerificationState =
	| "none"
	| "attempted"
	| "passed"
	| "failed";
export type RunBundleEventKind =
	| "file_read"
	| "file_write"
	| "tool_call"
	| "test_run"
	| "assertion_check"
	| "criterion_attempted"
	| "criterion_verified"
	| "blocker_raised"
	| "halt"
	| "agent_message";
export type RunBundleArtifactKind =
	| "diff"
	| "file"
	| "test_output"
	| "tool_io"
	| "log"
	| "receipt";

export interface RunBundleActorRef {
	readonly type: "system" | "agent" | "tool";
	readonly id: string;
}

export interface RunBundleCriterion {
	readonly id: string;
	readonly label: string;
	readonly status: "verified" | "unverified";
	readonly evidence_event_id?: string;
}

export interface RunBundleBlocker {
	readonly id: string;
	readonly label: string;
	readonly status: "open" | "closed";
	readonly severity: "low" | "medium" | "high" | "critical";
	readonly evidence_event_id: string;
}

export interface RunBundleRunRecord {
	readonly id: string;
	readonly schema_version: "1.0";
	readonly started_at: string;
	readonly ended_at: string | null;
	readonly goal: string;
	readonly constraints: readonly string[];
	readonly status: RunBundleStatus;
	readonly verdict: RunBundleVerdict;
	readonly summary: string;
	readonly changed_files: readonly string[];
	readonly verified_criteria: readonly RunBundleCriterion[];
	readonly unverified_criteria: readonly RunBundleCriterion[];
	readonly blockers: readonly RunBundleBlocker[];
	readonly manifest_digest: string;
}

export interface RunBundleEventRecord {
	readonly id: string;
	readonly run_id: string;
	readonly timestamp: string;
	readonly kind: RunBundleEventKind;
	readonly actor: RunBundleActorRef;
	readonly target: string | null;
	readonly summary: string;
	readonly verification_state: RunBundleVerificationState;
	readonly artifact_refs: readonly string[];
	readonly parent_event_id: string | null;
}

export interface RunBundleArtifactRecord {
	readonly id: string;
	readonly kind: RunBundleArtifactKind;
	readonly sha: string;
	readonly produced_by_event_id: string;
	readonly uri?: string;
	readonly bytes?: string;
	readonly preview: {
		readonly mime: string;
		readonly line_count?: number;
		readonly title?: string;
	};
}

export interface RunBundle {
	readonly schema_version: "1.0";
	readonly kind: "run_bundle";
	readonly generated_at: string;
	readonly source: {
		readonly system: "buildplane";
		readonly buildplane_version: string;
	};
	readonly run: RunBundleRunRecord;
	readonly events: readonly RunBundleEventRecord[];
	readonly artifacts: readonly RunBundleArtifactRecord[];
}

export interface ExportRunBundleOptions {
	readonly runId: string;
	readonly outPath?: string;
	readonly generatedAt?: string;
	readonly buildplaneVersion?: string;
}

export interface VerifyRunFinalVerdictOptions {
	readonly runId: string;
}

export type FinalRunVerdict = "PASSED" | "BLOCKED" | "FAILED" | "UNSAFE_TO_RUN";
export type FinalCriterionStatus =
	| "PASSED"
	| "FAILED"
	| "INSUFFICIENT_EVIDENCE";

export interface FinalVerdictCriterion {
	readonly id: string;
	readonly label: string;
	readonly status: FinalCriterionStatus;
	readonly evidence_event_id?: string;
}

export interface FinalVerdictIssue {
	readonly code:
		| "MISSING_VERIFIER_RECEIPT"
		| "FAILED_VERIFIER_RECEIPT"
		| "MISSING_APPROVAL"
		| "UNRESOLVED_BLOCKER"
		| "UNSAFE_TO_RUN";
	readonly message: string;
	readonly severity: "medium" | "high" | "critical";
	readonly evidence_event_id?: string;
}

export interface FinalVerdictReport {
	readonly runId: string;
	readonly verdict: FinalRunVerdict;
	readonly criteria: readonly FinalVerdictCriterion[];
	readonly issues: readonly FinalVerdictIssue[];
	readonly receipts: {
		readonly verifier: number;
		readonly approvals: number;
		readonly rejections: number;
	};
}

interface StoredRunBundleRunRow {
	readonly id: string;
	readonly unit_id: string;
	readonly status: string;
	readonly unit_snapshot: string;
	readonly created_at: string;
	readonly completed_at: string | null;
}

interface StoredRunBundleEventRow {
	readonly id: string;
	readonly kind: string;
	readonly occurred_at: string;
	readonly payload: string;
}

interface StoredRunBundleArtifactRow {
	readonly id: string;
	readonly type: string;
	readonly location: string;
}

interface StoredRunBundleDecisionRow {
	readonly id: string;
	readonly kind: string;
	readonly outcome: string;
	readonly reasons: string;
}

interface OutputCheckLike {
	readonly path: string;
	readonly exists: boolean;
}

const DEFAULT_BUILDPLANE_VERSION = "0.1.0";
const SCHEMA_VERSION = "1.0" as const;

export function exportRunBundle(
	projectRoot: string,
	options: ExportRunBundleOptions,
): RunBundle {
	const layout = resolveProjectLayout(projectRoot);
	if (!existsSync(layout.projectJsonPath) || !existsSync(layout.stateDbPath)) {
		throw new Error(
			"Buildplane project is not initialized. Run `buildplane init` first.",
		);
	}
	assertBuildplaneDatabaseIsInitialized(layout.stateDbPath, projectRoot);

	const database = openBuildplaneDatabase(layout.stateDbPath);
	try {
		const bundle = buildRunBundle(projectRoot, database, options);
		if (options.outPath) {
			mkdirSync(dirname(options.outPath), { recursive: true });
			writeFileSync(options.outPath, `${JSON.stringify(bundle, null, 2)}\n`);
		}
		return bundle;
	} finally {
		database.close();
	}
}

export function verifyRunFinalVerdict(
	projectRoot: string,
	options: VerifyRunFinalVerdictOptions,
): FinalVerdictReport {
	const layout = resolveProjectLayout(projectRoot);
	if (!existsSync(layout.projectJsonPath) || !existsSync(layout.stateDbPath)) {
		throw new Error(
			"Buildplane project is not initialized. Run `buildplane init` first.",
		);
	}
	assertBuildplaneDatabaseIsInitialized(layout.stateDbPath, projectRoot);

	const database = openBuildplaneDatabase(layout.stateDbPath);
	try {
		const run = readRunRow(database, options.runId);
		const packet = parseUnitPacket(run.unit_snapshot);
		const eventRows = readEventRows(database, run.id);
		const decisionRows = readDecisionRows(database, run.id);
		return buildFinalVerdictReport(run, packet, eventRows, decisionRows);
	} finally {
		database.close();
	}
}

function buildRunBundle(
	projectRoot: string,
	database: DatabaseSync,
	options: ExportRunBundleOptions,
): RunBundle {
	const run = readRunRow(database, options.runId);
	const packet = parseUnitPacket(run.unit_snapshot);
	const eventRows = readEventRows(database, run.id);
	const artifactRows = readArtifactRows(database, run.id);
	const decisionRows = readDecisionRows(database, run.id);
	const outputChecks = latestOutputChecks(eventRows);
	const finalReport = buildFinalVerdictReport(
		run,
		packet,
		eventRows,
		decisionRows,
	);
	const executionEventRow = latestExecutionEventRow(eventRows);
	const decisionEventRows = eventRows.filter(
		(event) => event.kind === "decision-recorded",
	);
	const completedEventRow = [...eventRows]
		.reverse()
		.find((event) => event.kind === "run-completed");
	const artifacts: RunBundleArtifactRecord[] = [];
	const events: RunBundleEventRecord[] = [];
	const verifiedCriteria: RunBundleCriterion[] = [];
	const unverifiedCriteria: RunBundleCriterion[] = [];
	const blockers: RunBundleBlocker[] = [];

	const addArtifact = (artifact: RunBundleArtifactRecord): void => {
		artifacts.push(artifact);
	};

	const runCreatedRow =
		eventRows.find((event) => event.kind === "run-created") ?? eventRows[0];
	const runStartedRow = eventRows.find((event) => event.kind === "run-started");
	const admissionEventId = toBundleEventId(
		runCreatedRow?.id ?? `${run.id}-created`,
	);
	const startedEventId = runStartedRow
		? toBundleEventId(runStartedRow.id)
		: undefined;

	events.push({
		id: admissionEventId,
		run_id: run.id,
		timestamp: runCreatedRow?.occurred_at ?? run.created_at,
		kind: "agent_message",
		actor: { type: "system", id: "buildplane" },
		target: null,
		summary: `Run admitted for unit ${run.unit_id}.`,
		verification_state: "none",
		artifact_refs: [],
		parent_event_id: null,
	});

	if (runStartedRow && startedEventId) {
		events.push({
			id: startedEventId,
			run_id: run.id,
			timestamp: runStartedRow.occurred_at,
			kind: "agent_message",
			actor: { type: "system", id: "buildplane" },
			target: null,
			summary: `Run started for unit ${run.unit_id}.`,
			verification_state: "none",
			artifact_refs: [],
			parent_event_id: admissionEventId,
		});
	}

	const workerEventId = executionEventRow
		? toBundleEventId(executionEventRow.id)
		: toBundleEventId(`${run.id}-worker`);
	const workerArtifactRefs: string[] = [];
	const stdout = readRunLog(projectRoot, run.id, "stdout");
	const stderr = readRunLog(projectRoot, run.id, "stderr");
	if (stdout !== undefined) {
		const artifact = textArtifact({
			id: toBundleArtifactId(`${workerEventId}-stdout`),
			kind: "tool_io",
			producedByEventId: workerEventId,
			title: "Worker stdout",
			bytes: stdout,
		});
		addArtifact(artifact);
		workerArtifactRefs.push(artifact.id);
	}
	if (stderr) {
		const artifact = textArtifact({
			id: toBundleArtifactId(`${workerEventId}-stderr`),
			kind: "tool_io",
			producedByEventId: workerEventId,
			title: "Worker stderr",
			bytes: stderr,
		});
		addArtifact(artifact);
		workerArtifactRefs.push(artifact.id);
	}

	const executionPayload = executionEventRow
		? parsePayload(executionEventRow.payload)
		: {};
	const exitCode =
		typeof executionPayload.exitCode === "number"
			? executionPayload.exitCode
			: undefined;
	const sideEffects = parseSideEffects(executionPayload.sideEffects);
	if (executionEventRow || stdout !== undefined || stderr !== undefined) {
		events.push({
			id: workerEventId,
			run_id: run.id,
			timestamp:
				executionEventRow?.occurred_at ?? run.completed_at ?? run.created_at,
			kind: "tool_call",
			actor: { type: "tool", id: "buildplane.runtime" },
			target: formatExecutionTarget(packet),
			summary:
				exitCode === undefined
					? "Worker execution completed; verifier receipts are recorded separately."
					: `Worker execution exited with code ${exitCode}; verifier receipts are recorded separately.`,
			verification_state: "attempted",
			artifact_refs: workerArtifactRefs,
			parent_event_id: startedEventId ?? admissionEventId,
		});
	}

	for (const [index, sideEffect] of sideEffects.entries()) {
		const eventId = toBundleEventId(
			`${executionEventRow?.id ?? run.id}-side-effect-${index}`,
		);
		const grantText = sideEffect.grantId
			? `citing grant ${sideEffect.grantId}`
			: "without a cited grant";
		const receiptArtifact = textArtifact({
			id: toBundleArtifactId(`${eventId}-receipt`),
			kind: "receipt",
			producedByEventId: eventId,
			title: "Side-effect capability receipt",
			bytes: `SIDE_EFFECT: ${sideEffect.id} ${sideEffect.capability}.${sideEffect.action} target ${sideEffect.target} ${grantText}.`,
		});
		addArtifact(receiptArtifact);
		events.push({
			id: eventId,
			run_id: run.id,
			timestamp:
				executionEventRow?.occurred_at ?? run.completed_at ?? run.created_at,
			kind: "tool_call",
			actor: { type: "tool", id: "buildplane.runtime.side_effect" },
			target: `${sideEffect.capability}.${sideEffect.action} ${sideEffect.target}`,
			summary: `Side effect ${sideEffect.id}: ${sideEffect.capability}.${sideEffect.action} target ${sideEffect.target} ${grantText}.`,
			verification_state: "attempted",
			artifact_refs: [receiptArtifact.id],
			parent_event_id:
				executionEventRow || stdout !== undefined || stderr !== undefined
					? workerEventId
					: (startedEventId ?? admissionEventId),
		});
	}

	for (const [index, check] of outputChecks.entries()) {
		const eventId = toBundleEventId(
			`${executionEventRow?.id ?? run.id}-output-${index}`,
		);
		const artifactRefs: string[] = [];
		const persistedArtifact = findPersistedOutputArtifact(
			artifactRows,
			run.id,
			check.path,
		);
		if (check.exists) {
			const outputArtifact = outputFileArtifact(projectRoot, {
				id: toBundleArtifactId(`${eventId}-file`),
				producedByEventId: eventId,
				location: persistedArtifact?.location ?? check.path,
			});
			addArtifact(outputArtifact);
			artifactRefs.push(outputArtifact.id);
		}
		const receiptArtifact = textArtifact({
			id: toBundleArtifactId(`${eventId}-receipt`),
			kind: "receipt",
			producedByEventId: eventId,
			title: check.exists ? "Verifier receipt" : "Failed verifier receipt",
			bytes: check.exists
				? `VERIFIED: required output exists: ${check.path}`
				: `FAILED: required output missing: ${check.path}`,
		});
		addArtifact(receiptArtifact);
		artifactRefs.push(receiptArtifact.id);

		events.push({
			id: eventId,
			run_id: run.id,
			timestamp:
				executionEventRow?.occurred_at ?? run.completed_at ?? run.created_at,
			kind: "assertion_check",
			actor: { type: "tool", id: "buildplane.verifier" },
			target: check.path,
			summary: check.exists
				? `Verifier confirmed required output exists: ${check.path}.`
				: `Verifier could not find required output: ${check.path}.`,
			verification_state: check.exists ? "passed" : "failed",
			artifact_refs: artifactRefs,
			parent_event_id:
				executionEventRow || stdout !== undefined || stderr !== undefined
					? workerEventId
					: (startedEventId ?? admissionEventId),
		});

		const criterion = {
			id: `required-output:${check.path}`,
			label: `Required output exists: ${check.path}`,
			evidence_event_id: eventId,
		};
		if (check.exists) {
			verifiedCriteria.push({ ...criterion, status: "verified" });
		} else {
			unverifiedCriteria.push({ ...criterion, status: "unverified" });
		}
	}

	for (const criterion of finalReport.criteria) {
		if (criterion.status !== "INSUFFICIENT_EVIDENCE") continue;
		if (verifiedCriteria.some((item) => item.id === criterion.id)) continue;
		if (unverifiedCriteria.some((item) => item.id === criterion.id)) continue;
		unverifiedCriteria.push({
			id: criterion.id,
			label: criterion.label,
			status: "unverified",
		});
	}

	const verifiesExitCode = requiresExitCodeCriterion(packet);
	if (verifiesExitCode && exitCode !== undefined) {
		const eventId = toBundleEventId(
			`${executionEventRow?.id ?? run.id}-exit-code`,
		);
		const receiptArtifact = textArtifact({
			id: toBundleArtifactId(`${eventId}-receipt`),
			kind: "receipt",
			producedByEventId: eventId,
			title:
				exitCode === 0
					? "Exit-code verifier receipt"
					: "Failed exit-code receipt",
			bytes:
				exitCode === 0
					? "VERIFIED: worker command exited with code 0."
					: `FAILED: worker command exited with code ${exitCode}.`,
		});
		addArtifact(receiptArtifact);
		events.push({
			id: eventId,
			run_id: run.id,
			timestamp:
				executionEventRow?.occurred_at ?? run.completed_at ?? run.created_at,
			kind: "assertion_check",
			actor: { type: "tool", id: "buildplane.verifier" },
			target: "process.exitCode",
			summary:
				exitCode === 0
					? "Verifier confirmed worker command exit code 0."
					: `Verifier observed worker command exit code ${exitCode}.`,
			verification_state: exitCode === 0 ? "passed" : "failed",
			artifact_refs: [receiptArtifact.id],
			parent_event_id:
				executionEventRow || stdout !== undefined || stderr !== undefined
					? workerEventId
					: (startedEventId ?? admissionEventId),
		});
		const criterion = {
			id: "command-exit:0",
			label: "Worker command exits with code 0",
			evidence_event_id: eventId,
		};
		if (exitCode === 0) {
			verifiedCriteria.push({ ...criterion, status: "verified" });
		} else {
			unverifiedCriteria.push({ ...criterion, status: "unverified" });
		}
	}

	for (const [index, decisionRow] of decisionRows.entries()) {
		const sourceEventRow = decisionEventRows[index];
		const eventId = toBundleEventId(
			sourceEventRow?.id ?? `${decisionRow.id}-decision`,
		);
		const reasons = parseReasons(decisionRow.reasons);
		const rejected = decisionRow.outcome === "rejected";
		const artifact = textArtifact({
			id: toBundleArtifactId(`${eventId}-receipt`),
			kind: "receipt",
			producedByEventId: eventId,
			title: rejected ? "Policy rejection receipt" : "Policy decision receipt",
			bytes: `${decisionRow.kind} ${decisionRow.outcome}${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`,
		});
		addArtifact(artifact);
		events.push({
			id: eventId,
			run_id: run.id,
			timestamp:
				sourceEventRow?.occurred_at ?? run.completed_at ?? run.created_at,
			kind: rejected ? "blocker_raised" : "agent_message",
			actor: { type: "system", id: "buildplane.policy" },
			target: decisionRow.kind,
			summary: `${decisionRow.kind} ${decisionRow.outcome}${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`,
			verification_state: rejected ? "failed" : "none",
			artifact_refs: [artifact.id],
			parent_event_id: events[events.length - 1]?.id ?? admissionEventId,
		});
		if (rejected) {
			const unsafe = isUnsafeDecision(decisionRow);
			const architectureDiffScope =
				decisionRow.kind === "architecture.diff_scope";
			blockers.push({
				id: unsafe
					? "policy-unsafe-quarantine"
					: architectureDiffScope
						? "architecture-diff-scope"
						: "policy-rejection",
				label: reasons[0] ?? "Policy rejected the run",
				status:
					unsafe ||
					architectureDiffScope ||
					mapRunStatus(run.status).status === "blocked"
						? "open"
						: "closed",
				severity: unsafe ? "critical" : "high",
				evidence_event_id: eventId,
			});
		}
	}

	const mapped = mapFinalVerdict(finalReport.verdict);
	const haltEventId = completedEventRow
		? toBundleEventId(completedEventRow.id)
		: toBundleEventId(`${run.id}-halt`);
	const finalReceipt = textArtifact({
		id: toBundleArtifactId(`${haltEventId}-receipt`),
		kind: "receipt",
		producedByEventId: haltEventId,
		title: "Final run receipt",
		bytes: finalReceiptText(
			mapped.verdict,
			verifiedCriteria.length,
			unverifiedCriteria.length,
			blockers.length,
		),
	});
	addArtifact(finalReceipt);
	events.push({
		id: haltEventId,
		run_id: run.id,
		timestamp:
			completedEventRow?.occurred_at ?? run.completed_at ?? run.created_at,
		kind: "halt",
		actor: { type: "system", id: "buildplane" },
		target: null,
		summary: finalSummary(
			mapped.verdict,
			verifiedCriteria.length,
			unverifiedCriteria.length,
			blockers.length,
		),
		verification_state:
			mapped.verdict === "passed"
				? "passed"
				: mapped.verdict === "failed"
					? "failed"
					: "none",
		artifact_refs: [finalReceipt.id],
		parent_event_id: events[events.length - 1]?.id ?? admissionEventId,
	});

	if (mapped.verdict === "passed" && verifiedCriteria.length === 0) {
		throw new Error(
			`Cannot export passed run '${run.id}' without verified acceptance evidence.`,
		);
	}

	const changedFiles = collectChangedFiles(artifactRows);
	const runRecordWithoutDigest = {
		id: run.id,
		schema_version: SCHEMA_VERSION,
		started_at: run.created_at,
		ended_at: run.completed_at,
		goal: packet.intent?.objective ?? `Run unit ${run.unit_id}`,
		constraints: collectConstraints(packet),
		status: mapped.status,
		verdict: mapped.verdict,
		summary: finalSummary(
			mapped.verdict,
			verifiedCriteria.length,
			unverifiedCriteria.length,
			blockers.length,
		),
		changed_files: changedFiles,
		verified_criteria: verifiedCriteria,
		unverified_criteria: unverifiedCriteria,
		blockers,
	};
	const manifestDigest = digestJson({
		run: runRecordWithoutDigest,
		events,
		artifacts,
	});

	return {
		schema_version: SCHEMA_VERSION,
		kind: "run_bundle",
		generated_at: options.generatedAt ?? new Date().toISOString(),
		source: {
			system: "buildplane",
			buildplane_version:
				options.buildplaneVersion ?? DEFAULT_BUILDPLANE_VERSION,
		},
		run: {
			...runRecordWithoutDigest,
			manifest_digest: manifestDigest,
		},
		events,
		artifacts,
	};
}

function buildFinalVerdictReport(
	run: StoredRunBundleRunRow,
	packet: UnitPacket,
	eventRows: readonly StoredRunBundleEventRow[],
	decisionRows: readonly StoredRunBundleDecisionRow[],
): FinalVerdictReport {
	const executionEventRow = latestExecutionEventRow(eventRows);
	const outputChecks = latestOutputChecks(eventRows);
	const executionPayload = executionEventRow
		? parsePayload(executionEventRow.payload)
		: {};
	const exitCode =
		typeof executionPayload.exitCode === "number"
			? executionPayload.exitCode
			: undefined;
	const criteria: FinalVerdictCriterion[] = [];
	const issues: FinalVerdictIssue[] = [];
	const requiredOutputs = packet.verification.requiredOutputs;
	const verifiesExitCode = requiresExitCodeCriterion(packet);
	const approvals = decisionRows.filter(
		(decision) => decision.outcome === "approved",
	).length;
	const rejections = decisionRows.filter(
		(decision) => decision.outcome === "rejected",
	);
	const unsafeRejection = rejections.find(isUnsafeDecision);

	for (const outputPath of requiredOutputs) {
		const checkIndex = outputChecks.findIndex(
			(check) => check.path === outputPath,
		);
		const check = checkIndex >= 0 ? outputChecks[checkIndex] : undefined;
		const criterionId = `required-output:${outputPath}`;
		const label = `Required output exists: ${outputPath}`;
		if (!check) {
			criteria.push({
				id: criterionId,
				label,
				status: "INSUFFICIENT_EVIDENCE",
			});
			issues.push({
				code: "MISSING_VERIFIER_RECEIPT",
				message: `Missing verifier receipt for required output: ${outputPath}`,
				severity: "high",
			});
			continue;
		}

		const evidenceEventId = toBundleEventId(
			`${executionEventRow?.id ?? run.id}-output-${checkIndex}`,
		);
		if (check.exists) {
			criteria.push({
				id: criterionId,
				label,
				status: "PASSED",
				evidence_event_id: evidenceEventId,
			});
		} else {
			criteria.push({
				id: criterionId,
				label,
				status: "FAILED",
				evidence_event_id: evidenceEventId,
			});
			issues.push({
				code: "FAILED_VERIFIER_RECEIPT",
				message: `Verifier receipt failed required output: ${outputPath}`,
				severity: "high",
				evidence_event_id: evidenceEventId,
			});
		}
	}

	if (verifiesExitCode) {
		const criterionId = "command-exit:0";
		const label = "Worker command exits with code 0";
		if (exitCode === undefined) {
			criteria.push({
				id: criterionId,
				label,
				status: "INSUFFICIENT_EVIDENCE",
			});
			issues.push({
				code: "MISSING_VERIFIER_RECEIPT",
				message: "Missing verifier receipt for worker command exit code.",
				severity: "high",
			});
		} else {
			const evidenceEventId = toBundleEventId(
				`${executionEventRow?.id ?? run.id}-exit-code`,
			);
			if (exitCode === 0) {
				criteria.push({
					id: criterionId,
					label,
					status: "PASSED",
					evidence_event_id: evidenceEventId,
				});
			} else {
				criteria.push({
					id: criterionId,
					label,
					status: "FAILED",
					evidence_event_id: evidenceEventId,
				});
				issues.push({
					code: "FAILED_VERIFIER_RECEIPT",
					message: `Verifier receipt observed worker command exit code ${exitCode}.`,
					severity: "high",
					evidence_event_id: evidenceEventId,
				});
			}
		}
	}

	for (const rejection of rejections) {
		if (isUnsafeDecision(rejection)) continue;
		issues.push({
			code: "UNRESOLVED_BLOCKER",
			message: formatDecisionIssueMessage(rejection),
			severity: "high",
		});
	}

	if (unsafeRejection) {
		issues.push({
			code: "UNSAFE_TO_RUN",
			message: formatDecisionIssueMessage(unsafeRejection),
			severity: "critical",
		});
	}

	const hasFailedCriteria = criteria.some(
		(criterion) => criterion.status === "FAILED",
	);
	const hasMissingCriteria = criteria.some(
		(criterion) => criterion.status === "INSUFFICIENT_EVIDENCE",
	);
	const terminalRunRequiresApproval =
		!hasFailedCriteria && !hasMissingCriteria && !unsafeRejection;
	if (terminalRunRequiresApproval && approvals === 0) {
		issues.push({
			code: "MISSING_APPROVAL",
			message: "Missing policy approval receipt for final passed verdict.",
			severity: "high",
		});
	}

	const verdict: FinalRunVerdict = (() => {
		if (unsafeRejection) return "UNSAFE_TO_RUN";
		if (hasFailedCriteria) return "FAILED";
		if (hasMissingCriteria || approvals === 0 || rejections.length > 0)
			return "BLOCKED";
		if (
			run.status === "pending" ||
			run.status === "running" ||
			run.status === "suspended"
		) {
			return "BLOCKED";
		}
		if (run.status === "failed" || run.status === "cancelled") return "FAILED";
		return "PASSED";
	})();

	return {
		runId: run.id,
		verdict,
		criteria,
		issues,
		receipts: {
			verifier: outputChecks.length + (exitCode !== undefined ? 1 : 0),
			approvals,
			rejections: rejections.length,
		},
	};
}

function readRunRow(
	database: DatabaseSync,
	runId: string,
): StoredRunBundleRunRow {
	const row = database
		.prepare(
			`SELECT id, unit_id, status, unit_snapshot, created_at, completed_at FROM runs WHERE id = ?`,
		)
		.get(runId) as unknown as StoredRunBundleRunRow | undefined;
	if (!row) {
		throw new Error(`No run found for id '${runId}'`);
	}
	return row;
}

function readEventRows(
	database: DatabaseSync,
	runId: string,
): StoredRunBundleEventRow[] {
	return database
		.prepare(
			`SELECT id, kind, occurred_at, payload FROM events WHERE json_extract(payload, '$.runId') = ? ORDER BY occurred_at ASC, rowid ASC`,
		)
		.all(runId) as unknown as StoredRunBundleEventRow[];
}

function readArtifactRows(
	database: DatabaseSync,
	runId: string,
): StoredRunBundleArtifactRow[] {
	return database
		.prepare(
			`SELECT id, type, location FROM artifacts WHERE run_id = ? ORDER BY rowid ASC`,
		)
		.all(runId) as unknown as StoredRunBundleArtifactRow[];
}

function readDecisionRows(
	database: DatabaseSync,
	runId: string,
): StoredRunBundleDecisionRow[] {
	return database
		.prepare(
			`SELECT id, kind, outcome, reasons FROM decisions WHERE run_id = ? ORDER BY rowid ASC`,
		)
		.all(runId) as unknown as StoredRunBundleDecisionRow[];
}

function parseUnitPacket(raw: string): UnitPacket {
	return JSON.parse(raw) as UnitPacket;
}

function parsePayload(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseSideEffects(raw: unknown): SideEffectReceipt[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((value): SideEffectReceipt[] => {
		if (!value || typeof value !== "object") return [];
		const receipt = value as Partial<SideEffectReceipt>;
		if (
			typeof receipt.id !== "string" ||
			typeof receipt.capability !== "string" ||
			typeof receipt.action !== "string" ||
			typeof receipt.target !== "string"
		) {
			return [];
		}
		return [
			{
				id: receipt.id,
				capability: receipt.capability,
				action: receipt.action,
				target: receipt.target,
				...(typeof receipt.grantId === "string"
					? { grantId: receipt.grantId }
					: {}),
			},
		];
	});
}

function requiresExitCodeCriterion(packet: UnitPacket): boolean {
	const contract = packet.unit.verificationContract.toLowerCase();
	return (
		contract.includes("exit-0") ||
		packet.verification.requiredOutputs.length === 0
	);
}

function latestExecutionEventRow(
	events: readonly StoredRunBundleEventRow[],
): StoredRunBundleEventRow | undefined {
	const executionRows = events.filter(
		(event) => event.kind === "execution-evidence-recorded",
	);
	return executionRows[executionRows.length - 1];
}

function latestOutputChecks(
	events: readonly StoredRunBundleEventRow[],
): OutputCheckLike[] {
	const latest = latestExecutionEventRow(events);
	if (!latest) return [];
	const payload = parsePayload(latest.payload);
	if (!Array.isArray(payload.outputChecks)) return [];
	return payload.outputChecks.flatMap((value): OutputCheckLike[] => {
		if (!value || typeof value !== "object") return [];
		const check = value as { path?: unknown; exists?: unknown };
		return typeof check.path === "string" && typeof check.exists === "boolean"
			? [{ path: check.path, exists: check.exists }]
			: [];
	});
}

function mapFinalVerdict(verdict: FinalRunVerdict): {
	readonly status: RunBundleStatus;
	readonly verdict: RunBundleVerdict;
} {
	switch (verdict) {
		case "PASSED":
			return { status: "passed", verdict: "passed" };
		case "FAILED":
			return { status: "failed", verdict: "failed" };
		case "UNSAFE_TO_RUN":
		case "BLOCKED":
			return { status: "blocked", verdict: "blocked" };
	}
}

function mapRunStatus(status: string): {
	readonly status: RunBundleStatus;
	readonly verdict: RunBundleVerdict;
} {
	switch (status) {
		case "passed":
			return { status: "passed", verdict: "passed" };
		case "failed":
		case "cancelled":
			return { status: "failed", verdict: "failed" };
		case "suspended":
			return { status: "blocked", verdict: "blocked" };
		default:
			return { status: "running", verdict: "blocked" };
	}
}

function isUnsafeDecision(decision: StoredRunBundleDecisionRow): boolean {
	const haystack = [decision.kind, ...parseReasons(decision.reasons)]
		.join(" ")
		.toLowerCase();
	return /\bunsafe\b|\bforbidden\b|outside granted scope|without grant|without matching capability grant|policy bypass|quarantine|deploy|secret/.test(
		haystack,
	);
}

function formatDecisionIssueMessage(
	decision: StoredRunBundleDecisionRow,
): string {
	const reasons = parseReasons(decision.reasons);
	return `${decision.kind} ${decision.outcome}${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`;
}

function collectConstraints(packet: UnitPacket): string[] {
	const constraints = new Set<string>();
	constraints.add(`policy profile: ${packet.unit.policyProfile}`);
	constraints.add(`verification contract: ${packet.unit.verificationContract}`);
	for (const scope of packet.intent?.constraints.scope ?? [])
		constraints.add(`scope: ${scope}`);
	for (const forbidden of packet.intent?.constraints.forbidden ?? [])
		constraints.add(`forbidden: ${forbidden}`);
	for (const verification of packet.intent?.constraints.verification ?? []) {
		constraints.add(`verification: ${verification}`);
	}
	for (const output of packet.verification.requiredOutputs) {
		constraints.add(`required output: ${output}`);
	}
	return [...constraints];
}

function collectChangedFiles(
	rows: readonly StoredRunBundleArtifactRow[],
): string[] {
	return [...new Set(rows.map((row) => row.location))];
}

function findPersistedOutputArtifact(
	rows: readonly StoredRunBundleArtifactRow[],
	runId: string,
	outputPath: string,
): StoredRunBundleArtifactRow | undefined {
	const normalizedOutputPath = normalizeArtifactLocation(outputPath);
	const persistedLocation = `.buildplane/artifacts/${runId}/${normalizedOutputPath}`;
	return rows.find((row) => {
		const location = normalizeArtifactLocation(row.location);
		return location === normalizedOutputPath || location === persistedLocation;
	});
}

function normalizeArtifactLocation(location: string): string {
	return location.replace(/\\/g, "/").replace(/^\.\//, "");
}

function finalSummary(
	verdict: RunBundleVerdict,
	verifiedCount: number,
	unverifiedCount: number,
	blockerCount: number,
): string {
	if (verdict === "passed") {
		return `Run passed with ${verifiedCount} verified criteria and no open blockers.`;
	}
	if (verdict === "failed") {
		return `Run failed with ${unverifiedCount} unverified criteria and ${blockerCount} blocker receipts.`;
	}
	return `Run blocked with ${unverifiedCount} unverified criteria and ${blockerCount} blocker receipts.`;
}

function finalReceiptText(
	verdict: RunBundleVerdict,
	verifiedCount: number,
	unverifiedCount: number,
	blockerCount: number,
): string {
	return `${verdict.toUpperCase()}: ${verifiedCount} verified criteria; ${unverifiedCount} unverified criteria; ${blockerCount} blockers.`;
}

function formatExecutionTarget(packet: UnitPacket): string | null {
	if (packet.execution) {
		return [packet.execution.command, ...(packet.execution.args ?? [])].join(
			" ",
		);
	}
	if (packet.model) {
		return `${packet.model.provider}/${packet.model.model}`;
	}
	return null;
}

function parseReasons(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function readRunLog(
	projectRoot: string,
	runId: string,
	stream: "stdout" | "stderr",
): string | undefined {
	const { logsDir } = resolveProjectLayout(projectRoot);
	const path = resolve(logsDir, `${runId}.${stream}.log`);
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

function outputFileArtifact(
	projectRoot: string,
	input: {
		readonly id: string;
		readonly producedByEventId: string;
		readonly location: string;
	},
): RunBundleArtifactRecord {
	const content = readSafeProjectFile(projectRoot, input.location);
	const bytes = content ?? `Artifact location: ${input.location}`;
	return {
		id: input.id,
		kind: "file",
		sha: digestText(bytes),
		produced_by_event_id: input.producedByEventId,
		...(content === undefined ? { uri: input.location } : { bytes: content }),
		preview: {
			mime: "text/plain",
			line_count: countLines(bytes),
			title: input.location,
		},
	};
}

function textArtifact(input: {
	readonly id: string;
	readonly kind: RunBundleArtifactKind;
	readonly producedByEventId: string;
	readonly title: string;
	readonly bytes: string;
}): RunBundleArtifactRecord {
	return {
		id: input.id,
		kind: input.kind,
		sha: digestText(input.bytes),
		produced_by_event_id: input.producedByEventId,
		bytes: input.bytes,
		preview: {
			mime: "text/plain",
			line_count: countLines(input.bytes),
			title: input.title,
		},
	};
}

function readSafeProjectFile(
	projectRoot: string,
	location: string,
): string | undefined {
	const candidate = isAbsolute(location)
		? resolve(location)
		: resolve(projectRoot, location);
	const root = resolve(projectRoot);
	const relativePath = relative(root, candidate);
	if (
		relativePath.startsWith("..") ||
		isAbsolute(relativePath) ||
		!existsSync(candidate)
	) {
		return undefined;
	}
	return readFileSync(candidate, "utf8");
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.endsWith("\n")
		? text.split("\n").length - 1
		: text.split("\n").length;
}

function toBundleEventId(id: string): string {
	return `evt_${slug(id)}`;
}

function toBundleArtifactId(id: string): string {
	return `art_${slug(id)}`;
}

function slug(value: string): string {
	const slugged = value
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return (
		slugged || digestText(value).slice("sha256:".length, "sha256:".length + 12)
	);
}

function digestText(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function digestJson(value: unknown): string {
	return digestText(stableStringify(value));
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}
