import { describe, expect, it } from "vitest";
import { parsePlanForgeBrokerAdmitArguments } from "../src/run-cli.js";

describe("planforge admit argument parsing", () => {
	it("accepts --input, --approve and --json", () => {
		const parsed = parsePlanForgeBrokerAdmitArguments([
			"--input",
			"goal.md",
			"--approve",
			"--json",
		]);
		expect(parsed).toEqual({ inputPath: "goal.md", json: true });
	});

	it("still requires explicit --approve", () => {
		expect(() =>
			parsePlanForgeBrokerAdmitArguments(["--input", "goal.md"]),
		).toThrow(/requires explicit --approve/i);
	});

	it("still rejects --operator", () => {
		expect(() =>
			parsePlanForgeBrokerAdmitArguments([
				"--input",
				"goal.md",
				"--approve",
				"--operator",
				"op-1",
			]),
		).toThrow(/Unsupported PlanForge governed admit argument/i);
	});
});
