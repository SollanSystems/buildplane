import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir as nodeOsTmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
	assertRuntimeImportClosure,
	collectRuntimeFiles,
} from "./runtime-closure.mjs";
import { OPTIONAL_INTERNAL_PACKAGES } from "./stage-package.mjs";
import { extractTarballToDirectory } from "./tarball.mjs";

const __filename = fileURLToPath(import.meta.url);
const REQUIRED_NODE_VERSION = "24.13.1";
const DEPENDENCY_FIELDS = [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"devDependencies",
];
const UNSAFE_DEPENDENCY_PREFIXES = ["workspace:", "file:", "link:"];
const LOCAL_FILESYSTEM_PREFIXES = ["../", "./", "..\\", ".\\"];
const INSTALL_LIFECYCLE_HOOKS = ["preinstall", "install", "postinstall"];
const EXECUTABLE_MODE_MASK = 0o111;
const SEMVER_VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const REQUIRED_PUBLISHED_README_SNIPPETS = Object.freeze([
	"npm install -g buildplane",
]);
const FORBIDDEN_STAGED_README_PATTERNS = Object.freeze([
	{
		description: "repo-dev-only pnpm buildplane guidance",
		pattern: /pnpm buildplane/i,
	},
	{
		description: "repo-local pnpm build guidance",
		pattern: /\bpnpm build\b/i,
	},
	{
		description: "repo-dev-only pnpm install guidance",
		pattern: /pnpm install/i,
	},
	{
		description: "repo-dev-only tsx execution guidance",
		pattern: /\btsx\b/i,
	},
	{
		description: "in-repo built CLI guidance",
		pattern: /node apps\/cli\/dist\/index\.js/i,
	},
	{
		description: "repo-status or milestone text",
		pattern: /^##\s+Status\b|\bMilestone\s+\d+\b/im,
	},
]);
const RUNTIME_TREE_ROOTS = Object.freeze(["dist", "vendor"]);
const REQUIRED_WRAPPER_RUNTIME_BOUNDARY_SPECIFIER = "./cli.js";
const ALLOWED_STAGED_PACKAGE_ROOT_ENTRIES = new Set([
	"README.md",
	"dist",
	"package.json",
	"vendor",
]);
const FORBIDDEN_RUNTIME_PATH_SEGMENTS = new Set(["src", "test"]);
const ALLOWED_STATIC_WRAPPER_IMPORT_SPECIFIERS = new Set([
	"./version-guard.js",
]);
const ALLOWED_FILES_WHITELIST_ENTRIES = Object.freeze([
	"README.md",
	"dist",
	"dist/**",
	"dist/**/*",
	"vendor",
	"vendor/**",
	"vendor/**/*",
]);
const REQUIRED_FILES_WHITELIST_SURFACES = Object.freeze([
	{
		description: "README.md",
		isCoveredBy: (entry) =>
			coversManifestFileWhitelistEntry(entry, "README.md"),
	},
	{
		description: "dist/**",
		isCoveredBy: (entry) =>
			coversManifestDirectoryWhitelistClosure(entry, "dist"),
	},
	{
		description: "vendor/**",
		isCoveredBy: (entry) =>
			coversManifestDirectoryWhitelistClosure(entry, "vendor"),
	},
]);

function fail(message) {
	throw new Error(message);
}

function getErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function shouldEnforceExecutableMode(platform = process.platform) {
	return platform !== "win32";
}

