import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const matrixPath = join(
	process.cwd(),
	"docs/operations/trust-spine-compatibility-matrix.md",
);
const matrix = readFileSync(matrixPath, "utf8");
const architectureIndex = readFileSync(
	join(process.cwd(), "docs/architecture/README.md"),
	"utf8",
);
const architecture = readFileSync(
	join(process.cwd(), "docs/architecture/trust-spine.md"),
	"utf8",
);
const runbook = readFileSync(
	join(process.cwd(), "docs/operations/trust-spine-governed-runbook.md"),
	"utf8",
);
const normalizedMatrix = matrix.replace(/\s+/g, " ");

describe("Trust Spine documentation contract", () => {
	it("publishes and links the operator compatibility matrix", () => {
		expect(architectureIndex).toContain(
			"docs/operations/trust-spine-compatibility-matrix.md",
		);
		expect(architecture).toContain(
			"../operations/trust-spine-compatibility-matrix.md",
		);
		expect(runbook).toContain("trust-spine-compatibility-matrix.md");
	});

	it("does not mistake readable compatibility artifacts for governed authority", () => {
		for (const requiredStatement of [
			"Readability never upgrades historical or caller-supplied data into authority.",
			"No governed receipt; auto-merge otherwise rejected",
			"A valid shape or digest is not a host capability.",
			"The only admitted governed commit mode.",
			"Block before any worker starts.",
			"Cannot be exported as a trusted receipt, promotion proof, or routing fact.",
		]) {
			expect(normalizedMatrix).toContain(requiredStatement);
		}
	});

	it("documents the raw, shadow, and protected-host migration boundaries", () => {
		for (const requiredStatement of [
			"`buildplane run --raw ...`",
			"Quarantined beta foundation",
			"Quarantined shadow foundation",
			"Shadow-only",
			"Deploy a separate OS/hardware-protected host",
			"Complete the signed 30-task, three-trial release campaign",
		]) {
			expect(normalizedMatrix).toContain(requiredStatement);
		}
	});
});
