import { describe, expect, it } from "vitest";
import {
	loadRoadmapFromString,
	type RoadmapDoc,
	selectNextRoadmapSlice,
} from "../src/roadmap.ts";

const DOC: RoadmapDoc = {
	schemaVersion: "buildplane.roadmap.v0",
	milestone: "M5",
	slices: [
		{
			id: "M5-S1",
			title: "Approval inbox list view",
			status: "done",
			objective: "Render the pending-approval inbox from the tape.",
			allowedSideEffects: ["code-edit"],
			verificationCommands: [
				"pnpm -C . exec vitest run packages/kernel/test/inbox.test.ts",
			],
			acceptanceCriteria: [
				"Inbox lists every un-acted operator_decision_requested event.",
			],
			dependsOn: [],
			pathGlobs: ["packages/kernel/src/**", "packages/kernel/test/**"],
		},
		{
			id: "M5-S2",
			title: "Run inspector",
			status: "pending",
			objective: "Add a read-only run inspector.",
			allowedSideEffects: ["code-edit"],
			verificationCommands: [
				"pnpm -C . exec vitest run packages/kernel/test/inspector.test.ts",
			],
			acceptanceCriteria: ["Inspector replays a run from the tape."],
			dependsOn: ["M5-S1"],
			pathGlobs: ["packages/kernel/src/**"],
		},
	],
};

describe("loadRoadmapFromString", () => {
	it("parses a valid roadmap document", () => {
		const doc = loadRoadmapFromString(JSON.stringify(DOC));
		expect(doc.milestone).toBe("M5");
		expect(doc.slices).toHaveLength(2);
	});

	it("throws on a wrong schemaVersion", () => {
		const bad = { ...DOC, schemaVersion: "buildplane.roadmap.v9" };
		expect(() => loadRoadmapFromString(JSON.stringify(bad))).toThrow(
			/schemaVersion/,
		);
	});

	it("throws on a slice missing verificationCommands", () => {
		const bad = {
			...DOC,
			slices: [{ ...DOC.slices[1], verificationCommands: [] }],
		};
		expect(() => loadRoadmapFromString(JSON.stringify(bad))).toThrow(
			/verificationCommands/,
		);
	});
});

describe("selectNextRoadmapSlice", () => {
	it("returns M5-S2 as the first selectable slice (M5-S1 done, deps satisfied)", () => {
		expect(selectNextRoadmapSlice(DOC, ["M5-S1"])?.id).toBe("M5-S2");
	});

	it("skips a slice whose dependsOn are not yet completed", () => {
		const doc = {
			...DOC,
			slices: [{ ...DOC.slices[1], status: "pending" as const }],
		};
		expect(selectNextRoadmapSlice(doc, [])).toBeUndefined();
	});

	it("returns undefined when every slice is done", () => {
		const doc = {
			...DOC,
			slices: DOC.slices.map((s) => ({ ...s, status: "done" as const })),
		};
		expect(selectNextRoadmapSlice(doc, ["M5-S1", "M5-S2"])).toBeUndefined();
	});

	it("returns undefined when the next pending slice is dependency-blocked", () => {
		// M5-S2 pending but M5-S1 not yet completed -> S2 blocked, nothing else pending
		const doc = { ...DOC, slices: [DOC.slices[1]] };
		expect(selectNextRoadmapSlice(doc, [])).toBeUndefined();
	});
});