function readJson(path) {
	let source;
	try {
		source = readFileSync(path, "utf8");
	} catch (error) {
		fail(`Failed to read JSON file ${path}: ${getErrorMessage(error)}`);
	}

	try {
		return JSON.parse(source);
	} catch (error) {
		fail(`Failed to parse JSON file ${path}: ${getErrorMessage(error)}`);
	}
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
		specifier.startsWith("\\") ||
		LOCAL_FILESYSTEM_PREFIXES.some((prefix) => specifier.startsWith(prefix))
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

function isInternalBuildplanePackageName(packageName) {
	return packageName.startsWith("@buildplane/");
}

function getAliasedDependencyPackageName(specifier) {
	if (!specifier.startsWith("npm:")) {
		return undefined;
	}

	const aliasTarget = specifier.slice("npm:".length);
	if (!aliasTarget) {
		return undefined;
	}

	if (aliasTarget.startsWith("@")) {
		const scopeSeparatorIndex = aliasTarget.indexOf("/");
		if (scopeSeparatorIndex === -1) {
			return aliasTarget;
		}

		const versionSeparatorIndex = aliasTarget.indexOf(
			"@",
			scopeSeparatorIndex + 1,
		);
		return versionSeparatorIndex === -1
			? aliasTarget
			: aliasTarget.slice(0, versionSeparatorIndex);
	}

	const versionSeparatorIndex = aliasTarget.indexOf("@");
	return versionSeparatorIndex === -1
		? aliasTarget
		: aliasTarget.slice(0, versionSeparatorIndex);
}

function collectPublishedRuntimeDependencyNames(manifest) {
	const names = new Set();
	for (const field of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const dependencies = manifest[field];
		if (!isPlainObject(dependencies)) {
			continue;
		}

		for (const name of Object.keys(dependencies)) {
			names.add(name);
		}
	}

	return names;
}

function normalizeManifestWhitelistEntry(value) {
	return value
		.replace(/\\/g, "/")
		.replace(/^[.]\//, "")
		.replace(/^\/+/, "")
		.replace(/\/+/g, "/")
		.replace(/\/$/, "");
}

function coversManifestFileWhitelistEntry(value, filePath) {
	const normalizedValue = normalizeManifestWhitelistEntry(value);
	return (
		normalizedValue === filePath ||
		normalizedValue === "*" ||
		normalizedValue === "**" ||
		normalizedValue === "**/*"
	);
}

function coversManifestDirectoryWhitelistClosure(value, directoryName) {
	const normalizedValue = normalizeManifestWhitelistEntry(value);
	return (
		normalizedValue === directoryName ||
		normalizedValue === `${directoryName}/**` ||
		normalizedValue === `${directoryName}/**/*` ||
		normalizedValue === "**" ||
		normalizedValue === "**/*"
	);
}

function assertFilesWhitelistContract(manifest) {
	if (!("files" in manifest)) {
		fail("package.json.files is required and must be an array");
	}

	if (!Array.isArray(manifest.files)) {
		fail(
			`package.json.files must be an array (received ${JSON.stringify(manifest.files)})`,
		);
	}

	const nonStringEntries = manifest.files.filter(
		(value) => typeof value !== "string",
	);
	if (nonStringEntries.length > 0) {
		fail(
			`package.json.files must contain only string whitelist entries (received ${JSON.stringify(nonStringEntries)})`,
		);
	}

	const normalizedEntries = manifest.files.map((value) =>
		normalizeManifestWhitelistEntry(value),
	);
	const invalidEntries = normalizedEntries.filter(
		(entry) => !ALLOWED_FILES_WHITELIST_ENTRIES.includes(entry),
	);
	if (invalidEntries.length > 0) {
		fail(
			`package.json.files must stay within the staged runtime surface (allowed ${JSON.stringify(ALLOWED_FILES_WHITELIST_ENTRIES)}; received ${JSON.stringify(invalidEntries)})`,
		);
	}

	const missingSurfaces = REQUIRED_FILES_WHITELIST_SURFACES.filter(
		({ isCoveredBy }) => !normalizedEntries.some((entry) => isCoveredBy(entry)),
	).map(({ description }) => description);
	if (missingSurfaces.length === 0) {
		return;
	}

	fail(
		`package.json.files must whitelist the full published runtime surface (missing ${missingSurfaces.join(", ")} coverage): ${JSON.stringify(normalizedEntries)}`,
	);
}

function walkTree(rootPath, visit) {
	if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
		return;
	}

	for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
		const entryPath = join(rootPath, entry.name);
		visit(entryPath, entry);
		if (entry.isDirectory()) {
			walkTree(entryPath, visit);
		}
	}
}

function assertNoRuntimePayloadLeakage(packageRoot) {
	for (const runtimeTreeRoot of RUNTIME_TREE_ROOTS) {
		const runtimeRootPath = join(packageRoot, runtimeTreeRoot);
		walkTree(runtimeRootPath, (entryPath) => {
			const relativePath = relative(packageRoot, entryPath);
			for (const segment of relativePath.split(/[\\/]+/)) {
				if (FORBIDDEN_RUNTIME_PATH_SEGMENTS.has(segment)) {
					fail(
						`Runtime package must not include ${segment}/** payloads in the shipped runtime tree: ${entryPath}`,
					);
				}
			}
		});
	}
}

