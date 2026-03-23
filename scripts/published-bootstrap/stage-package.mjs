import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { derivePublishManifest } from "./manifest.mjs";
import { derivePublishedReadme } from "./readme.mjs";
import {
	assertRuntimeImportClosure,
	collectRuntimeFiles,
	isPathWithinRootBoundary,
} from "./runtime-closure.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "../..");
const CLI_DIST_ROOT = join(REPO_ROOT, "apps/cli/dist");
const STAGING_PREFIX = "buildplane-published-";
const STAGED_RUNTIME_ENTRY_BASENAME = "cli.js";
const SOURCE_RUNTIME_ENTRY_BASENAME = "cli-main.js";
const STAGED_RUNTIME_ENTRY_SPECIFIER = `./${STAGED_RUNTIME_ENTRY_BASENAME}`;
const SOURCE_RUNTIME_ENTRY_SPECIFIER = `./${SOURCE_RUNTIME_ENTRY_BASENAME}`;
const FALLBACK_STAGING_PARENT_PATHS = Object.freeze(
	process.platform === "win32"
		? [
				process.env.LOCALAPPDATA
					? join(process.env.LOCALAPPDATA, "Temp")
					: undefined,
				process.env.SystemRoot
					? join(process.env.SystemRoot, "Temp")
					: undefined,
			].filter(Boolean)
		: ["/private/tmp", "/tmp", "/var/tmp"],
);

function readTrimmedFile(path) {
	return readFileSync(path, "utf8").trim();
}

function resolveGitDirectory(checkoutRoot) {
	const gitPath = join(checkoutRoot, ".git");
	if (!existsSync(gitPath)) {
		return undefined;
	}

	const gitStats = statSync(gitPath);
	if (gitStats.isDirectory()) {
		return gitPath;
	}

	if (!gitStats.isFile()) {
		return undefined;
	}

	const gitPointerMatch = readTrimmedFile(gitPath).match(/^gitdir:\s*(.+)$/i);
	if (!gitPointerMatch) {
		return undefined;
	}

	return resolve(checkoutRoot, gitPointerMatch[1]);
}

function resolveRepositoryProtectionRoots(checkoutRoot) {
	const roots = new Set([resolve(checkoutRoot)]);
	const gitDirectory = resolveGitDirectory(checkoutRoot);
	if (!gitDirectory) {
		return [...roots];
	}

	const commonDirPath = join(gitDirectory, "commondir");
	const commonGitDirectory =
		existsSync(commonDirPath) && statSync(commonDirPath).isFile()
			? resolve(gitDirectory, readTrimmedFile(commonDirPath))
			: gitDirectory;
	roots.add(dirname(commonGitDirectory));
	return [...roots];
}

const PROTECTED_STAGING_ROOTS = Object.freeze(
	resolveRepositoryProtectionRoots(REPO_ROOT),
);

function isPathWithinProtectedStagingRoots(path) {
	return PROTECTED_STAGING_ROOTS.some((rootPath) =>
		isPathWithinRootBoundary(rootPath, path),
	);
}

function ensureDirectory(path) {
	mkdirSync(path, { recursive: true });
	return path;
}

function isSaneDirectoryPath(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		path !== "undefined" &&
		existsSync(path)
	);
}

