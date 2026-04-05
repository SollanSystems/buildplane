import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import ts from "typescript";

const RUNTIME_FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TYPESCRIPT_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const INTERNAL_PACKAGE_PREFIX = "@buildplane/";
const LOCAL_RUNTIME_SPECIFIER_PREFIXES = ["./", "../", ".\\", "..\\"];
const DEFAULT_PATH_IMPLEMENTATION = {
	isAbsolute,
	relative,
	resolve,
};
const DEFAULT_FS_IMPLEMENTATION = {
	existsSync,
	realpathSync(path) {
		return realpathSync.native?.(path) ?? realpathSync(path);
	},
};
function defaultError(message) {
	throw new Error(message);
}

function isRuntimeFile(path) {
	return RUNTIME_FILE_EXTENSIONS.has(extname(path));
}

function isSymbolicLinkPath(path) {
	return existsSync(path) && lstatSync(path).isSymbolicLink();
}

function assertRuntimePathIsNotSymlink(path, describeViolation, onError) {
	if (!isSymbolicLinkPath(path)) {
		return true;
	}

	onError(describeViolation(path));
	return false;
}

function findFirstRelativeSymlinkPathSegment(fromDirectoryPath, candidatePath) {
	const resolvedFromDirectoryPath = resolve(fromDirectoryPath);
	const resolvedCandidatePath = resolve(candidatePath);
	const relativeCandidatePath = relative(
		resolvedFromDirectoryPath,
		resolvedCandidatePath,
	);
	const segments = relativeCandidatePath.split(/[\\/]+/).filter(Boolean);
	let currentPath = resolvedFromDirectoryPath;

	for (const segment of segments.slice(0, -1)) {
		currentPath = join(currentPath, segment);
		if (existsSync(currentPath) && lstatSync(currentPath).isSymbolicLink()) {
			return currentPath;
		}
	}

	return undefined;
}

function assertRelativeRuntimeImportDoesNotTraverseSymlinkedDirectory(
	fromFilePath,
	candidatePath,
	describeViolation,
	onError,
) {
	const symbolicLinkPathSegment = findFirstRelativeSymlinkPathSegment(
		dirname(fromFilePath),
		candidatePath,
	);
	if (!symbolicLinkPathSegment) {
		return true;
	}

	onError(describeViolation(symbolicLinkPathSegment));
	return false;
}

function describeNode(sourceFile, node) {
	return node.getText(sourceFile).replace(/\s+/g, " ").trim();
}

function collectSourceModuleReferences(source, filePath) {
	const sourceFile = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.JS,
	);
	const references = [];
	const queueSpecifier = (moduleSpecifier) => {
		if (!ts.isStringLiteralLike(moduleSpecifier)) {
			return;
		}

		references.push({
			specifier: moduleSpecifier.text,
			type: "specifier",
		});
	};
	const queueDynamicImportViolation = (expression) => {
		references.push({
			expression: describeNode(sourceFile, expression),
			type: "unsupported-dynamic-import",
		});
	};
	const visit = (node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier) {
				queueSpecifier(node.moduleSpecifier);
			}
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length >= 1
		) {
			const [moduleSpecifier] = node.arguments;
			if (!ts.isStringLiteralLike(moduleSpecifier)) {
				queueDynamicImportViolation(moduleSpecifier);
			} else {
				queueSpecifier(moduleSpecifier);
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return references;
}

function isWindowsAbsolutePath(specifier) {
	return /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith("\\\\");
}

function isWindowsDrivePath(specifier) {
	return /^[A-Za-z]:/.test(specifier);
}

function isAbsoluteRuntimeSpecifier(specifier) {
	return (
		specifier.startsWith("/") ||
		specifier.startsWith("\\") ||
		isWindowsAbsolutePath(specifier) ||
		isWindowsDrivePath(specifier)
	);
}

function isRelativeRuntimeSpecifier(specifier) {
	return (
		specifier === "." ||
		specifier === ".." ||
		LOCAL_RUNTIME_SPECIFIER_PREFIXES.some((prefix) =>
			specifier.startsWith(prefix),
		)
	);
}

function isNodeRuntimeSpecifier(specifier) {
	return specifier.startsWith("node:") || isBuiltin(specifier);
}

function getBareExternalPackageName(specifier) {
	if (!specifier || specifier.startsWith("#")) {
		return undefined;
	}

	if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)) {
		return undefined;
	}

	if (specifier.startsWith("@")) {
		const segments = specifier.split("/");
		return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
	}

	const packageName = specifier.split("/")[0];
	return packageName || undefined;
}