function collectShippedRuntimeFiles(packageRoot) {
	return [
		...collectRuntimeFiles(join(packageRoot, "dist")),
		...collectRuntimeFiles(join(packageRoot, "vendor")),
	];
}

function assertNoUnexpectedRuntimePayload(
	packageRoot,
	distIndexPath,
	manifest,
) {
	const reachableRuntimeFiles = assertRuntimeImportClosure([distIndexPath], {
		onError: fail,
		forbidInternalPackageImports: true,
		optionalInternalPackages: OPTIONAL_INTERNAL_PACKAGES,
		rootBoundaryPaths: [packageRoot],
		allowedExternalPackageNames:
			collectPublishedRuntimeDependencyNames(manifest),
	});
	const reachableRuntimeFileSet = new Set(reachableRuntimeFiles);
	const extraRuntimeFiles = collectShippedRuntimeFiles(packageRoot)
		.filter((filePath) => !reachableRuntimeFileSet.has(filePath))
		.map((filePath) => relative(packageRoot, filePath))
		.sort();
	if (extraRuntimeFiles.length === 0) {
		return;
	}

	fail(
		`Unexpected staged runtime payload outside the dist/index.js closure: ${extraRuntimeFiles.join(", ")}`,
	);
}

function assertNoUnexpectedPackageRootPayload(packageRoot) {
	const unexpectedEntries = readdirSync(packageRoot, {
		withFileTypes: true,
	})
		.filter((entry) => !ALLOWED_STAGED_PACKAGE_ROOT_ENTRIES.has(entry.name))
		.map((entry) => entry.name)
		.sort();
	if (unexpectedEntries.length > 0) {
		fail(
			`Unexpected staged package root payload in ${packageRoot}: ${unexpectedEntries.join(", ")}`,
		);
	}
}

function assertReadmeContract(readmePath, readme) {
	for (const { description, pattern } of FORBIDDEN_STAGED_README_PATTERNS) {
		const match = readme.match(pattern)?.[0];
		if (match) {
			fail(
				`README.md must not contain ${description} (${JSON.stringify(match)}): ${readmePath}`,
			);
		}
	}

	const missingSnippets = REQUIRED_PUBLISHED_README_SNIPPETS.filter(
		(snippet) => !readme.includes(snippet),
	);
	if (missingSnippets.length > 0) {
		fail(
			`README.md must contain published install guidance (${missingSnippets.join(", ")}): ${readmePath}`,
		);
	}
}

function parseJavaScriptSource(source, filePath) {
	return ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.JS,
	);
}

function isLocalDynamicImportCall(node) {
	if (
		!ts.isCallExpression(node) ||
		node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
		node.arguments.length < 1 ||
		!ts.isStringLiteralLike(node.arguments[0])
	) {
		return false;
	}

	const specifier = node.arguments[0].text;
	return isLocalFilesystemPath(specifier) && !isAbsolute(specifier);
}

function getStaticModuleSpecifier(statement) {
	if (
		(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
		statement.moduleSpecifier &&
		ts.isStringLiteralLike(statement.moduleSpecifier)
	) {
		return statement.moduleSpecifier.text;
	}

	return undefined;
}

function isStaticWrapperVersionGuardImport(statement) {
	if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier) {
		return false;
	}

	if (!ts.isStringLiteralLike(statement.moduleSpecifier)) {
		return false;
	}

	return ALLOWED_STATIC_WRAPPER_IMPORT_SPECIFIERS.has(
		statement.moduleSpecifier.text,
	);
}

function statementBindsVersionGuardImport(statement) {
	if (!ts.isImportDeclaration(statement) || !statement.importClause) {
		return false;
	}

	if (statement.importClause.isTypeOnly || statement.importClause.name) {
		return false;
	}

	const namedBindings = statement.importClause.namedBindings;
	if (!namedBindings || ts.isNamespaceImport(namedBindings)) {
		return false;
	}

	return namedBindings.elements.some((element) => {
		const importedName = element.propertyName
			? element.propertyName.text
			: element.name.text;
		return (
			importedName === "assertSupportedNodeVersion" &&
			element.name.text === "assertSupportedNodeVersion"
		);
	});
}

