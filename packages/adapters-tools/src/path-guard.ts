import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/**
 * Assert that a relative path stays within the workspace root.
 * Throws if the path is absolute, escapes via `..`, or traverses a symlink
 * that resolves outside the workspace.
 */
export function assertPathWithinWorkspace(
	workspaceRoot: string,
	value: string,
	label: string,
): void {
	if (isAbsolute(value)) {
		throw new Error(`${label} must not be absolute`);
	}

	const normalizedWorkspaceRoot = realpathSync(workspaceRoot);
	const normalizedValue = normalize(value);
	const resolvedPath = resolve(normalizedWorkspaceRoot, normalizedValue);
	const relativeToRoot = relative(normalizedWorkspaceRoot, resolvedPath);

	if (
		relativeToRoot.startsWith(`..${sep}`) ||
		relativeToRoot === ".." ||
		isAbsolute(relativeToRoot)
	) {
		throw new Error(`${label} is outside the workspace root`);
	}

	// Walk segments to detect symlink escapes
	let currentPath = normalizedWorkspaceRoot;
	for (const segment of normalizedValue.split(/[\\/]+/).filter(Boolean)) {
		currentPath = resolve(currentPath, segment);
		if (!existsSync(currentPath)) {
			break;
		}

		const stat = lstatSync(currentPath);
		if (stat.isSymbolicLink()) {
			throw new Error(
				`${label} traverses a symlink and escapes the workspace root`,
			);
		}

		const realPath = realpathSync(currentPath);
		const realRelative = relative(normalizedWorkspaceRoot, realPath);
		if (
			realRelative.startsWith(`..${sep}`) ||
			realRelative === ".." ||
			isAbsolute(realRelative)
		) {
			throw new Error(`${label} is outside the workspace root`);
		}
	}
}
