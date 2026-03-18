import { describe, expect, it } from "vitest";
import { getBootstrapBanner } from "../src/index";

describe("cli bootstrap", () => {
	it("returns the buildplane bootstrap banner", () => {
		expect(getBootstrapBanner()).toContain("Buildplane");
	});
});