function isAllowedStaticWrapperVersionGuardImport(statement) {
	return (
		isStaticWrapperVersionGuardImport(statement) &&
		statementBindsVersionGuardImport(statement)
	);
}

function findMalformedStaticWrapperVersionGuardImport(sourceFile) {
	for (const statement of sourceFile.statements) {
		if (
			isStaticWrapperVersionGuardImport(statement) &&
			!statementBindsVersionGuardImport(statement)
		) {
			return statement;
		}
	}

	return undefined;
}

function findUnsafeStaticWrapperImport(sourceFile) {
	for (const statement of sourceFile.statements) {
		const specifier = getStaticModuleSpecifier(statement);
		if (!specifier || ALLOWED_STATIC_WRAPPER_IMPORT_SPECIFIERS.has(specifier)) {
			continue;
		}

		return specifier;
	}

	return undefined;
}

function unwrapParenthesizedExpression(node) {
	let currentNode = node;
	while (ts.isParenthesizedExpression(currentNode)) {
		currentNode = currentNode.expression;
	}
	return currentNode;
}

function getAwaitedRuntimeBoundarySpecifier(expression) {
	if (!expression) {
		return undefined;
	}

	const node = unwrapParenthesizedExpression(expression);
	if (!ts.isAwaitExpression(node)) {
		return undefined;
	}

	const awaitedExpression = unwrapParenthesizedExpression(node.expression);
	if (!isLocalDynamicImportCall(awaitedExpression)) {
		return undefined;
	}

	return awaitedExpression.arguments[0].text;
}

function getTopLevelWrapperRuntimeBoundary(statement) {
	if (!ts.isVariableStatement(statement)) {
		return undefined;
	}

	if (statement.declarationList.declarations.length !== 1) {
		return undefined;
	}

	const [declaration] = statement.declarationList.declarations;
	const specifier = getAwaitedRuntimeBoundarySpecifier(declaration.initializer);
	return specifier ? { specifier } : undefined;
}

function findLocalDynamicImportSpecifier(node) {
	let dynamicImportSpecifier;
	const visit = (currentNode) => {
		if (dynamicImportSpecifier || !currentNode) {
			return;
		}

		if (isLocalDynamicImportCall(currentNode)) {
			dynamicImportSpecifier = currentNode.arguments[0].text;
			return;
		}

		ts.forEachChild(currentNode, visit);
	};

	visit(node);
	return dynamicImportSpecifier;
}

function isTopLevelVersionGuardCallStatement(statement) {
	return (
		ts.isExpressionStatement(statement) &&
		ts.isCallExpression(statement.expression) &&
		ts.isIdentifier(statement.expression.expression) &&
		statement.expression.expression.text === "assertSupportedNodeVersion" &&
		statement.expression.arguments.length === 0
	);
}

