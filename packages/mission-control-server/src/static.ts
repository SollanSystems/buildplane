import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

export interface StaticAsset {
	readonly status: number;
	readonly body: Buffer;
	readonly contentType?: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".map": "application/json; charset=utf-8",
};

/**
 * Resolve a file from the `apps/web` build output. Returns undefined when no
 * web root is configured, the root does not exist, the request escapes the root,
 * or the target is not a regular file — the caller then answers 404.
 */
export function resolveStaticAsset(
	webRoot: string | undefined,
	pathname: string,
): StaticAsset | undefined {
	if (!webRoot || !existsSync(webRoot)) {
		return undefined;
	}

	const relativePath =
		pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const target = normalize(join(webRoot, relativePath));
	const root = normalize(webRoot);
	const rootBoundary = root.endsWith(sep) ? root : `${root}${sep}`;
	if (target !== root && !target.startsWith(rootBoundary)) {
		return undefined;
	}

	if (!existsSync(target) || !statSync(target).isFile()) {
		return undefined;
	}

	return {
		status: 200,
		body: readFileSync(target),
		contentType: CONTENT_TYPES[extname(target)],
	};
}
