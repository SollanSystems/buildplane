import { describe, expect, it } from "vitest";
import type {
	AuthorizationEnvelopeV0,
	EnvelopeProposal,
} from "../src/policy.js";

describe("authorization envelope vocabulary", () => {
	it("AuthorizationEnvelopeV0 carries the bounded-envelope fields", () => {
		const env: AuthorizationEnvelopeV0 = {
			envelope_version: "v0",
			milestone: "M5",
			allowed_side_effects: ["code-edit"],
			path_globs: ["src/**", "test/**"],
			max_iterations: 8,
			token_budget: 4_000_000,
			allowed_verification_cmds: ["pnpm", "cargo", "tsc"],
			expires_at: "2026-07-01T00:00:00Z",
		};
		const proposal: EnvelopeProposal = {
			milestone: "M5",
			sideEffects: ["code-edit"],
			pathGlobs: ["src/**"],
			verificationCommands: ["pnpm vitest run"],
		};
		expect(env.envelope_version).toBe("v0");
		expect(proposal.milestone).toBe(env.milestone);
	});
});