function assertWrapperImportBoundary(distIndexPath, indexSource) {
	const sourceFile = parseJavaScriptSource(indexSource, distIndexPath);
	const malformedVersionGuardImport =
		findMalformedStaticWrapperVersionGuardImport(sourceFile);
	if (malformedVersionGuardImport) {
		fail(
			`dist/index.js must import { assertSupportedNodeVersion } from ${JSON.stringify([...ALLOWED_STATIC_WRAPPER_IMPORT_SPECIFIERS][0])} before importing its runtime boundary ${JSON.stringify(REQUIRED_WRAPPER_RUNTIME_BOUNDARY_SPECIFIER)}: ${distIndexPath}`,
		);
	}

	const unsafeStaticWrapperImport = findUnsafeStaticWrapperImport(sourceFile);
	if (unsafeStaticWrapperImport) {
		fail(
			`dist/index.js must not contain top-level static imports other than ${JSON.stringify([...ALLOWED_STATIC_WRAPPER_IMPORT_SPECIFIERS][0])} (found ${JSON.stringify(unsafeStaticWrapperImport)}): ${distIndexPath}`,
		);
	}

	let prefixImportCount = 0;
	while (
		prefixImportCount < sourceFile.statements.length &&
		ts.isImportDeclaration(sourceFile.statements[prefixImportCount])
	) {
		if (
			!isAllowedStaticWrapperVersionGuardImport(
				sourceFile.statements[prefixImportCount],
			)
		) {
			fail(
				`dist/index.js must not contain top-level static imports other than ${JSON.stringify([...ALLOWED_STATIC_WRAPPER_IMPORT_SPECIFIERS][0])} (found ${JSON.stringify(getStaticModuleSpecifier(sourceFile.statements[prefixImportCount]))}): ${distIndexPath}`,
			);
		}

		prefixImportCount += 1;
	}

	if (prefixImportCount === 0) {
		fail(
			`dist/index.js must import assertSupportedNodeVersion() from ${JSON.stringify([...ALLOWED_STATIC_WRAPPER_IMPORT_SPECIFIERS][0])} before importing its runtime boundary ${JSON.stringify(REQUIRED_WRAPPER_RUNTIME_BOUNDARY_SPECIFIER)}`,
		);
	}

	const guardStatement = sourceFile.statements[prefixImportCount];
	if (!guardStatement || !isTopLevelVersionGuardCallStatement(guardStatement)) {
		fail(
			`dist/index.js must call assertSupportedNodeVersion() before importing its runtime boundary ${JSON.stringify(REQUIRED_WRAPPER_RUNTIME_BOUNDARY_SPECIFIER)}`,
		);
	}

	const runtimeBoundaryStatement = sourceFile.statements[prefixImportCount + 1];
	const runtimeBoundary = runtimeBoundaryStatement
		? getTopLevelWrapperRuntimeBoundary(runtimeBoundaryStatement)
		: undefined;
	if (!runtimeBoundary) {
		fail(
			`dist/index.js must call assertSupportedNodeVersion() before importing its runtime boundary ${JSON.stringify(REQUIRED_WRAPPER_RUNTIME_BOUNDARY_SPECIFIER)} and must declare that runtime boundary as exactly one top-level variable statement with a single awaited dynamic import: ${distIndexPath}`,
		);
	}

	if (
		runtimeBoundary.specifier !== REQUIRED_WRAPPER_RUNTIME_BOUNDARY_SPECIFIER
	) {
		fail(
			`dist/index.js must dynamically import ${JSON.stringify(REQUIRED_WRAPPER_RUNTIME_BOUNDARY_SPECIFIER)} as its runtime boundary (received ${JSON.stringify(runtimeBoundary.specifier)}): ${distIndexPath}`,
		);
	}

	const trailingStaticImport = sourceFile.statements
		.slice(prefixImportCount + 1)
		.find((statement) => ts.isImportDeclaration(statement));
	if (trailingStaticImport) {
		fail(
			`dist/index.js must keep all top-level static imports inside its initial version-guard prefix before assertSupportedNodeVersion() (found ${JSON.stringify(getStaticModuleSpecifier(trailingStaticImport))}): ${distIndexPath}`,
		);
	}

	const extraTopLevelRuntimeImport = sourceFile.statements
		.slice(prefixImportCount + 2)
		.map((statement) => findLocalDynamicImportSpecifier(statement))
		.find(Boolean);
	if (extraTopLevelRuntimeImport) {
		fail(
			`dist/index.js must not contain additional top-level or nested local dynamic imports after its required runtime boundary ${JSON.stringify(REQUIRED_WRAPPER_RUNTIME_BOUNDARY_SPECIFIER)} (found ${JSON.stringify(extraTopLevelRuntimeImport)}): ${distIndexPath}`,
		);
	}
}

