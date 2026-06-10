import { describe, expect, it } from "vitest";
import { validateCapabilityBundle } from "../src/index.ts";

describe("capability-broker smoke", () => {
	it("exports validateCapabilityBundle", () => {
		expect(typeof validateCapabilityBundle).toBe("function");
	});
});
