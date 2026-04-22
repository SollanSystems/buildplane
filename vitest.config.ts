import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"apps/**/test/**/*.test.ts",
			"packages/**/test/**/*.test.ts",
			"test/**/*.test.ts",
		],
		passWithNoTests: true,
		testTimeout: 15_000,
		hookTimeout: 60_000,
	},
});