function assertManifestContract(packageRoot, manifest, options = {}) {
	const platform = options.platform ?? process.platform;
	assertNoUnexpectedPackageRootPayload(packageRoot);

	if (manifest.name !== "buildplane") {
		fail(
			`package.json.name must be "buildplane" (received ${JSON.stringify(manifest.name)})`,
		);
	}

	if (
		typeof manifest.version !== "string" ||
		!SEMVER_VERSION_PATTERN.test(manifest.version)
	) {
		fail(
			`package.json.version must be a valid semver string (received ${JSON.stringify(manifest.version)})`,
		);
	}

	if (manifest.type !== "module") {
		fail(
			`package.json.type must be "module" (received ${JSON.stringify(manifest.type)})`,
		);
	}

	if ("private" in manifest && manifest.private !== false) {
		fail("package.json.private must be absent or false");
	}

	if (manifest.bin?.buildplane !== "./dist/index.js") {
		fail(
			`package.json.bin.buildplane must be "./dist/index.js" (received ${JSON.stringify(manifest.bin?.buildplane)})`,
		);
	}

	if (manifest.engines?.node !== REQUIRED_NODE_VERSION) {
		fail(
			`package.json.engines.node must be "${REQUIRED_NODE_VERSION}" (received ${JSON.stringify(manifest.engines?.node)})`,
		);
	}

	for (const field of DEPENDENCY_FIELDS) {
		if (!(field in manifest)) {
			continue;
		}

		const dependencies = manifest[field];
		if (!isPlainObject(dependencies)) {
			fail(`package.json.${field} must be a plain object`);
		}

		for (const [name, specifier] of Object.entries(dependencies)) {
			if (isInternalBuildplanePackageName(name)) {
				fail(
					`package.json.${field}.${name} must not remain in the published manifest`,
				);
			}

			if (typeof specifier !== "string") {
				fail(
					`package.json.${field}.${name} has publish-unsafe specifier ${JSON.stringify(specifier)}`,
				);
			}

			const aliasedPackageName = getAliasedDependencyPackageName(specifier);
			if (
				aliasedPackageName &&
				isInternalBuildplanePackageName(aliasedPackageName)
			) {
				fail(
					`package.json.${field}.${name} must not alias internal published dependencies (${JSON.stringify(aliasedPackageName)})`,
				);
			}

			if (isPublishUnsafeDependencySpecifier(specifier)) {
				fail(
					`package.json.${field}.${name} has publish-unsafe specifier ${JSON.stringify(specifier)}`,
				);
			}
		}
	}

	if ("scripts" in manifest) {
		const scripts = manifest.scripts;
		if (!isPlainObject(scripts)) {
			fail("package.json.scripts must be a plain object");
		}

		for (const lifecycleHook of INSTALL_LIFECYCLE_HOOKS) {
			if (lifecycleHook in scripts) {
				fail(
					`package.json.scripts.${lifecycleHook} must be absent from the published package`,
				);
			}
		}
	}

	for (const field of ["files", "bundleDependencies", "bundledDependencies"]) {
		const values = manifest[field];
		if (!Array.isArray(values)) {
			continue;
		}

		for (const value of values) {
			if (typeof value !== "string") {
				continue;
			}

			if (field !== "files" && isInternalBuildplanePackageName(value)) {
				fail(`package.json.${field} must not include ${JSON.stringify(value)}`);
			}

			const normalizedValue = value.replace(/^[.][\\/]+/, "");
			const pathSegments = normalizedValue.split(/[\\/]+/).filter(Boolean);
			if (
				pathSegments.some((segment) =>
					FORBIDDEN_RUNTIME_PATH_SEGMENTS.has(segment),
				)
			) {
				fail(`package.json.${field} must not include ${JSON.stringify(value)}`);
			}
		}
	}
	assertFilesWhitelistContract(manifest);

	const distIndexPath = join(packageRoot, "dist", "index.js");
	if (!existsSync(distIndexPath) || !statSync(distIndexPath).isFile()) {
		fail(`Missing required runtime entrypoint: ${distIndexPath}`);
	}

	const distIndexStats = statSync(distIndexPath);
	if (
		shouldEnforceExecutableMode(platform) &&
		(distIndexStats.mode & EXECUTABLE_MODE_MASK) === 0
	) {
		fail(`dist/index.js must be executable: ${distIndexPath}`);
	}

	const indexSource = readFileSync(distIndexPath, "utf8");
	if (!indexSource.startsWith("#!/usr/bin/env node")) {
		fail(`dist/index.js must start with a shebang: ${distIndexPath}`);
	}
	assertWrapperImportBoundary(distIndexPath, indexSource);

	assertNoRuntimePayloadLeakage(packageRoot);
	assertNoUnexpectedRuntimePayload(packageRoot, distIndexPath, manifest);

	const readmePath = join(packageRoot, "README.md");
	if (!existsSync(readmePath) || !statSync(readmePath).isFile()) {
		fail(`Missing staged README.md: ${readmePath}`);
	}

	assertReadmeContract(readmePath, readFileSync(readmePath, "utf8"));

	for (const runtimeOnlyPath of [
		join(packageRoot, "src"),
		join(packageRoot, "test"),
	]) {
		if (existsSync(runtimeOnlyPath)) {
			fail(`Runtime package must not include ${runtimeOnlyPath}`);
		}
	}
}

