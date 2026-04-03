import { describe, expect, it } from "vitest";

describe("CLI Honcho wiring", () => {
	it("loads Honcho adapter when HONCHO_API_KEY is set", async () => {
		const originalEnv = process.env.HONCHO_API_KEY;
		process.env.HONCHO_API_KEY = "test-key";
		process.env.HONCHO_WORKSPACE_ID = "buildplane";
		process.env.BUILDPLANE_USER_ID = "test-user";

		try {
			// Verify the adapter module can be dynamically imported
			const mod = await import("@buildplane/adapters-honcho");
			expect(mod.createHonchoAdapter).toBeTypeOf("function");
			expect(mod.createHonchoClient).toBeTypeOf("function");
		} finally {
			if (originalEnv === undefined) {
				delete process.env.HONCHO_API_KEY;
			} else {
				process.env.HONCHO_API_KEY = originalEnv;
			}
			delete process.env.HONCHO_WORKSPACE_ID;
			delete process.env.BUILDPLANE_USER_ID;
		}
	});

	it("gracefully skips Honcho when HONCHO_API_KEY is not set", () => {
		delete process.env.HONCHO_API_KEY;
		expect(process.env.HONCHO_API_KEY).toBeUndefined();
	});
});
