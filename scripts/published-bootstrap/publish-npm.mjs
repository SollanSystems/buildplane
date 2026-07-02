/**
 * Publish the vendored, self-contained staged artifact to npm.
 *
 * `changeset publish` (which runs `npm publish` inside apps/cli) would ship
 * apps/cli/package.json AS-IS — with `workspace:*` dependencies on internal
 * @buildplane/* packages that are never published, so the tarball would be
 * uninstallable (O6). Instead we publish the staged package produced by
 * stage-package.mjs: its derived manifest carries no workspace:* / internal
 * specifiers and its runtime closure is vendored under `vendor/`.
 *
 * Versioning stays owned by changesets — the version bump has already landed in
 * apps/cli/package.json (and therefore in the derived manifest) before this runs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePublishedPackage } from "./stage-package.mjs";

const __filename = fileURLToPath(import.meta.url);

function resolveNpmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * Stage the vendored artifact and `npm publish` it. Prints the changesets/action
 * `New tag:` line so the action creates the git tag + GitHub release for the
 * published version, then cleans up the staging directory.
 *
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ name: string, version: string }}
 */
export function publishStagedPackage({ dryRun = false } = {}) {
	const staged = stagePublishedPackage();
	try {
		const manifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		);

		const args = ["publish", staged.packageRoot, "--access", "public"];
		if (dryRun) {
			args.push("--dry-run");
		}
		execFileSync(resolveNpmCommand(), args, { stdio: "inherit" });

		// changesets/action@v1 greps the publish command's stdout for this exact
		// line to create the git tag + GitHub release for the released package.
		process.stdout.write(`New tag: ${manifest.name}@${manifest.version}\n`);

		return { name: manifest.name, version: manifest.version };
	} finally {
		rmSync(staged.stagingRoot, { force: true, recursive: true });
	}
}

function isExecutedDirectly() {
	return resolve(process.argv[1] ?? "") === __filename;
}

if (isExecutedDirectly()) {
	try {
		publishStagedPackage({ dryRun: process.argv.includes("--dry-run") });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
