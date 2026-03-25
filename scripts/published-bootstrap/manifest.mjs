/**
 * Derive a publish-safe manifest from the repo-private apps/cli/package.json.
 *
 * This helper reads the source of truth by default and returns a new object.
 * Tests may pass an explicit manifest override to exercise publish-safety rules.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PKG_PATH = join(__dirname, "../../apps/cli/package.json");

/** Fields to keep verbatim from the source manifest. */
const KEEP_FIELDS = [
	"name",
	"version",
	"description",
	"type",
	"bin",
	"engines",
];

/** Files included in the published package. */
const PUBLISHED_FILES = ["dist", "vendor", "README.md"];
const UNSAFE_DEPENDENCY_PREFIXES = ["workspace:", "file:", "link:"];
const LOCAL_FILESYSTEM_PREFIXES = ["../", "./", "..\\", ".\\"];

function readSourceManifest() {
	return JSON.parse(readFileSync(CLI_PKG_PATH, "utf8"));
}

function isWindowsAbsolutePath(specifier) {
	return /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith("\\\\");
}

function isWindowsDrivePath(specifier) {
	return /^[A-Za-z]:/.test(specifier);
}

function isLocalFilesystemPath(specifier) {
	return (
		specifier === "." ||
		specifier === ".." ||
		LOCAL_FILESYSTEM_PREFIXES.some((prefix) => specifier.startsWith(prefix)) ||
		specifier.startsWith("\\")
	);
}

function isPublishUnsafeDependencySpecifier(specifier) {
	return (
		UNSAFE_DEPENDENCY_PREFIXES.some((prefix) => specifier.startsWith(prefix)) ||
		isAbsolute(specifier) ||
		isWindowsAbsolutePath(specifier) ||
		isWindowsDrivePath(specifier) ||
		isLocalFilesystemPath(specifier)
	);
}

function assertPublishSafeExternalDependency(name, specifier) {
	if (
		typeof specifier !== "string" ||
		isPublishUnsafeDependencySpecifier(specifier)
	) {
		throw new Error(
			`Cannot publish external dependency "${name}" with publish-unsafe specifier "${String(specifier)}"`,
		);
	}
}

/**
 * Read apps/cli/package.json and derive a publish-safe manifest object.
 *
 * Behavior:
 * - Keeps name, version, description, type, bin, and engines
 * - Omits `private`
 * - Omits workspace-only scripts
 * - Omits internal @buildplane/* runtime dependencies
 * - Rejects publish-unsafe external dependency specifiers
 * - Emits `files` covering only dist, vendor, and README.md
 * - Emits no preinstall, install, or postinstall hooks
 *
 * @param {Record<string, unknown>} [sourceManifest]
 * @returns {Record<string, unknown>} A plain object suitable for JSON.stringify
 */
export function derivePublishManifest(sourceManifest = readSourceManifest()) {
	const manifest = {};

	// Copy only the allowed fields
	for (const field of KEEP_FIELDS) {
		if (sourceManifest[field] !== undefined) {
			// Deep-copy objects to avoid shared references
			manifest[field] =
				typeof sourceManifest[field] === "object" &&
				sourceManifest[field] !== null
					? JSON.parse(JSON.stringify(sourceManifest[field]))
					: sourceManifest[field];
		}
	}

	// Emit the files whitelist
	manifest.files = [...PUBLISHED_FILES];

	// Filter dependencies: keep only publish-safe non-@buildplane/* entries
	if (sourceManifest.dependencies) {
		const filtered = {};
		let hasExternal = false;
		for (const [name, specifier] of Object.entries(
			sourceManifest.dependencies,
		)) {
			if (name.startsWith("@buildplane/")) {
				continue;
			}

			assertPublishSafeExternalDependency(name, specifier);
			filtered[name] = specifier;
			hasExternal = true;
		}
		if (hasExternal) {
			manifest.dependencies = filtered;
		}
	}

	// Filter optionalDependencies: keep only publish-safe non-@buildplane/* entries
	if (sourceManifest.optionalDependencies) {
		const filtered = {};
		let hasExternal = false;
		for (const [name, specifier] of Object.entries(
			sourceManifest.optionalDependencies,
		)) {
			if (name.startsWith("@buildplane/")) {
				continue;
			}

			assertPublishSafeExternalDependency(name, specifier);
			filtered[name] = specifier;
			hasExternal = true;
		}
		if (hasExternal) {
			manifest.optionalDependencies = filtered;
		}
	}

	// Explicitly do NOT carry over:
	// - private (the published package must not be private)
	// - scripts (all current scripts are workspace-only: build, test)
	// - devDependencies (not relevant for published package)

	return manifest;
}
