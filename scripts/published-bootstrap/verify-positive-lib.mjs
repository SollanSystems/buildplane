import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSafeStagingParentDirectory } from "./stage-package.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../..");
export const REPO_CLEANUP_TARGETS = Object.freeze([
	".buildplane/project.json",
	".buildplane/state.db",
	".buildplane/artifacts",
	".buildplane/evidence",
	".buildplane/runs",
	".buildplane/logs",
	".buildplane/workspaces",
	"tmp",
]);

export function fail(message) {
	throw new Error(message);
}

function getPathDelimiter(platform = process.platform) {
	return platform === "win32" ? ";" : ":";
}

function normalizeForComparison(pathValue, platform = process.platform) {
	const normalized = resolve(pathValue);
	const canonical = existsSync(normalized)
		? realpathSync.native(normalized)
		: normalized;
	return platform === "win32" ? canonical.toLowerCase() : canonical;
}

function isPathInsideRoot(pathValue, rootPath, platform = process.platform) {
	const normalizedPath = normalizeForComparison(pathValue, platform);
	const normalizedRoot = normalizeForComparison(rootPath, platform);
	if (normalizedPath === normalizedRoot) {
		return true;
	}

	const rootWithSeparator = normalizedRoot.endsWith(sep)
		? normalizedRoot
		: `${normalizedRoot}${sep}`;
	return normalizedPath.startsWith(rootWithSeparator);
}

function splitPathEntries(pathValue = "", platform = process.platform) {
	return pathValue.split(getPathDelimiter(platform)).filter(Boolean);
}

function joinPathEntries(entries, platform = process.platform) {
	return entries.filter(Boolean).join(getPathDelimiter(platform));
}

export function resolveCommandName(commandName, platform = process.platform) {
	return platform === "win32" ? `${commandName}.cmd` : commandName;
}

export function resolveInstalledCommandDirectory(
	npmPrefix,
	platform = process.platform,
) {
	return platform === "win32" ? npmPrefix : join(npmPrefix, "bin");
}

export function resolveInstalledPackageRoot(
	npmPrefix,
	platform = process.platform,
) {
	return platform === "win32"
		? join(npmPrefix, "node_modules", "buildplane")
		: join(npmPrefix, "lib", "node_modules", "buildplane");
}

export function resolveInstalledCliPath(
	npmPrefix,
	platform = process.platform,
) {
	return join(
		resolveInstalledCommandDirectory(npmPrefix, platform),
		resolveCommandName("buildplane", platform),
	);
}

export function resolveInstalledCliEntrypoint(
	npmPrefix,
	platform = process.platform,
) {
	return join(
		resolveInstalledPackageRoot(npmPrefix, platform),
		"dist",
		"index.js",
	);
}

export function uniquePathEntries(entries) {
	const seen = new Set();
	const result = [];

	for (const entry of entries) {
		if (!entry || seen.has(entry)) {
			continue;
		}

		seen.add(entry);
		result.push(entry);
	}

	return result;
}

export function resolveCommandOnPath(
	commandName,
	pathValue = process.env.PATH ?? "",
	platform = process.platform,
) {
	const candidates =
		platform === "win32"
			? /\.[A-Za-z0-9]+$/.test(commandName)
				? [commandName]
				: [
						commandName,
						`${commandName}.cmd`,
						`${commandName}.exe`,
						`${commandName}.bat`,
						`${commandName}.com`,
					]
			: [commandName];

	for (const entry of splitPathEntries(pathValue, platform)) {
		for (const candidate of candidates) {
			const candidatePath = join(entry, candidate);
			if (existsSync(candidatePath)) {
				return candidatePath;
			}
		}
	}

	return undefined;
}

function sanitizeBaseEnvironment(baseEnv = process.env) {
	const env = {};

	for (const [key, value] of Object.entries(baseEnv)) {
		const lowerKey = key.toLowerCase();
		if (
			value === undefined ||
			lowerKey === "path" ||
			lowerKey === "node_path" ||
			lowerKey === "node_options" ||
			lowerKey === "init_cwd" ||
			lowerKey.startsWith("npm_") ||
			lowerKey.startsWith("pnpm_") ||
			lowerKey.startsWith("git_")
		) {
			continue;
		}

		env[key] = value;
	}

	return env;
}

export function createSanitizedEnvironment(
	npmPrefix,
	{
		baseEnv = process.env,
		extra = {},
		platform = process.platform,
		repoRoot = REPO_ROOT,
		requiredCommandNames = ["git"],
		requiredPathEntries = [],
	} = {},
) {
	const installCommandDirectory = resolveInstalledCommandDirectory(
		npmPrefix,
		platform,
	);
	const resolvedRequiredEntries = requiredCommandNames.map((commandName) => {
		const resolvedCommand = resolveCommandOnPath(
			commandName,
			baseEnv.PATH ?? "",
			platform,
		);
		if (!resolvedCommand) {
			fail(
				`Unable to resolve required command on PATH for sanitized environment: ${commandName}`,
			);
		}

		return dirname(resolvedCommand);
	});
	const pathEntries = uniquePathEntries([
		installCommandDirectory,
		...requiredPathEntries,
		...resolvedRequiredEntries,
	]).filter((entry) => !isPathInsideRoot(entry, repoRoot, platform));

	if (!pathEntries.includes(installCommandDirectory)) {
		pathEntries.unshift(installCommandDirectory);
	}

	return {
		...sanitizeBaseEnvironment(baseEnv),
		PATH: joinPathEntries(pathEntries, platform),
		...extra,
	};
}