function isDeclaredExternalPackageImport(
	specifier,
	allowedExternalPackageNames,
) {
	if (!allowedExternalPackageNames) {
		return true;
	}

	const packageName = getBareExternalPackageName(specifier);
	if (!packageName) {
		return true;
	}

	return allowedExternalPackageNames.has(packageName);
}

function canonicalizeBoundaryPath(path, pathImplementation, fsImplementation) {
	const resolvedPath = pathImplementation.resolve(path);
	if (
		!fsImplementation?.existsSync ||
		!fsImplementation?.realpathSync ||
		!fsImplementation.existsSync(resolvedPath)
	) {
		return resolvedPath;
	}

	try {
		return pathImplementation.resolve(
			fsImplementation.realpathSync(resolvedPath),
		);
	} catch {
		return resolvedPath;
	}
}

export function isPathWithinRootBoundary(
	rootPath,
	candidatePath,
	pathImplementation = DEFAULT_PATH_IMPLEMENTATION,
	fsImplementation = DEFAULT_FS_IMPLEMENTATION,
) {
	const normalizedRootPath = canonicalizeBoundaryPath(
		rootPath,
		pathImplementation,
		fsImplementation,
	);
	const normalizedCandidatePath = canonicalizeBoundaryPath(
		candidatePath,
		pathImplementation,
		fsImplementation,
	);
	const relativePath = pathImplementation.relative(
		normalizedRootPath,
		normalizedCandidatePath,
	);
	return (
		relativePath === "" ||
		(!pathImplementation.isAbsolute(relativePath) &&
			!relativePath.startsWith("..") &&
			relativePath !== "..")
	);
}

function findContainingRootBoundary(path, rootBoundaryPaths) {
	if (!Array.isArray(rootBoundaryPaths) || rootBoundaryPaths.length === 0) {
		return undefined;
	}

	return rootBoundaryPaths
		.map((rootPath) => resolve(rootPath))
		.filter((rootPath) => isPathWithinRootBoundary(rootPath, path))
		.sort((left, right) => right.length - left.length)[0];
}

function assertPathWithinRuntimeRoot(
	resolvedPath,
	specifier,
	fromFilePath,
	runtimeRoot,
	onError,
) {
	if (!runtimeRoot || isPathWithinRootBoundary(runtimeRoot, resolvedPath)) {
		return true;
	}

	onError(
		`Runtime import resolves outside its runtime root ${JSON.stringify(specifier)} from ${fromFilePath}: ${resolvedPath}`,
	);
	return false;
}

function assertPathWithinConfiguredRuntimeRoots(
	resolvedPath,
	specifier,
	fromFilePath,
	rootBoundaryPaths,
	onError,
) {
	if (
		!Array.isArray(rootBoundaryPaths) ||
		rootBoundaryPaths.length === 0 ||
		findContainingRootBoundary(resolvedPath, rootBoundaryPaths)
	) {
		return true;
	}

	onError(
		`Runtime import resolves outside the configured runtime roots ${JSON.stringify(specifier)} from ${fromFilePath}: ${resolvedPath}`,
	);
	return false;
}

function resolveRelativeRuntimeImport(fromFilePath, specifier) {
	const unresolvedPath = resolve(dirname(fromFilePath), specifier);
	const candidatePaths = extname(unresolvedPath)
		? [unresolvedPath]
		: [
				unresolvedPath,
				`${unresolvedPath}.js`,
				join(unresolvedPath, "index.js"),
			];

	for (const candidatePath of candidatePaths) {
		if (!existsSync(candidatePath)) {
			continue;
		}

		if (lstatSync(candidatePath).isSymbolicLink()) {
			return candidatePath;
		}

		if (statSync(candidatePath).isFile()) {
			return candidatePath;
		}
	}

	return undefined;
}

