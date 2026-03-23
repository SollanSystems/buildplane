import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/**
 * Resolve a relative path within a worktree root, rejecting escapes.
 *
 * Rejects:
 * - Absolute paths
 * - Paths that normalize to `..` or traverse above the root
 * - Symlinks that resolve outside the root
 *
 * Returns the resolved absolute path on success.
 * Throws on any sandbox violation.
 */
export function resolveSandboxedPath(
	worktreeRoot: string,
	relativePath: string,
	label: string,
	options?: { allowRoot?: boolean },
): string {
	if (isAbsolute(relativePath)) {
		throw new Error(`${label} must not be an absolute path`);
	}

	const normalizedRoot = resolve(worktreeRoot);
	const normalizedRelative = normalize(relativePath);
	const resolvedPath = resolve(normalizedRoot, normalizedRelative);
	const rel = relative(normalizedRoot, resolvedPath);

	if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
		throw new Error(`${label} escapes the worktree root`);
	}

	if (rel === "" && !options?.allowRoot) {
		throw new Error(`${label} must not be the worktree root itself`);
	}

	// Walk each segment to detect symlinks that escape
	let currentPath = normalizedRoot;
	for (const segment of normalizedRelative.split(/[\\/]+/).filter(Boolean)) {
		currentPath = resolve(currentPath, segment);
		if (!existsSync(currentPath)) {
			break;
		}

		const stat = lstatSync(currentPath);
		if (stat.isSymbolicLink()) {
			const realTarget = realpathSync(currentPath);
			const realRel = relative(normalizedRoot, realTarget);
			if (
				realRel.startsWith(`..${sep}`) ||
				realRel === ".." ||
				isAbsolute(realRel)
			) {
				throw new Error(
					`${label} traverses a symlink that escapes the worktree root`,
				);
			}
		}
	}

	return resolvedPath;
}
