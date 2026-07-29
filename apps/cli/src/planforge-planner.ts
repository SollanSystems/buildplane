import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Emit, deterministically, the `plan.md` the planner would author for a slice.
 */
function emitSliceMarkdown(
	slice: RoadmapSlice,
	remote: string,
	trustedBase: string,
): string {
	return buildPlannerPlanMarkdown({ slice, remote, trustedBase });
}

export interface ReadCompletedSliceIdsOptions {
	/**
	 * Reserved reducer-projection inputs. They keep the read API stable while
	 * completion is moved from legacy plan receipts to governed candidates.
	 */
	readonly roadmap?: RoadmapDoc;
	readonly remote?: string;
	readonly trustedBase?: string;
}

/**
 * Returns completed roadmap slices that have governed candidate/promotion
 * evidence. Legacy `plan_receipt` rows are intentionally ignored: they can be
 * produced by the retired ambient-worker PlanForge path and carry no immutable
 * candidate digest or promotion decision to prove the target mutation. A future
 * governed PlanForge projection will populate this from the trust-spine reducer;
 * until then planning remains conservative and treats every slice as unfinished.
 *
 * The parameters remain for source compatibility with the former read-only tape
 * scan and for the upcoming reducer-backed implementation.
 */
export async function readCompletedSliceIds(
	_workspace: string,
	_options: ReadCompletedSliceIdsOptions = {},
): Promise<string[]> {
	return [];
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
		execution_role: "implementer",
		model: { provider: "anthropic", model: input.model, prompt },
		verification: { requiredOutputs: [input.outputPlanPath] },
		routingHints: { preferredWorker: "claude-code" },
		provenance_ref: "",
	};
}
