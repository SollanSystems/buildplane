import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createPlanForgeDryRunPlan,
	dispatchAdmittedPlan,
} from "@buildplane/planforge";
import { createBuildplaneStorage } from "@buildplane/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findOrphanedPlanForgeDispatches,
	readPlanForgeDispatchManifests,
	resolvePlanForgeResumeModel,
	writePlanForgeDispatchManifest,
} from "../src/run-cli.js";

const inputFixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures/planforge/goal-input.md",
);

describe("planforge dispatch manifest", () => {
	let ws: string;
	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), "bp-manifest-"));
	});
	afterEach(() => rmSync(ws, { recursive: true, force: true }));

	it("round-trips a manifest and lists it", () => {
		const m = {
			runId: "00000000-0000-8000-8000-000000000001",
			inputPath: "/abs/goal.md",
			planId: "pf-plan-95d7132e",
			idempotencyKey: "idem-1",
			createdAt: "2026-06-22T00:00:00.000Z",
		};
		writePlanForgeDispatchManifest(ws, m);
		const onDisk = JSON.parse(
			readFileSync(
				join(ws, ".buildplane", "planforge", "dispatch", `${m.runId}.json`),
				"utf8",
			),
		);
		expect(onDisk).toEqual(m);
		expect(readPlanForgeDispatchManifests(ws)).toEqual([m]);
	});

	it("returns [] when no dispatch dir exists", () => {
		expect(readPlanForgeDispatchManifests(ws)).toEqual([]);
	});

	it("round-trips the optional model override (R-001 crash-resume durability)", () => {
		const m = {
			runId: "00000000-0000-8000-8000-0000000000ab",
			inputPath: "/abs/goal.md",
			planId: "pf-plan-95d7132e",
			idempotencyKey: "idem-1",
			createdAt: "2026-06-22T00:00:00.000Z",
			model: "claude-opus-4-8",
		};
		writePlanForgeDispatchManifest(ws, m);
		const onDisk = JSON.parse(
			readFileSync(
				join(ws, ".buildplane", "planforge", "dispatch", `${m.runId}.json`),
				"utf8",
			),
		);
		expect(onDisk.model).toBe("claude-opus-4-8");
		expect(readPlanForgeDispatchManifests(ws)[0].model).toBe("claude-opus-4-8");
	});
});

describe("resolvePlanForgeResumeModel (R-001: model durable across resume/recover)", () => {
	let ws: string;
	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), "bp-resume-model-"));
	});
	afterEach(() => rmSync(ws, { recursive: true, force: true }));

	it("recovers the dispatched model from the matching manifest and threads it into re-dispatched packets", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const runId = "00000000-0000-8000-8000-00000000abcd";
		writePlanForgeDispatchManifest(ws, {
			runId,
			inputPath: inputFixture,
			planId: plan.id,
			idempotencyKey: plan.idempotencyKey,
			createdAt: "2026-06-22T00:00:00.000Z",
			model: "claude-opus-4-8",
		});

		const model = resolvePlanForgeResumeModel(
			readPlanForgeDispatchManifests(ws),
			runId,
		);
		expect(model).toBe("claude-opus-4-8");

		// The recovered model must reach the re-dispatched suffix packets — the
		// exact crash-and-resume path R-001 was dropping it on.
		const packets = dispatchAdmittedPlan({
			plan,
			admittedEventId: "evt-1",
			policyProfile: "default",
			model,
		});
		expect(packets.length).toBeGreaterThan(0);
		for (const p of packets) {
			expect(p.model.model).toBe("claude-opus-4-8");
		}
	});

	it("returns undefined when no manifest matches the runId (suffix keeps the dispatch default)", () => {
		writePlanForgeDispatchManifest(ws, {
			runId: "some-other-run",
			inputPath: "/abs/a.md",
			planId: "pf-plan-x",
			idempotencyKey: "k",
			createdAt: "t",
			model: "claude-opus-4-8",
		});
		expect(
			resolvePlanForgeResumeModel(
				readPlanForgeDispatchManifests(ws),
				"missing-run",
			),
		).toBeUndefined();
	});
});

describe("findOrphanedPlanForgeDispatches", () => {
	let ws: string;
	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), "bp-orphan-"));
	});
	afterEach(() => rmSync(ws, { recursive: true, force: true }));

	function pkt(unitId: string) {
		return {
			unit: {
				id: unitId,
				kind: "planforge-task",
				scope: ".",
				inputRefs: [],
				expectedOutputs: [],
				verificationContract: "true",
				policyProfile: "default",
			},
			execution: { command: "true" },
			verification: { requiredOutputs: [] },
		} as never;
	}

	it("returns manifests whose plan has a still-running storage row and no terminal receipt", async () => {
		const storage = createBuildplaneStorage(ws);
		storage.initializeProject();
		const a = storage.createRun(pkt("pf-plan-aaa:PF1"));
		storage.markRunRunning(a.id); // orphaned: still running
		const b = storage.createRun(pkt("pf-plan-bbb:PF1"));
		storage.markRunRunning(b.id);
		storage.completeRun(b.id, "passed"); // not running -> not orphaned

		writePlanForgeDispatchManifest(ws, {
			runId: "r-aaa",
			inputPath: "/abs/a.md",
			planId: "pf-plan-aaa",
			idempotencyKey: "k-a",
			createdAt: "t",
		});
		writePlanForgeDispatchManifest(ws, {
			runId: "r-bbb",
			inputPath: "/abs/b.md",
			planId: "pf-plan-bbb",
			idempotencyKey: "k-b",
			createdAt: "t",
		});

		const orphans = await findOrphanedPlanForgeDispatches(ws);
		expect(orphans.map((m) => m.planId)).toEqual(["pf-plan-aaa"]);
	});

	it("returns [] when there are no running runs", async () => {
		const storage = createBuildplaneStorage(ws);
		storage.initializeProject();
		writePlanForgeDispatchManifest(ws, {
			runId: "r",
			inputPath: "/abs/a.md",
			planId: "pf-plan-x",
			idempotencyKey: "k",
			createdAt: "t",
		});
		expect(await findOrphanedPlanForgeDispatches(ws)).toEqual([]);
	});
});
