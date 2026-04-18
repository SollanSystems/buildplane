import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@buildplane/ledger-client": resolve(
				"packages/ledger-client/src/index.ts",
			),
			"@buildplane/adapters-tools": resolve(
				"packages/adapters-tools/src/index.ts",
			),
		},
	},
	test: {
		include: [
			"apps/**/test/**/*.test.ts",
			"packages/**/test/**/*.test.ts",
			"test/**/*.test.ts",
		],
		passWithNoTests: true,
	},
});
