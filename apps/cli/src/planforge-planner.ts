import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UnitPacket } from "@buildplane/kernel";
import {
	buildPlannerPlanMarkdown,
	createPlanForgeDryRunPlan,
	loadRoadmapFromString,
	type PlanForgeValidation,
	type PlanForgeValidationStatus,
	type RoadmapDoc,
	type RoadmapSlice,
	selectNextRoadmapSlice,
} from "@buildplane/planforge";

export interface PlannerProposal {
	readonly sliceId: string;
	readonly planMarkdown: string;
	readonly validation: PlanForgeValidation;
	readonly status: PlanForgeValidationStatus;
}

interface PlanReceiptRow {
	id: string;
	payload: string;
}

/**
 * Emit, deterministically, the `plan.md` the planner would author for a slice.
 * Used both to propose the next slice and (offline) to recompute a slice's
 * stable PlanForge plan id so a completed receipt on the tape can be mapped back
 * to its slice id without an L0 payload derivation.
 */
function emitSliceMarkdown(
	slice: RoadmapSlice,
	remote: string,
	trustedBase: string,
): string {
	return buildPlannerPlanMarkdown({ slice, remote, trustedBase });
}

/**
 * The deterministic PlanForge plan id (`pf-plan-<fingerprint>`) the planner's
 * emitted `plan.md` produces for a slice at the given remote/base. This is the
 * mapping key from a recorded `plan_receipt.plan_id` back to a roadmap slice id:
 * the roadmap + the deterministic emitter ARE the mapping, so no `slice_id`
 * field is added to the signed receipt payload (that would be an L0 derivation).
 */