function resolveInspectionTarget(inputPath) {
	const resolvedInputPath = resolve(inputPath);
	if (!existsSync(resolvedInputPath)) {
		fail(`Inspection target does not exist: ${resolvedInputPath}`);
	}

	if (statSync(resolvedInputPath).isDirectory()) {
		return {
			cleanup: () => {},
			inputPath: resolvedInputPath,
			packageRoot: resolvedInputPath,
			sourceType: "directory",
		};
	}

	if (!/\.tgz$|\.tar\.gz$/i.test(resolvedInputPath)) {
		fail(
			`Inspection target must be a staged package directory or tarball: ${resolvedInputPath}`,
		);
	}

	const rawTmpdir = nodeOsTmpdir();
	const safeTmpdir =
		typeof rawTmpdir === "string" &&
		rawTmpdir.length > 0 &&
		rawTmpdir !== "undefined" &&
		existsSync(rawTmpdir)
			? rawTmpdir
			: process.platform === "win32"
				? "C:\\Windows\\Temp"
				: "/tmp";
	const extractionRoot = mkdtempSync(join(safeTmpdir, "buildplane-inspect-"));
	try {
		extractTarballToDirectory(resolvedInputPath, extractionRoot);
	} catch (error) {
		rmSync(extractionRoot, { force: true, recursive: true });
		const message = error instanceof Error ? error.message : String(error);
		fail(
			`Failed to extract tarball ${resolvedInputPath} for inspection: ${message}`,
		);
	}
	const packageRoot = join(extractionRoot, "package");
	if (!existsSync(packageRoot) || !statSync(packageRoot).isDirectory()) {
		rmSync(extractionRoot, { force: true, recursive: true });
		fail(`Tarball did not unpack a package/ directory: ${resolvedInputPath}`);
	}

	const extraTopLevelEntries = readdirSync(extractionRoot, {
		withFileTypes: true,
	})
		.filter((entry) => entry.name !== "package")
		.map((entry) => entry.name)
		.sort();
	if (extraTopLevelEntries.length > 0) {
		rmSync(extractionRoot, { force: true, recursive: true });
		fail(
			`Tarball must contain only a top-level package/ directory (found ${extraTopLevelEntries.join(", ")}): ${resolvedInputPath}`,
		);
	}

	return {
		cleanup: () => {
			rmSync(extractionRoot, { force: true, recursive: true });
		},
		inputPath: resolvedInputPath,
		packageRoot,
		sourceType: "tarball",
	};
}

export function inspectPublishedPackage(inputPath, options = {}) {
	const inspectionTarget = resolveInspectionTarget(inputPath);

	try {
		assertManifestContract(
			inspectionTarget.packageRoot,
			readJson(join(inspectionTarget.packageRoot, "package.json")),
			options,
		);

		if (inspectionTarget.sourceType === "directory") {
			return {
				inputPath: inspectionTarget.inputPath,
				packageRoot: inspectionTarget.packageRoot,
				sourceType: inspectionTarget.sourceType,
			};
		}

		return {
			inputPath: inspectionTarget.inputPath,
			sourceType: inspectionTarget.sourceType,
		};
	} finally {
		inspectionTarget.cleanup();
	}
}

function isExecutedDirectly() {
	return resolve(process.argv[1] ?? "") === __filename;
}

if (isExecutedDirectly()) {
	try {
		const inputPath = process.argv[2];
		if (!inputPath) {
			fail(
				`Usage: node ${dirname(__filename)}/inspect-package.mjs <staged-package-path|tarball-path>`,
			);
		}

		const result = inspectPublishedPackage(inputPath);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