export function resolveSafeStagingParentDirectory() {
	const rawTmpdir = tmpdir();
	const preferredParents = [
		...(isSaneDirectoryPath(rawTmpdir) ? [rawTmpdir] : []),
		...FALLBACK_STAGING_PARENT_PATHS,
	]
		.filter(Boolean)
		.map((path) => resolve(path));

	for (const candidatePath of preferredParents) {
		if (isPathWithinProtectedStagingRoots(candidatePath)) {
			continue;
		}

		try {
			return ensureDirectory(candidatePath);
		} catch {}
	}

	let fallbackPath = isSaneDirectoryPath(rawTmpdir)
		? resolve(rawTmpdir)
		: resolve(process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp");
	while (isPathWithinProtectedStagingRoots(fallbackPath)) {
		const parentPath = dirname(fallbackPath);
		if (parentPath === fallbackPath) {
			break;
		}

		fallbackPath = parentPath;
	}

	if (isPathWithinProtectedStagingRoots(fallbackPath)) {
		throw new Error(
			`Could not find a staging temp root outside the repo/worktree: ${REPO_ROOT}`,
		);
	}

	return ensureDirectory(fallbackPath);
}

export const INTERNAL_PACKAGE_ENTRYPOINTS = Object.freeze({
	"@buildplane/kernel": "vendor/@buildplane/kernel/index.js",
	"@buildplane/runtime": "vendor/@buildplane/runtime/index.js",
	"@buildplane/policy": "vendor/@buildplane/policy/index.js",
	"@buildplane/storage": "vendor/@buildplane/storage/index.js",
	"@buildplane/adapters-git": "vendor/@buildplane/adapters-git/index.js",
});

/**
 * Internal packages that are valid imports but not vendored into the
 * published bootstrap.  They are resolved at install-time as optional
 * peer dependencies instead of being bundled into the closure.
 */
export const OPTIONAL_INTERNAL_PACKAGES = Object.freeze([
	"@buildplane/ui-tui",
	"@buildplane/adapters-models",
]);

function listInternalPackageNames() {
	return Object.keys(INTERNAL_PACKAGE_ENTRYPOINTS);
}

function toRepoPackageDistRoot(packageName) {
	return join(
		REPO_ROOT,
		"packages",
		packageName.replace("@buildplane/", ""),
		"dist",
	);
}

function ensureDirectoryExists(path, description) {
	if (!existsSync(path) || !statSync(path).isDirectory()) {
		throw new Error(`Missing required ${description}: ${path}`);
	}
}

function toRepoRuntimeEntrypoint(packageName) {
	return join(toRepoPackageDistRoot(packageName), "index.js");
}

function collectRequiredRuntimeClosureFiles() {
	ensureDirectoryExists(CLI_DIST_ROOT, "CLI build output directory");

	return assertRuntimeImportClosure([join(CLI_DIST_ROOT, "index.js")], {
		onError(message) {
			throw new Error(message);
		},
		resolveInternalImport(specifier) {
			if (!(specifier in INTERNAL_PACKAGE_ENTRYPOINTS)) {
				return undefined;
			}

			return toRepoRuntimeEntrypoint(specifier);
		},
		optionalInternalPackages: OPTIONAL_INTERNAL_PACKAGES,
		rootBoundaryPaths: [
			CLI_DIST_ROOT,
			...listInternalPackageNames().map(toRepoPackageDistRoot),
		],
	});
}

function toStagedRuntimePath(sourcePath, packageRoot) {
	if (isPathWithinRootBoundary(CLI_DIST_ROOT, sourcePath)) {
		return join(packageRoot, "dist", relative(CLI_DIST_ROOT, sourcePath));
	}

	for (const packageName of listInternalPackageNames()) {
		const sourceRoot = toRepoPackageDistRoot(packageName);
		if (!isPathWithinRootBoundary(sourceRoot, sourcePath)) {
			continue;
		}

		return join(
			packageRoot,
			dirname(INTERNAL_PACKAGE_ENTRYPOINTS[packageName]),
			relative(sourceRoot, sourcePath),
		);
	}

	throw new Error(
		`Cannot stage runtime file outside the published closure roots: ${sourcePath}`,
	);
}

function copyRuntimeClosureFiles(sourceFilePaths, packageRoot) {
	for (const sourcePath of sourceFilePaths) {
		const destinationPath = toStagedRuntimePath(sourcePath, packageRoot);
		mkdirSync(dirname(destinationPath), { recursive: true });
		cpSync(sourcePath, destinationPath);
	}
}

function toRuntimeModuleSpecifier(fromFilePath, packageRoot, packageName) {
	const stagedTarget = INTERNAL_PACKAGE_ENTRYPOINTS[packageName];
	if (!stagedTarget) {
		return packageName;
	}

	const relativeSpecifier = relative(
		dirname(fromFilePath),
		join(packageRoot, stagedTarget),
	)
		.split(sep)
		.join("/");

	return relativeSpecifier.startsWith(".")
		? relativeSpecifier
		: `./${relativeSpecifier}`;
}

function collectInternalRuntimeImportEdits(source, filePath, packageRoot) {
	const sourceFile = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.JS,
	);
	const edits = [];
	const queueRewrite = (moduleSpecifier) => {
		if (!ts.isStringLiteralLike(moduleSpecifier)) {
			return;
		}

		const specifier = moduleSpecifier.text;
		if (!(specifier in INTERNAL_PACKAGE_ENTRYPOINTS)) {
			return;
		}

		edits.push({
			end: moduleSpecifier.getEnd() - 1,
			replacement: toRuntimeModuleSpecifier(filePath, packageRoot, specifier),
			start: moduleSpecifier.getStart(sourceFile) + 1,
		});
	};

	const visit = (node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier) {
				queueRewrite(node.moduleSpecifier);
			}
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length >= 1
		) {
			queueRewrite(node.arguments[0]);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return edits.sort((left, right) => right.start - left.start);
}

function rewriteInternalRuntimeImports(filePath, packageRoot) {
	const original = readFileSync(filePath, "utf8");
	const edits = collectInternalRuntimeImportEdits(
		original,
		filePath,
		packageRoot,
	);
	if (edits.length === 0) {
		return;
	}

	let rewritten = original;
	for (const { start, end, replacement } of edits) {
		rewritten = `${rewritten.slice(0, start)}${replacement}${rewritten.slice(end)}`;
	}

	if (rewritten !== original) {
		writeFileSync(filePath, rewritten);
	}
}

