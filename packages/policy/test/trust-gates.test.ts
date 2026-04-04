import type { PolicyProfile } from "@buildplane/kernel";
import { describe, expect, it } from "vitest";
import { evaluateTrustGate } from "../src/trust-gates";

const restrictedProfile: PolicyProfile = {
	name: "restricted",
	trustGates: {
		restrictedTools: ["run_command", "dangerous_tool"],
	},
};

const allowlistProfile: PolicyProfile = {
	name: "allowlist",
	trustGates: {
		allowedTools: ["write_file"],
	},
};

const bothProfile: PolicyProfile = {
	name: "both",
	trustGates: {
		allowedTools: ["write_file", "run_command"],
		restrictedTools: ["run_command"],
	},
};

describe("trust gate evaluation", () => {
	it("returns null when no profile is provided", () => {
		expect(evaluateTrustGate("write_file")).toBeNull();
	});

	it("returns null when profile has no trust gates", () => {
		const profile: PolicyProfile = { name: "empty" };
		expect(evaluateTrustGate("write_file", profile)).toBeNull();
	});

	it("returns null for an unrestricted tool", () => {
		expect(evaluateTrustGate("write_file", restrictedProfile)).toBeNull();
	});

	it("rejects a restricted tool", () => {
		const result = evaluateTrustGate("run_command", restrictedProfile);
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("reject-run");
		expect(result?.reasons[0]).toContain('"run_command" is restricted');
	});

	it("allows a tool on the allowlist", () => {
		expect(evaluateTrustGate("write_file", allowlistProfile)).toBeNull();
	});

	it("rejects a tool not on the allowlist", () => {
		const result = evaluateTrustGate("run_command", allowlistProfile);
		expect(result).not.toBeNull();
		expect(result?.reasons[0]).toContain("not in the allowed tools list");
	});

	it("restrictedTools takes precedence over allowedTools", () => {
		const result = evaluateTrustGate("run_command", bothProfile);
		expect(result).not.toBeNull();
		expect(result?.reasons[0]).toContain("restricted");
	});

	it("allows a tool that passes both checks", () => {
		expect(evaluateTrustGate("write_file", bothProfile)).toBeNull();
	});
});
