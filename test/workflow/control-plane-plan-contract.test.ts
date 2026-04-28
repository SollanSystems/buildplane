import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const plan = readFileSync(
	join(
		process.cwd(),
		"docs/superpowers/plans/2026-04-22-buildplane-control-plane-30-day-plan.md",
	),
	"utf8",
);

function extractSection(markdown: string, heading: string) {
	const lines = markdown.split(/\r?\n/);
	let collecting = false;
	const collected: string[] = [];

	for (const line of lines) {
		if (/^## /.test(line)) {
			if (collecting) {
				break;
			}

			collecting = line === heading;
		}

		if (collecting) {
			collected.push(line);
		}
	}

	return collected.join("\n");
}

const slice3 = extractSection(
	plan,
	"## Slice 3 — Replay / review / recovery as the default operator narrative",
);

describe("control-plane plan contract", () => {
	it("records Slice 3 replay review recovery acceptance as complete", () => {
		expect(slice3).toContain(
			"- [x] replay-oriented workflows are easy to discover and understand from CLI help/docs",
		);
		expect(slice3).toContain(
			"- [x] implement-then-review is presented as the default high-trust mode where appropriate",
		);
		expect(slice3).toContain(
			"- [x] recovery after bad or partial runs is visible in operator surfaces and docs",
		);
		expect(slice3).toContain(
			"- [x] a clear benchmark/demo story exists showing why review/replay/recovery beats raw one-shot execution for at least one meaningful case",
		);
	});
});