function planIdForSlice(
	slice: RoadmapSlice,
	remote: string,
	trustedBase: string,
): string {
	const dir = mkdtempSync(join(tmpdir(), "planner-planid-"));
	try {
		const planPath = join(dir, "plan.md");
		writeFileSync(
			planPath,
			emitSliceMarkdown(slice, remote, trustedBase),
			"utf8",
		);
		return createPlanForgeDryRunPlan(planPath).id;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface ReadCompletedSliceIdsOptions {
	/**
	 * The roadmap whose slice ids the completed `plan_receipt` rows are mapped
	 * back to. When omitted, the raw completed `plan_id`s are returned (the tape
	 * carries no slice id, so without the roadmap there is nothing to map to).
	 */
	readonly roadmap?: RoadmapDoc;
	readonly remote?: string;
	readonly trustedBase?: string;
}

/**
 * Read-only tape scan for completed roadmap slices. Reuses the read-only
 * `node:sqlite` pattern over `.buildplane/ledger/events.db`. A slice is
 * 'completed' when a `plan_receipt` with `outcome='completed'` exists whose
 * recorded `plan_id` equals the deterministic plan id the planner emits for that
 * slice. The signed receipt carries `plan_id` only (no slice id / title), so the
 * slice id is recovered by recomputing each slice's plan id from the roadmap —
 * not by adding an L0 payload field.
 */
export async function readCompletedSliceIds(
	workspace: string,
	options: ReadCompletedSliceIdsOptions = {},
): Promise<string[]> {
	const eventsDbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	if (!existsSync(eventsDbPath)) {
		return [];
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	let completedPlanIds: string[];
	try {
		const rows = db
			.prepare(
				"SELECT id, payload FROM events WHERE kind = 'plan_receipt' ORDER BY id ASC",
			)
			.all() as unknown as PlanReceiptRow[];
		const planIds = new Set<string>();
		for (const row of rows) {
			const payload = JSON.parse(row.payload) as {
				PlanReceiptRecordedV1?: { outcome?: string; plan_id?: string };
			};
			const receipt = payload.PlanReceiptRecordedV1;
			if (receipt?.outcome === "completed" && receipt.plan_id) {
				planIds.add(receipt.plan_id);
			}
		}
		completedPlanIds = [...planIds];
	} finally {
		db.close();
	}

	const { roadmap } = options;
	if (!roadmap) {
		return completedPlanIds;
	}
	const remote = options.remote ?? "";
	const trustedBase = options.trustedBase ?? "";
	const completedSet = new Set(completedPlanIds);
	const completedSliceIds: string[] = [];
	for (const slice of roadmap.slices) {
		if (completedSet.has(planIdForSlice(slice, remote, trustedBase))) {
			completedSliceIds.push(slice.id);
		}
	}
	return completedSliceIds;
}

export interface RunPlannerProposalInput {
	readonly roadmapPath: string;
	readonly workspace: string;
	readonly remote: string;
	readonly trustedBase: string;
	readonly priorWork?: readonly string[];
}

/**
 * Full read-tape -> select -> emit -> validate cycle. `status` is `PASS` only
 * when the emitted `plan.md` validates, so the GAP-10 envelope check and the
 * GAP-7 supervisor key off `proposal.status`, never a worker exit code.
 */
export async function runPlannerProposal(
	input: RunPlannerProposalInput,
): Promise<PlannerProposal> {
	const doc = loadRoadmapFromString(readFileSync(input.roadmapPath, "utf8"));
	const completed = await readCompletedSliceIds(input.workspace, {
		roadmap: doc,
		remote: input.remote,
		trustedBase: input.trustedBase,
	});
	const slice = selectNextRoadmapSlice(doc, completed);
	if (!slice) {
		throw new Error(
			"planner: no eligible roadmap slice (roadmap exhausted or dependency-blocked).",
		);
	}
	const planMarkdown = emitSliceMarkdown(
		slice,
		input.remote,
		input.trustedBase,
	);
	const dir = mkdtempSync(join(tmpdir(), "planner-proposal-"));
	try {
		const planPath = join(dir, "plan.md");
		writeFileSync(planPath, planMarkdown, "utf8");
		const plan = createPlanForgeDryRunPlan(planPath);
		return {
			sliceId: slice.id,
			planMarkdown,
			validation: plan.validation,
			status: plan.validation.status,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface BuildPlannerWorkerPacketInput {
	readonly sliceId: string;
	readonly roadmapPath: string;
	readonly outputPlanPath: string;
	readonly model: string;
}

/**
 * Model packet that dispatches an LLM planning worker to WRITE `plan.md`. No
 * `execution` block — the runtime router checks `execution` first and would
 * otherwise route this to the command executor; `routingHints.preferredWorker`
 * routes it to the Claude Code executor instead. Gated behind a later flag; the
 * `--once` path uses the deterministic emitter (no LLM call).
 */
export function buildPlannerWorkerPacket(
	input: BuildPlannerWorkerPacketInput,
): UnitPacket {
	const prompt = [
		`You are the Buildplane planning worker. Read the bounded roadmap at ${input.roadmapPath} and the slice ${input.sliceId}.`,
		`Write a PlanForge plan.md to ${input.outputPlanPath} for slice ${input.sliceId} ONLY.`,
		"The plan.md MUST contain: a ## Goal section; a ## Repository context list (Remote, Trusted base, Worktree policy: isolated-worktree-required); a ## Safety constraints section with the five exact required lines; a ## Tasks section with a ### <ID>: <Title> subsection carrying Objective, Assignee-hint, Workspace, Allowed-side-effects, Forbidden-side-effects, Depends-on, Acceptance-criteria, and Verification-commands; a ## Required output section.",
		"Declare allowedSideEffects code-edit and list real verificationCommands. Do not invent work outside the roadmap slice.",
	].join("\n\n");
	return {
		unit: {
			id: `planner:${input.sliceId}`,
			kind: "planforge-planner",
			scope: "isolated-worktree",
			inputRefs: [input.roadmapPath],
			expectedOutputs: [],
			verificationContract: "true",
			policyProfile: "planforge-planner",
		},
		model: { provider: "anthropic", model: input.model, prompt },
		verification: { requiredOutputs: [input.outputPlanPath] },
		routingHints: { preferredWorker: "claude-code" },
		provenance_ref: "",
	};
}
