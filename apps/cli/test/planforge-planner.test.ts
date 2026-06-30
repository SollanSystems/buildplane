import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("readCompletedSliceIds", () => {
	it("returns an empty list when the workspace has no tape", async () => {
		expect(await readCompletedSliceIds(ws)).toEqual([]);
	});
});

describe("runPlannerProposal", () => {
	it("proposes M6-S6 as a PASS plan from the committed roadmap (no prior slices done)", async () => {
		const proposal = await runPlannerProposal({
			roadmapPath: ROADMAP,
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
			roadmapPath: ROADMAP,
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
