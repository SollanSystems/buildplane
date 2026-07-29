import { describe, expect, it } from "vitest";
import {
	deriveGovernedCommandInputCommitmentV1,
	GOVERNED_COMMAND_INPUT_CAS_REFERENCE_PREFIX,
} from "../src/governed-command-input-commitment.js";

describe("governed command input commitment", () => {
	it("derives one exact CAS commitment for the normalized executable command", () => {
		const omittedArgs = deriveGovernedCommandInputCommitmentV1({
			runId: "run-command-commitment",
			actionId: "action-command-commitment",
			command: "git",
		});
		const explicitEmptyArgs = deriveGovernedCommandInputCommitmentV1({
			runId: "run-command-commitment",
			actionId: "action-command-commitment",
			command: "git",
			args: [],
		});

		expect(omittedArgs).toEqual(explicitEmptyArgs);
		expect(omittedArgs.normalizedInput).toEqual({
			runId: "run-command-commitment",
			actionId: "action-command-commitment",
			command: "git",
			args: [],
		});
		expect(omittedArgs.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(omittedArgs.ref).toBe(
			`${GOVERNED_COMMAND_INPUT_CAS_REFERENCE_PREFIX}${omittedArgs.digest.slice("sha256:".length)}`,
		);
	});

	it("rejects null args instead of treating malformed input as an omitted array", () => {
		expect(() =>
			deriveGovernedCommandInputCommitmentV1({
				runId: "run-command-commitment",
				actionId: "action-command-commitment",
				command: "git",
				args: null as never,
			}),
		).toThrow(/args must be a bounded array/i);
	});

	it.each([
		["command", { command: "git status" }],
		["args", { args: ["diff"] }],
		["cwd", { cwd: "other" }],
		["run id", { runId: "other-run" }],
		["action id", { actionId: "other-action" }],
	] as const)(
		"changes the commitment when the %s changes",
		(_label, mutation) => {
			const baseline = deriveGovernedCommandInputCommitmentV1({
				runId: "run-command-commitment",
				actionId: "action-command-commitment",
				command: "git",
				args: ["status"],
				cwd: "src",
			});
			const mutated = deriveGovernedCommandInputCommitmentV1({
				runId: "run-command-commitment",
				actionId: "action-command-commitment",
				command: "git",
				args: ["status"],
				cwd: "src",
				...mutation,
			});

			expect(mutated.digest).not.toBe(baseline.digest);
			expect(mutated.ref).not.toBe(baseline.ref);
		},
	);
});