function stripSourceMappingUrlComments(filePath) {
	const original = readFileSync(filePath, "utf8");
	const rewritten = original.replaceAll(
		/^[ \t]*\/\/# sourceMappingURL=.*\.map[ \t]*(?:\r?\n|$)/gm,
		"",
	);
	if (rewritten !== original) {
		writeFileSync(filePath, rewritten);
	}
}

function rewriteStagedRuntimeImports(packageRoot) {
	for (const subtree of [
		join(packageRoot, "dist"),
		join(packageRoot, "vendor"),
	]) {
		for (const filePath of collectRuntimeFiles(subtree)) {
			rewriteInternalRuntimeImports(filePath, packageRoot);
		}
	}
}

function stripStagedRuntimeSourceMapComments(packageRoot) {
	for (const subtree of [
		join(packageRoot, "dist"),
		join(packageRoot, "vendor"),
	]) {
		for (const filePath of collectRuntimeFiles(subtree)) {
			stripSourceMappingUrlComments(filePath);
		}
	}
}

function rewriteStagedBootstrapWrapper(packageRoot) {
	const stagedSourceRuntimePath = join(
		packageRoot,
		"dist",
		SOURCE_RUNTIME_ENTRY_BASENAME,
	);
	const stagedRuntimePath = join(
		packageRoot,
		"dist",
		STAGED_RUNTIME_ENTRY_BASENAME,
	);
	if (existsSync(stagedSourceRuntimePath)) {
		renameSync(stagedSourceRuntimePath, stagedRuntimePath);
	}

	const stagedIndexPath = join(packageRoot, "dist", "index.js");
	const stagedIndexSource = readFileSync(stagedIndexPath, "utf8");
	if (
		!stagedIndexSource.includes(STAGED_RUNTIME_ENTRY_SPECIFIER) &&
		!stagedIndexSource.includes(SOURCE_RUNTIME_ENTRY_SPECIFIER)
	) {
		throw new Error(
			`Expected staged dist/index.js to reference ${JSON.stringify(SOURCE_RUNTIME_ENTRY_SPECIFIER)} or ${JSON.stringify(STAGED_RUNTIME_ENTRY_SPECIFIER)}: ${stagedIndexPath}`,
		);
	}

	const rewrittenIndexSource = stagedIndexSource.replaceAll(
		SOURCE_RUNTIME_ENTRY_SPECIFIER,
		STAGED_RUNTIME_ENTRY_SPECIFIER,
	);
	if (rewrittenIndexSource !== stagedIndexSource) {
		writeFileSync(stagedIndexPath, rewrittenIndexSource);
	}
}

function collectPublishedRuntimeDependencyNames(manifest) {
	return Object.keys(manifest.dependencies ?? {});
}

function assertStagedRuntimeClosure(packageRoot, manifest) {
	assertRuntimeImportClosure(
		[
			...collectRuntimeFiles(join(packageRoot, "dist")),
			...collectRuntimeFiles(join(packageRoot, "vendor")),
		],
		{
			onError(message) {
				throw new Error(message);
			},
			forbidInternalPackageImports: true,
			optionalInternalPackages: OPTIONAL_INTERNAL_PACKAGES,
			rootBoundaryPaths: [packageRoot],
			allowedExternalPackageNames:
				collectPublishedRuntimeDependencyNames(manifest),
		},
	);
}

export function stagePublishedPackage() {
	const manifest = derivePublishManifest();
	const runtimeClosureFiles = collectRequiredRuntimeClosureFiles();
	const stagingRoot = mkdtempSync(
		join(resolveSafeStagingParentDirectory(), STAGING_PREFIX),
	);
	const packageRoot = join(stagingRoot, "buildplane");
	const distRoot = join(packageRoot, "dist");
	const vendorRoot = join(packageRoot, "vendor", "@buildplane");

	try {
		mkdirSync(packageRoot, { recursive: true });
		mkdirSync(distRoot, { recursive: true });
		mkdirSync(vendorRoot, { recursive: true });

		copyRuntimeClosureFiles(runtimeClosureFiles, packageRoot);
		rewriteStagedRuntimeImports(packageRoot);
		rewriteStagedBootstrapWrapper(packageRoot);
		stripStagedRuntimeSourceMapComments(packageRoot);
		chmodSync(join(packageRoot, "dist", "index.js"), 0o755);
		assertStagedRuntimeClosure(packageRoot, manifest);

		writeFileSync(
			join(packageRoot, "package.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		writeFileSync(join(packageRoot, "README.md"), derivePublishedReadme());

		return {
			stagingRoot,
			packageRoot,
		};
	} catch (error) {
		rmSync(stagingRoot, { force: true, recursive: true });
		throw error;
	}
}

function isExecutedDirectly() {
	return resolve(process.argv[1] ?? "") === __filename;
}

if (isExecutedDirectly()) {
	try {
		const staged = stagePublishedPackage();
		process.stdout.write(`${JSON.stringify(staged)}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
