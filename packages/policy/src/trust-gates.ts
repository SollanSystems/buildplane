import type { PolicyDecision, PolicyProfile } from "@buildplane/kernel";

/**
 * Evaluate whether a tool call is allowed by trust gate rules.
 *
 * Returns a reject decision if the tool is restricted, null if allowed.
 * Returns null if no trust gate config exists on the profile.
 */
export function evaluateTrustGate(
	toolName: string,
	profile?: PolicyProfile,
): PolicyDecision | null {
	const gates = profile?.trustGates;
	if (!gates) {
		return null;
	}

	// Explicit blocklist
	if (gates.restrictedTools?.includes(toolName)) {
		return {
			kind: "reject-run",
			outcome: "rejected",
			reasons: [
				`tool "${toolName}" is restricted by policy profile "${profile.name}"`,
			],
		};
	}

	// Allowlist: if set, only listed tools are permitted
	if (gates.allowedTools && !gates.allowedTools.includes(toolName)) {
		return {
			kind: "reject-run",
			outcome: "rejected",
			reasons: [
				`tool "${toolName}" is not in the allowed tools list for policy profile "${profile.name}"`,
			],
		};
	}

	return null;
}
