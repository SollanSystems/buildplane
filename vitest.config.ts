import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const workspaceAliases = {
	"@buildplane/adapters-codex": resolve("packages/adapters-codex/src/index.ts"),
	"@buildplane/adapters-git": resolve("packages/adapters-git/src/index.ts"),
	"@buildplane/adapters-honcho": resolve(
		"packages/adapters-honcho/src/index.ts",
	),
	"@buildplane/adapters-models": resolve(
		"packages/adapters-models/src/index.ts",
	),
	"@buildplane/adapters-tools": resolve("packages/adapters-tools/src/index.ts"),
	"@buildplane/kernel": resolve("packages/kernel/src/index.ts"),
	"@buildplane/ledger-client": resolve("packages/ledger-client/src/index.ts"),
	"@buildplane/policy": resolve("packages/policy/src/index.ts"),
	"@buildplane/runtime": resolve("packages/runtime/src/index.ts"),
	"@buildplane/storage": resolve("packages/storage/src/index.ts"),
	"@buildplane/ui-tui": resolve("packages/ui-tui/src/index.ts"),
};

export default defineConfig({
	resolve: {
		alias: workspaceAliases,
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
