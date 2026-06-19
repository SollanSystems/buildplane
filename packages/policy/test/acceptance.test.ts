import type { AcceptanceContractV0 } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { evaluateAcceptanceContract } from "../src/acceptance";

describe("acceptance.contract finalization gate", () => {
	const contract: AcceptanceContractV0 = {
		contract_version: "v0",
		diff_scope: { allowed_globs: ["docs/**"] },
		checks: [{ command: "pnpm lint" }],
	};

	it("rejects when required acceptance evidence is missing", () => {
		const decision = evaluateAcceptanceContract(contract, {
			changedFiles: ["docs/receipt.md"],
			checkResults: [],
		});

		expect(decision).toMatchObject({
			kind: "acceptance.contract",
			outcome: "rejected",
			reasons: [
				"acceptance.contract missing required check result for pnpm lint.",
			],
		});
	});

	it("passes when required acceptance evidence is present and successful", () => {
		const decision = evaluateAcceptanceContract(contract, {
			changedFiles: ["docs/receipt.md"],
			checkResults: [{ command: "pnpm lint", exitCode: 0 }],
		});

		expect(decision).toBeNull();
	});
});
