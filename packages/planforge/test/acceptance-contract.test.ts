import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	acceptanceContractDigest,
	deriveAcceptanceContract,
} from "../src/acceptance-contract.ts";
import { digest } from "../src/digest.ts";
import { createPlanForgeDryRunPlan } from "../src/index.ts";

const inputFixture = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../apps/cli/test/fixtures/planforge/goal-input.md",
);

describe("deriveAcceptanceContract", () => {
	it("derives allowed_globs from the task capability bundle fsWrite", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = plan.tasks[0];

		const contract = deriveAcceptanceContract(plan, task);

		expect(contract.contract_version).toBe("v0");
		// PF1 allowedSideEffects {local-doc, local-fixture} → these globs, in the
		// side-effect-declaration order the task bundle emits (docs/** first).
		expect(contract.diff_scope.allowed_globs).toEqual([
			"docs/**",
			"apps/cli/test/fixtures/**",
			"packages/**/test/fixtures/**",
		]);
	});

	it("derives checks from the task verificationCommands, order-preserved and de-duplicated", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = {
			...plan.tasks[0],
			verificationCommands: [
				"pnpm lint",
				"pnpm typecheck",
				"pnpm lint", // duplicate dropped, first occurrence kept
			],
		};

		const contract = deriveAcceptanceContract(plan, task);

		expect(contract.checks).toEqual([
			{ command: "pnpm lint" },
			{ command: "pnpm typecheck" },
		]);
	});

	it("produces a byte-identical contract across two derivations of the same task", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const task = plan.tasks[0];

		const a = deriveAcceptanceContract(plan, task);
		const b = deriveAcceptanceContract(plan, task);

		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(acceptanceContractDigest(a)).toBe(acceptanceContractDigest(b));
	});

	it("labels the contract digest with the shared canonical-json sha256 contract", () => {
		const plan = createPlanForgeDryRunPlan(inputFixture);
		const contract = deriveAcceptanceContract(plan, plan.tasks[0]);

		expect(acceptanceContractDigest(contract)).toBe(digest(contract));
		expect(acceptanceContractDigest(contract)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});