function findPublishUnsafeRuntimePathSegment(path, rootPath) {
	const relativePath = rootPath ? relative(rootPath, path) : path;
	const segments = relativePath.split(/[\\/]+/);
	for (const segment of ["src", "test"]) {
		if (segments.includes(segment)) {
			return segment;
		}
	}

	return undefined;
}

function assertPublishSafeRuntimePath(
	resolvedPath,
	rootPath,
	describeViolation,
	onError,
) {
	if (TYPESCRIPT_FILE_EXTENSIONS.has(extname(resolvedPath))) {
		onError(describeViolation("TypeScript source", resolvedPath));
		return false;
	}

	const leakedPathSegment = findPublishUnsafeRuntimePathSegment(
		resolvedPath,
		rootPath,
	);
	if (leakedPathSegment) {
		onError(describeViolation(`${leakedPathSegment}/** path`, resolvedPath));
		return false;
	}

	return true;
}

function assertPublishSafeRuntimeTarget(
	resolvedPath,
	specifier,
	fromFilePath,
	rootPath,
	onError,
) {
	return assertPublishSafeRuntimePath(
		resolvedPath,
		rootPath,
		(kind, path) =>
			`Runtime import resolves to ${kind} ${JSON.stringify(specifier)} from ${fromFilePath}: ${path}`,
		onError,
	);
}

function assertPublishSafeRuntimeEntryPath(filePath, rootPath, onError) {
	return assertPublishSafeRuntimePath(
		filePath,
		rootPath,
		(kind, path) => `Runtime tree contains ${kind}: ${path}`,
		onError,
	);
}

export function collectRuntimeFiles(root) {
	if (!existsSync(root)) {
		return [];
	}

	const files = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`Runtime tree must not contain symlinked paths: ${path}`);
		}

		if (entry.isDirectory()) {
			files.push(...collectRuntimeFiles(path));
			continue;
		}

		if (entry.isFile() && isRuntimeFile(path)) {
			files.push(path);
		}
	}
	return files;
}

