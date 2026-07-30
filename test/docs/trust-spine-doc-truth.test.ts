import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the operator-facing docs against re-describing a hardcoded throw as a
 * deployable or supported surface.
 *
 * The failure this exists to prevent is expensive and quiet: the compatibility
 * matrix once described PlanForge admission as "Blocked pending unified
 * transaction", which reads as *deploy a host and it works*. It is not — the
 * protected session protocol defines no PlanForge operation, and the broker
 * binds those methods to a throw that fires after a successful host probe. A
 * reader who believes the doc spends an entire infrastructure budget on a
 * protocol that does not exist.
 *
 * Every assertion derives its "what is actually true" side from source, so
 * implementing a surface for real relaxes the corresponding doc requirement
 * instead of forcing a test edit.
 *
 * Paths are resolved exactly rather than globbed: this repo carries stale
 * `.worktrees/` and `.claude/worktrees/` copies of the same files, and a tree
 * scan would silently read those instead.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string): string =>
	readFileSync(resolve(REPO_ROOT, relative), "utf8");

const MATRIX_PATH = "docs/operations/trust-spine-compatibility-matrix.md";
const BROKER_HOST_PATH = "apps/cli/src/governed-authority-broker-host.ts";
const AUTHORIZE_ENVELOPE_PATH = "apps/cli/src/planforge-authorize-envelope.ts";

/** Return the single matrix table row whose first cell contains `needle`. */
function matrixRow(matrix: string, needle: string): string {
	const rows = matrix
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.filter((line) => (line.split("|")[1] ?? "").includes(needle));
	expect(
		rows,
		`expected exactly one compatibility-matrix row whose first cell mentions ${needle}`,
	).toHaveLength(1);
	return rows[0] as string;
}

describe("trust-spine docs match the code they describe", () => {
	it("describes PlanForge admission as unbuilt, not as deployment-gated", () => {
		// Source truth: both PlanForge broker methods are bound to the throwing
		// implementation, and that binding sits *after* the host probe.
		const host = read(BROKER_HOST_PATH);
		expect(host).toMatch(/admitPlanForge:\s*unsupportedPlanForge/);
		expect(host).toMatch(
			/openPlanForgeCandidateSession:\s*unsupportedPlanForge/,
		);

		const row = matrixRow(read(MATRIX_PATH), "planforge admit");
		expect(row).toContain("Unbuilt at the protocol level");
		// The exact phrasing that misled a reader into budgeting for deployment.
		expect(row).not.toContain("Blocked pending unified transaction");
	});

	it("does not list authorize-envelope as a supported planning view", () => {
		// Source truth: the command entry point ignores its arguments entirely and
		// throws on every invocation, on every platform, host or no host.
		const command = read(AUTHORIZE_ENVELOPE_PATH);
		const entryPoint = command.match(
			/export async function runPlanForgeAuthorizeEnvelopeCommand\([\s\S]*?\):\s*Promise<never>\s*\{([\s\S]*?)\n\}/,
		);
		expect(
			entryPoint,
			"authorize-envelope entry point should still return Promise<never>",
		).not.toBeNull();
		expect(entryPoint?.[1]).toContain("throw new Error(");

		const matrix = read(MATRIX_PATH);
		expect(matrixRow(matrix, "planforge dry-run")).not.toContain(
			"authorize-envelope",
		);
		expect(matrixRow(matrix, "planforge authorize-envelope")).toContain(
			"Unbuilt",
		);

		// The architecture doc previously carried the same claim in prose.
		expect(read("docs/architecture/trust-spine.md")).not.toMatch(
			/`planforge dry-run`, `plan`, `authorize-envelope`[^.]*remain available/,
		);
	});

	it("marks the M6 demo historical while it narrates a rejected flag", () => {
		// Source truth: the admit parser's reject message enumerates the accepted
		// flags, and --operator is not among them.
		const rejectMessage = read("apps/cli/src/run-cli.ts").match(
			/Unsupported PlanForge governed admit argument: \$\{argument\}\. ([^`"]*)/,
		)?.[1];
		expect(rejectMessage, "admit parser reject message").toBeDefined();
		expect(rejectMessage).not.toContain("--operator");

		// So any doc that still narrates --operator must say it is historical.
		for (const path of [
			"scripts/run-demo.mjs",
			"docs/operations/2026-07-02-m6-demo-runbook.md",
		]) {
			const contents = read(path);
			if (!contents.includes("--operator")) continue;
			expect(
				contents,
				`${path} narrates --operator, which the admit parser rejects, so it must be marked HISTORICAL`,
			).toContain("HISTORICAL");
		}
	});

	it("keeps the roadmap from advertising a shipped slice as pending", () => {
		// M6-S6 (result_ready) shipped in #235. A roadmap that still calls it
		// pending sends the planner at completed work.
		const roadmap = JSON.parse(read("docs/roadmap.json")) as {
			slices: readonly { id: string; status: string }[];
		};
		const s6 = roadmap.slices.find((slice) => slice.id === "M6-S6");
		expect(s6?.status).toBe("done");
	});
});
