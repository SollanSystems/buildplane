import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

describe("@buildplane/planforge", () => {
	it("exports compile", () => {
		expect(typeof compile).toBe("function");
	});
});
