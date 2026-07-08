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
 * True when `name@version` already exists on the registry. `npm view` exits 0
 * and prints the version when it exists; it exits non-zero (E404) for an
 * absent version or package, which must read as "not published" so a fresh
 * publish proceeds (npm itself still fails loud on a real conflict).
 *
 * @param {string} name
 * @param {string} version
 * @returns {boolean}
 */
export function isVersionPublished(name, version) {
	try {
		const output = execFileSync(
			resolveNpmCommand(),
			["view", `${name}@${version}`, "version"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		return output.toString().trim() === version;
	} catch {
		return false;
	}
}

/**
 * Create the release tag locally unless it already exists. changesets/action
 * reacts to the `New tag:` line by running `git push origin <tag>`, which
 * needs the local ref — printing the line without creating the tag is exactly
 * how the 0.14.0 publish run failed after a successful npm publish.
 *
 * @param {string} tag
 */
function ensureReleaseTag(tag) {
	const existing = execFileSync("git", ["tag", "--list", tag], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (existing.toString().trim() === tag) {
		return;
	}
	execFileSync("git", ["tag", tag], { stdio: "inherit" });
}

/**
 * Stage the vendored artifact and `npm publish` it. Creates the release git
 * tag and prints the changesets/action `New tag:` line so the action pushes
 * the tag + creates the GitHub release, then cleans up the staging directory.
 * When the staged version is already on the registry (any post-release push
 * to main with no pending changesets re-runs this command), it skips without
 * publishing or announcing a tag so the run stays green.
 *
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ name: string, version: string, skipped: boolean }}
 */
export function publishStagedPackage({ dryRun = false } = {}) {
	const staged = stagePublishedPackage();
	try {
		const manifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		);

		if (!dryRun && isVersionPublished(manifest.name, manifest.version)) {
			process.stdout.write(
				`${manifest.name}@${manifest.version} is already published — skipping.\n`,
			);
			return { name: manifest.name, version: manifest.version, skipped: true };
		}

		const args = ["publish", staged.packageRoot, "--access", "public"];
		if (dryRun) {
			args.push("--dry-run");
		}
		execFileSync(resolveNpmCommand(), args, { stdio: "inherit" });

		if (!dryRun) {
			ensureReleaseTag(`${manifest.name}@${manifest.version}`);
		}

		// changesets/action@v1 greps the publish command's stdout for this exact
		// line to create the git tag + GitHub release for the released package.
		process.stdout.write(`New tag: ${manifest.name}@${manifest.version}\n`);

		return { name: manifest.name, version: manifest.version, skipped: false };
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
