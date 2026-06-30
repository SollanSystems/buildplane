import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GAP-9 authors docs/roadmap.json (D1); GAP-10 only READS it. The envelope's
// `milestone` field resolves against this single-milestone roadmap (now M6).
// This guard pins the flat-shape consumption contract GAP-7's selection rule
// depends on.
describe("docs/roadmap.json (authored by GAP-9)", () => {
	const raw = readFileSync(
		resolve(__dirname, "../../../docs/roadmap.json"),
		"utf8",
	);
	const roadmap = JSON.parse(raw) as {
		schemaVersion: string;
		milestone: string;
		slices: { id: string; status: string }[];
	};

	it("declares the v0 roadmap schema with a flat slices[] array", () => {
		expect(roadmap.schemaVersion).toBe("buildplane.roadmap.v0");
		expect(Array.isArray(roadmap.slices)).toBe(true);
	});

	it("carries the M6 milestone the envelope resolves against", () => {
		expect(roadmap.milestone).toBe("M6");
		expect(roadmap.slices.map((s) => s.id)).toContain("M6-S6");
	});
});
