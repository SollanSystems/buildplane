import { describe, expect, it } from "vitest";
import * as tools from "../src/index.js";

describe("adapters-tools public surface", () => {
	it("does not publish a production governed OCI executor factory", () => {
		expect("createPodmanGovernedActionExecutor" in tools).toBe(false);
	});

	it("does not publish test runners or executor-provenance registration", () => {
		expect("createPodmanGovernedActionExecutorForTest" in tools).toBe(false);
		expect("registerTrustedGovernedActionExecutor" in tools).toBe(false);
	});

	it("does not publish generic action-family handler registration", () => {
		const registrationHooks = Object.keys(tools).filter((name) =>
			/^(?:register|add).*(?:action|handler|family)|(?:action|handler|family).*(?:registry|registration)$/i.test(
				name,
			),
		);

		expect(registrationHooks).toEqual([]);
	});
});
