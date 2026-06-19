import { evaluateArchitectureDiffScope } from "./diff-scope.ts";

/** @type {typeof import('./acceptance.ts').evaluateAcceptanceContract} */
export function evaluateAcceptanceContract(contract, evidence) {
	const reasons = [];

	if (evidence.changedFiles === undefined) {
		reasons.push("acceptance.contract missing required changedFiles evidence.");
	} else {
		const diffScope = evaluateArchitectureDiffScope(evidence.changedFiles, {
			allowedPaths: contract.diff_scope.allowed_globs,
			deniedPaths: contract.diff_scope.denied_globs,
		});
		if (diffScope.status === "blocked") {
			reasons.push(...diffScope.reasons);
		}
	}

	const checkResults = evidence.checkResults ?? [];
	for (const check of contract.checks) {
		const result = checkResults.find(
			(entry) => entry.command === check.command,
		);
		if (!result) {
			reasons.push(
				`acceptance.contract missing required check result for ${check.command}.`,
			);
		} else if (result.exitCode !== 0) {
			reasons.push(
				`acceptance.contract check ${check.command} exited with code ${result.exitCode}.`,
			);
		}
	}

	if (reasons.length === 0) {
		return null;
	}

	return {
		kind: "acceptance.contract",
		outcome: "rejected",
		reasons,
	};
}