export function assertPackedInstallPathIsolation({
	env,
	npmPrefix,
	platform = process.platform,
	repoRoot = REPO_ROOT,
}) {
	const installCommandDirectory = resolveInstalledCommandDirectory(
		npmPrefix,
		platform,
	);
	const expectedBuildplanePath = resolveInstalledCliPath(npmPrefix, platform);
	const pathEntries = splitPathEntries(env.PATH ?? "", platform);

	if (!pathEntries.includes(installCommandDirectory)) {
		fail(
			`Packed-install PATH is missing the isolated install directory: ${installCommandDirectory}`,
		);
	}

	const leakedRepoPath = pathEntries.find((entry) =>
		isPathInsideRoot(entry, repoRoot, platform),
	);
	if (leakedRepoPath) {
		fail(`Packed-install PATH leaked repo entry: ${leakedRepoPath}`);
	}

	const resolvedPnpmPath = resolveCommandOnPath("pnpm", env.PATH, platform);
	if (resolvedPnpmPath) {
		fail(`Packed-install PATH must not resolve pnpm: ${resolvedPnpmPath}`);
	}

	const resolvedBuildplanePath = resolveCommandOnPath(
		"buildplane",
		env.PATH,
		platform,
	);
	if (resolvedBuildplanePath !== expectedBuildplanePath) {
		fail(
			`Packed-install PATH must resolve buildplane from the isolated install directory. Expected ${expectedBuildplanePath}, received ${resolvedBuildplanePath ?? "<unresolved>"}`,
		);
	}

	return {
		buildplanePath: resolvedBuildplanePath,
		installCommandDirectory,
		pathEntries,
	};
}

export function parseJson(text, description) {
	const trimmed = text.trim();
	if (!trimmed) {
		fail(`Failed to parse ${description} as JSON\n<empty output>`);
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		fail(`Failed to parse ${description} as JSON\n${trimmed}`);
	}
}

export function listWorkspaceBuildArtifacts(rootPath) {
	const artifacts = [];

	for (const workspaceRoot of [
		join(rootPath, "apps"),
		join(rootPath, "packages"),
	]) {
		if (!existsSync(workspaceRoot)) {
			continue;
		}

		for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) {
				continue;
			}

			const workspacePath = join(workspaceRoot, entry.name);
			const distPath = join(workspacePath, "dist");
			const tsBuildInfoPath = join(workspacePath, "tsconfig.tsbuildinfo");
			if (existsSync(distPath)) {
				artifacts.push(distPath);
			}
			if (existsSync(tsBuildInfoPath)) {
				artifacts.push(tsBuildInfoPath);
			}
		}
	}

	return artifacts.map((path) => resolve(path)).sort();
}

export function createWorkspaceBuildArtifactGuard(rootPath) {
	const backupRoot = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			"buildplane-published-bootstrap-build-artifacts-",
		),
	);
	const initialArtifacts = listWorkspaceBuildArtifacts(rootPath);
	const backupEntries = initialArtifacts.map((artifactPath) => {
		const relativePath = artifactPath.slice(
			`${resolve(rootPath)}${sep}`.length,
		);
		const backupPath = join(backupRoot, relativePath);
		mkdirSync(dirname(backupPath), { recursive: true });
		cpSync(artifactPath, backupPath, { recursive: true });
		return { artifactPath, backupPath };
	});
	let restored = false;

	return {
		restore() {
			if (restored) {
				return;
			}

			for (const artifactPath of listWorkspaceBuildArtifacts(rootPath)) {
				rmSync(artifactPath, { force: true, recursive: true });
			}

			for (const { artifactPath, backupPath } of backupEntries) {
				mkdirSync(dirname(artifactPath), { recursive: true });
				cpSync(backupPath, artifactPath, { recursive: true });
			}

			rmSync(backupRoot, { force: true, recursive: true });
			restored = true;
		},
	};
}

export function createRepoStateGuard(
	rootPath,
	cleanupTargets = REPO_CLEANUP_TARGETS,
) {
	const backupRoot = mkdtempSync(
		join(
			resolveSafeStagingParentDirectory(),
			"buildplane-published-bootstrap-repo-state-",
		),
	);
	const preservedPaths = [];
	let restored = false;

	for (const relativePath of cleanupTargets) {
		const sourcePath = join(rootPath, relativePath);
		if (!existsSync(sourcePath)) {
			continue;
		}

		const backupPath = join(backupRoot, relativePath);
		mkdirSync(dirname(backupPath), { recursive: true });
		cpSync(sourcePath, backupPath, { recursive: true });
		preservedPaths.push({ backupPath, sourcePath });
	}

	const reset = () => {
		for (const relativePath of cleanupTargets) {
			rmSync(join(rootPath, relativePath), {
				force: true,
				recursive: true,
			});
		}
	};

	const restore = () => {
		if (restored) {
			return;
		}

		reset();
		for (const { backupPath, sourcePath } of preservedPaths.reverse()) {
			mkdirSync(dirname(sourcePath), { recursive: true });
			cpSync(backupPath, sourcePath, { recursive: true });
		}

		rmSync(backupRoot, { force: true, recursive: true });
		restored = true;
	};

	return {
		backupRoot,
		reset,
		restore,
	};
}
