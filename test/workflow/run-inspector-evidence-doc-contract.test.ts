import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const evidenceDocPath = join(
	repoRoot,
	"docs/architecture/run-inspector-evidence-slice.md",
);
const evidenceDoc = readFileSync(evidenceDocPath, "utf8");
const architectureIndex = readFileSync(
	join(repoRoot, "docs/architecture/README.md"),
	"utf8",
);
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const controlPlanePlan = readFileSync(
	join(
		repoRoot,
		"docs/superpowers/plans/2026-04-22-buildplane-control-plane-30-day-plan.md",
	),
	"utf8",
);
const generatedLedgerTypes = readFileSync(
	join(repoRoot, "packages/ledger-client/src/generated/index.ts"),
	"utf8",
);

const eventKindEnumBlock = generatedLedgerTypes.match(
	/export enum EventKind \{([\s\S]*?)\n\}/,
)?.[1];
const generatedEventKinds = Array.from(
	eventKindEnumBlock?.matchAll(/\t[A-Za-z]+ = "([^"]+)",/g) ?? [],
	(match) => match[1],
);

describe("Run Inspector evidence docs contract", () => {
	it("links the first Mission Control slice from operator-facing docs", () => {
		expect(readme).toContain("## Evidence-first Run Inspector");
		expect(readme).toContain(
			"docs/architecture/run-inspector-evidence-slice.md",
		);
		expect(readme).toContain("Event Timeline");
		expect(readme).toContain("Evidence Pane");
		expect(readme).toContain("Outcome Strip");
		expect(architectureIndex).toContain(
			"docs/architecture/run-inspector-evidence-slice.md",
		);
	});

	it("keeps the MVP forensic and read-only instead of a broad cockpit", () => {
		expect(evidenceDoc).toContain("Run Inspector");
		expect(evidenceDoc).toContain("read-only forensic");
		expect(evidenceDoc).toContain("BLOCKED run");
		expect(evidenceDoc).toContain(
			"No panel may invent synthetic reasoning events",
		);
		for (const deferredCapability of [
			"live cockpit controls",
			"orchestration graph",
			"intake parser",
			"replay scrubber",
			"agent persona cards",
			"synthetic chain-of-thought display",
		]) {
			expect(evidenceDoc).toContain(deferredCapability);
		}
	});

	it("maps every panel to current runtime records", () => {
		for (const runtimeRecord of [
			"InspectSnapshot.eventTape",
			"InspectSnapshot.evidence",
			"InspectSnapshot.decisions",
			"InspectSnapshot.artifacts",
			"EvidenceRecord",
			"DecisionRecord",
			"ArtifactRecord",
			"packages/kernel/src/run-loop.ts",
			"packages/storage/src/contracts.ts",
			"packages/ledger-client/src/generated/index.ts",
		]) {
			expect(evidenceDoc).toContain(runtimeRecord);
		}
	});

	it("pins the documented event vocabulary to the generated ledger enum", () => {
		expect(generatedEventKinds.length).toBeGreaterThan(0);
		for (const eventKind of generatedEventKinds) {
			expect(evidenceDoc).toContain(`\`${eventKind}\``);
		}
	});

	it("records the docs/evidence slice in the control-plane plan", () => {
		expect(controlPlanePlan).toContain(
			"## Slice 4 — Evidence-first Run Inspector contract",
		);
		expect(controlPlanePlan).toContain(
			"the first Mission Control slice is named Run Inspector",
		);
		expect(controlPlanePlan).toContain(
			"the closed v1 event vocabulary comes from generated `EventKind` values",
		);
		expect(controlPlanePlan).toContain(
			"the first Mission Control slice is constrained to an evidence-first Run Inspector contract",
		);
	});
});
