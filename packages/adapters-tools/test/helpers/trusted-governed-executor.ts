import type { GovernedActionExecutor } from "../../src/action-gateway.js";
import { registerTrustedGovernedActionExecutor } from "../../src/governed-executor-provenance.js";

/**
 * Test-only factory for unit tests that isolate ActionGateway orchestration
 * from Podman argv construction. It intentionally imports an internal source
 * module rather than becoming part of the published adapters-tools API.
 */
export function createTrustedTestGovernedActionExecutor(
	overrides: Partial<GovernedActionExecutor> = {},
): GovernedActionExecutor {
	const executor = Object.freeze({
		sandbox: Object.freeze({
			schemaVersion: 1 as const,
			runtime: "rootless-oci" as const,
			rootless: true as const,
			readOnlyBase: true as const,
			writableOverlay: true as const,
			network: "none" as const,
			hostFallback: false as const,
			profileDigest: `sha256:${"a".repeat(64)}`,
			...(overrides.sandbox ?? {}),
		}),
		runCommand:
			overrides.runCommand ??
			(() => ({
				success: true,
				exitCode: 0,
				stdout: "sandboxed",
				stderr: "",
			})),
		writeFile:
			overrides.writeFile ?? (() => ({ success: true, path: "output.txt" })),
	});
	return registerTrustedGovernedActionExecutor(executor);
}
