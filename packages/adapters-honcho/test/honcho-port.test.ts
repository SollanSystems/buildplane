import { describe, expect, it } from "vitest";
import type { HonchoPort } from "../src/honcho-port.js";

describe("HonchoPort type contract", () => {
	it("satisfies the port interface shape", () => {
		// Type-level test: a conforming object compiles without error
		const mock: HonchoPort = {
			createSubscriber: () => () => {},
			fetchContext: async () => ({ memories: [] }),
		};
		expect(mock.createSubscriber).toBeTypeOf("function");
		expect(mock.fetchContext).toBeTypeOf("function");
	});
});
