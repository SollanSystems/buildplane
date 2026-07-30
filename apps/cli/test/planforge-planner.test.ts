import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildPlannerWorkerPacket,
	readCompletedSliceIds,
	runPlannerProposal,
} from "../src/planforge-planner.ts";

const REPO_ROOT = join(__dirname, "../../..");
const ROADMAP = join(REPO_ROOT, "docs/roadmap.json");
const TRUSTED_BASE = "15dbb32db0e1f0024687533755805fc23f3ef6d4";
const REMOTE = "https://github.com/SollanSystems/buildplane.git";

let ws: string;
beforeEach(() => {
	ws = mkdtempSync(join(tmpdir(), "pf-planner-"));
});
afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
});

/**
 * The committed roadmap is exhausted — every slice is `done`. These planner
 * cases need a *pending* slice to exercise, so they reuse the committed slice
 * content verbatim and flip only its status.
 *
 * Deriving the fixture instead of hardcoding one keeps the PASS assertions
 * meaningful (identical objective, globs, verification commands, acceptance
 * criteria) while decoupling planner behaviour from whatever happens to be
 * outstanding in the real roadmap. Pinning these to the live file is what
 * previously forced `docs/roadmap.json` to advertise shipped work as pending.
 */
function pendingRoadmapFixture(sliceId: string): string {
	const doc = JSON.parse(readFileSync(ROADMAP, "utf8")) as {
		slices: { id: string; status: string }[];
	};
	const slice = doc.slices.find((candidate) => candidate.id === sliceId);
	if (!slice) throw new Error(`roadmap fixture: unknown slice ${sliceId}`);
	slice.status = "pending";
	const path = join(ws, "roadmap.json");
	writeFileSync(path, JSON.stringify(doc), "utf8");
	return path;
}

describe("readCompletedSliceIds", () => {
	it("returns an empty list when the workspace has no tape", async () => {
		expect(await readCompletedSliceIds(ws)).toEqual([]);
	});

	it("does not treat a legacy completed plan_receipt as governed completion", async () => {
		const ledgerDir = join(ws, ".buildplane", "ledger");
		mkdirSync(ledgerDir, { recursive: true });
		const db = new DatabaseSync(join(ledgerDir, "events.db"));
		try {
			db.exec("CREATE TABLE events (id TEXT, payload TEXT, kind TEXT)");
			db.prepare("INSERT INTO events VALUES (?, ?, ?)").run(
				"legacy-receipt",
				JSON.stringify({
					PlanReceiptRecordedV1: {
						outcome: "completed",
						plan_id: "legacy-plan",
					},
				}),
				"plan_receipt",
			);
		} finally {
			db.close();
		}

		expect(await readCompletedSliceIds(ws)).toEqual([]);
	});
});

describe("runPlannerProposal", () => {
	it("proposes a pending slice as a PASS plan (no prior slices done)", async () => {
		const proposal = await runPlannerProposal({
			roadmapPath: pendingRoadmapFixture("M6-S6"),
			workspace: ws,
			remote: REMOTE,
			trustedBase: TRUSTED_BASE,
		});
		expect(proposal.sliceId).toBe("M6-S6");
		expect(proposal.status).toBe("PASS");
		expect(proposal.planMarkdown).toContain("## Tasks");
		expect(proposal.planMarkdown).toContain("### M6-S6:");
	});

	it("round-trips the emitted plan back through compile() to the intended slice", async () => {
		const proposal = await runPlannerProposal({
			roadmapPath: pendingRoadmapFixture("M6-S6"),
			workspace: ws,
			remote: REMOTE,
			trustedBase: TRUSTED_BASE,
		});
		expect(proposal.validation.status).toBe("PASS");
		expect(proposal.validation.missingEvidence).toEqual([]);
	});
});

describe("buildPlannerWorkerPacket", () => {
	it("builds a model packet routed to claude-code with no execution block", () => {
		const packet = buildPlannerWorkerPacket({
			sliceId: "M6-S6",
			roadmapPath: ROADMAP,
			outputPlanPath: join(ws, "plan.md"),
			model: "claude-sonnet-latest",
		});
		expect((packet as { execution?: unknown }).execution).toBeUndefined();
		expect(packet.model?.provider).toBe("anthropic");
		expect(packet.routingHints?.preferredWorker).toBe("claude-code");
		expect(packet.verification.requiredOutputs).toContain(join(ws, "plan.md"));
		expect(packet.unit.expectedOutputs).toEqual([]);
	});
});