export function assertRuntimeImportClosure(entryFilePaths, options = {}) {
	const {
		onError = defaultError,
		resolveInternalImport,
		forbidInternalPackageImports = false,
		rootBoundaryPaths,
		allowedExternalPackageNames,
		optionalInternalPackages,
	} = options;
	const allowedExternalPackageNameSet = allowedExternalPackageNames
		? new Set(allowedExternalPackageNames)
		: undefined;
	const optionalInternalPackageSet = optionalInternalPackages
		? new Set(optionalInternalPackages)
		: undefined;
	const visited = new Set();
	const pending = [...entryFilePaths];

	while (pending.length > 0) {
		const filePath = pending.pop();
		if (!filePath || visited.has(filePath)) {
			continue;
		}

		if (!existsSync(filePath)) {
			onError(`Missing required runtime entrypoint: ${filePath}`);
			continue;
		}

		if (
			!assertRuntimePathIsNotSymlink(
				filePath,
				(path) => `Runtime file must not be a symlink: ${path}`,
				onError,
			)
		) {
			continue;
		}

		if (!statSync(filePath).isFile()) {
			onError(`Missing required runtime entrypoint: ${filePath}`);
			continue;
		}

		const runtimeRoot = findContainingRootBoundary(filePath, rootBoundaryPaths);
		if (
			Array.isArray(rootBoundaryPaths) &&
			rootBoundaryPaths.length > 0 &&
			!runtimeRoot
		) {
			onError(
				`Runtime file is outside the configured runtime roots: ${filePath}`,
			);
			continue;
		}

		if (!assertPublishSafeRuntimeEntryPath(filePath, runtimeRoot, onError)) {
			continue;
		}

		visited.add(filePath);
		const source = readFileSync(filePath, "utf8");

		for (const reference of collectSourceModuleReferences(source, filePath)) {
			if (reference.type === "unsupported-dynamic-import") {
				onError(
					`Runtime file uses computed dynamic import ${JSON.stringify(reference.expression)} in ${filePath}`,
				);
				continue;
			}

			const specifier = reference.specifier;
			if (isNodeRuntimeSpecifier(specifier)) {
				continue;
			}

			if (specifier.startsWith(INTERNAL_PACKAGE_PREFIX)) {
				if (optionalInternalPackageSet?.has(specifier)) {
					continue;
				}

				if (forbidInternalPackageImports) {
					onError(
						`Runtime file still contains internal package import ${JSON.stringify(specifier)}: ${filePath}`,
					);
					continue;
				}

				if (!resolveInternalImport) {
					onError(
						`Cannot resolve internal runtime import ${JSON.stringify(specifier)} from ${filePath}`,
					);
					continue;
				}

				const resolvedInternalPath = resolveInternalImport(specifier, filePath);
				if (!resolvedInternalPath) {
					onError(
						`Cannot resolve internal runtime import ${JSON.stringify(specifier)} from ${filePath}`,
					);
					continue;
				}

				if (
					!assertRuntimePathIsNotSymlink(
						resolvedInternalPath,
						(path) =>
							`Runtime import resolves to a symlink ${JSON.stringify(specifier)} from ${filePath}: ${path}`,
						onError,
					)
				) {
					continue;
				}

				const internalRuntimeRoot = findContainingRootBoundary(
					resolvedInternalPath,
					rootBoundaryPaths,
				);
				if (
					!assertPublishSafeRuntimeTarget(
						resolvedInternalPath,
						specifier,
						filePath,
						internalRuntimeRoot,
						onError,
					) ||
					!assertPathWithinConfiguredRuntimeRoots(
						resolvedInternalPath,
						specifier,
						filePath,
						rootBoundaryPaths,
						onError,
					)
				) {
					continue;
				}

				pending.push(resolvedInternalPath);
				continue;
			}

			if (isAbsoluteRuntimeSpecifier(specifier)) {
				onError(
					`Runtime import uses absolute filesystem specifier ${JSON.stringify(specifier)} in ${filePath}`,
				);
				continue;
			}

			if (!isRelativeRuntimeSpecifier(specifier)) {
				const externalPackageName = getBareExternalPackageName(specifier);
				if (
					externalPackageName &&
					!isDeclaredExternalPackageImport(
						specifier,
						allowedExternalPackageNameSet,
					)
				) {
					onError(
						`Runtime file imports bare external dependency ${JSON.stringify(specifier)} from ${filePath} but the published manifest does not declare ${JSON.stringify(externalPackageName)}`,
					);
				}
				continue;
			}

			const resolvedRelativePath = resolveRelativeRuntimeImport(
				filePath,
				specifier,
			);
			if (!resolvedRelativePath) {
				onError(
					`Missing runtime import target ${JSON.stringify(specifier)} from ${filePath}`,
				);
				continue;
			}

			if (
				!assertRuntimePathIsNotSymlink(
					resolvedRelativePath,
					(path) =>
						`Runtime import resolves to a symlink ${JSON.stringify(specifier)} from ${filePath}: ${path}`,
					onError,
				) ||
				!assertRelativeRuntimeImportDoesNotTraverseSymlinkedDirectory(
					filePath,
					resolvedRelativePath,
					(path) =>
						`Runtime import resolves through a symlinked path segment ${JSON.stringify(specifier)} from ${filePath}: ${path}`,
					onError,
				)
			) {
				continue;
			}

			if (
				!assertPublishSafeRuntimeTarget(
					resolvedRelativePath,
					specifier,
					filePath,
					runtimeRoot,
					onError,
				) ||
				!assertPathWithinRuntimeRoot(
					resolvedRelativePath,
					specifier,
					filePath,
					runtimeRoot,
					onError,
				)
			) {
				continue;
			}

			pending.push(resolvedRelativePath);
		}
	}

	return [...visited];
}
