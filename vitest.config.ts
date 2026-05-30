import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const pkg = (relative: string) => resolve(repoRoot, relative);

const workspaceAliases = {
	"@buildplane/adapters-codex": pkg("packages/adapters-codex/src/index.ts"),
	"@buildplane/adapters-git": pkg("packages/adapters-git/src/index.ts"),
	"@buildplane/adapters-honcho": pkg("packages/adapters-honcho/src/index.ts"),
	"@buildplane/adapters-models": pkg("packages/adapters-models/src/index.ts"),
	"@buildplane/adapters-tools": pkg("packages/adapters-tools/src/index.ts"),
	"@buildplane/kernel": pkg("packages/kernel/src/index.ts"),
	"@buildplane/ledger-client": pkg("packages/ledger-client/src/index.ts"),
	"@buildplane/planforge": pkg("packages/planforge/src/index.ts"),
	"@buildplane/policy": pkg("packages/policy/src/index.ts"),
	"@buildplane/runtime": pkg("packages/runtime/src/index.ts"),
	"@buildplane/storage": pkg("packages/storage/src/index.ts"),
	"@buildplane/ui-tui": pkg("packages/ui-tui/src/index.ts"),
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
		testTimeout: 15_000,
		hookTimeout: 60_000,
	},
});
