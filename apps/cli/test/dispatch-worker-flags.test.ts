import { describe, expect, it } from "vitest";
import { parseDispatchWorkerFlags } from "../src/run-cli.js";

describe("parseDispatchWorkerFlags — standalone `planforge dispatch` worker contract (R7 parity)", () => {
	it("defaults to the loop's spike-proven tool grant and no overrides", () => {
		const flags = parseDispatchWorkerFlags(["--input", "goal.md", "--json"]);
		expect(flags.model).toBeUndefined();
		expect(flags.claudeMaxTurns).toBeUndefined();
		expect(flags.claudeTimeoutMs).toBeUndefined();
		expect(flags.claudeAllowedTools).toEqual([
			"Edit",
			"Write",
			"Read",
			"Glob",
			"Grep",
			"Bash",
		]);
	});

	it("parses --model, --max-turns, and --worker-timeout-ms", () => {
		const flags = parseDispatchWorkerFlags([
			"--input",
			"goal.md",
			"--model",
			"claude-sonnet-5",
			"--max-turns",
			"20",
			"--worker-timeout-ms",
			"900000",
		]);
		expect(flags.model).toBe("claude-sonnet-5");
		expect(flags.claudeMaxTurns).toBe(20);
		expect(flags.claudeTimeoutMs).toBe(900000);
	});

	it("parses --worker-allowed-tools as a comma list", () => {
		const flags = parseDispatchWorkerFlags([
			"--worker-allowed-tools",
			"Read, Grep",
		]);
		expect(flags.claudeAllowedTools).toEqual(["Read", "Grep"]);
	});

	it("floors --worker-timeout-ms at the R7 minimum so a tiny value cannot insta-kill the worker", () => {
		const flags = parseDispatchWorkerFlags(["--worker-timeout-ms", "5"]);
		expect(flags.claudeTimeoutMs).toBe(60_000);
	});
});
