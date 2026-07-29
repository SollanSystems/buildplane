import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { GovernedRepositoryBindingPort } from "@buildplane/kernel";

const REPOSITORY_BINDING_DOMAIN = "buildplane.repository-binding.v1\0";
const ORIGIN_URL_DOMAIN = "buildplane.repository-origin.v1\0";
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT_OBJECT_FORMATS = new Set(["sha1", "sha256"]);
const GOVERNED_GIT_FIXED_OPTIONS = [
	"--no-optional-locks",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"commit.gpgSign=false",
	"-c",
	"gpg.program=false",
	"-c",
	"gpg.ssh.program=false",
	"-c",
	"diff.external=false",
] as const;

/**
 * Canonical, privacy-preserving repository identity for governed V3 dispatch.
 *
 * The target ref and Git common directory make a same-commit clone distinct
 * from the admitted repository. The origin URL is represented only by a
 * domain-separated digest so a signed tape never exposes a credential-bearing
 * remote URL.
 */
export interface GovernedRepositoryBindingV1 {
	readonly schemaVersion: 1;
	readonly repositoryRoot: string;
	readonly gitCommonDir: string;
	readonly objectFormat: "sha1" | "sha256";
	readonly targetRef: string;
	readonly originUrlDigest: string | null;
}

export interface CreateGovernedRepositoryBindingPortOptions {
	/** Injectable only for focused tests. Production always interrogates Git. */
	readonly resolveBinding?: (
		projectRoot: string,
	) => Readonly<GovernedRepositoryBindingV1>;
}

/** Compute the exact binding that must equal the signed V3 envelope field. */
export function computeGovernedRepositoryBinding(
	projectRoot: string,
): Readonly<GovernedRepositoryBindingV1> {
	const requestedRoot = canonicalGitPath(
		requireAbsoluteProjectRoot(projectRoot),
		"requested project root",
	);
	const repositoryRoot = canonicalGitPath(
		git(requestedRoot, ["rev-parse", "--show-toplevel"]),
		"repository root",
	);
	const relativeToRepository = relative(repositoryRoot, requestedRoot);
	if (
		relativeToRepository === ".." ||
		relativeToRepository.startsWith(
			`..${process.platform === "win32" ? "\\" : "/"}`,
		) ||
		isAbsolute(relativeToRepository)
	) {
		throw new Error(
			"governed repository binding Git top-level is not the requested projectRoot or one of its ancestors.",
		);
	}
	const commonDirRaw = git(repositoryRoot, ["rev-parse", "--git-common-dir"]);
	const gitCommonDir = canonicalGitPath(
		isAbsolute(commonDirRaw)
			? commonDirRaw
			: resolve(repositoryRoot, commonDirRaw),
		"git common directory",
	);
	const objectFormatRaw = git(repositoryRoot, [
		"rev-parse",
		"--show-object-format",
	]);
	if (!COMMIT_OBJECT_FORMATS.has(objectFormatRaw)) {
		throw new Error(
			`governed repository binding rejected unsupported Git object format ${JSON.stringify(objectFormatRaw)}.`,
		);
	}
	const targetRef = git(repositoryRoot, ["symbolic-ref", "-q", "HEAD"]);
	if (
		!targetRef.startsWith("refs/heads/") ||
		targetRef.length <= "refs/heads/".length
	) {
		throw new Error(
			"governed repository binding requires an attached local branch under refs/heads/.",
		);
	}
	const originUrl = optionalGit(repositoryRoot, [
		"config",
		"--get",
		"remote.origin.url",
	]);
	return Object.freeze({
		schemaVersion: 1,
		repositoryRoot,
		gitCommonDir,
		objectFormat: objectFormatRaw as "sha1" | "sha256",
		targetRef,
		originUrlDigest:
			originUrl === undefined
				? null
				: sha256(`${ORIGIN_URL_DOMAIN}${originUrl}`),
	});
}

export function canonicalGovernedRepositoryBindingDigest(
	binding: Readonly<GovernedRepositoryBindingV1>,
): string {
	assertBindingShape(binding);
	return sha256(
		`${REPOSITORY_BINDING_DOMAIN}${JSON.stringify({
			schema_version: binding.schemaVersion,
			repository_root: binding.repositoryRoot,
			git_common_dir: binding.gitCommonDir,
			object_format: binding.objectFormat,
			target_ref: binding.targetRef,
			origin_url_digest: binding.originUrlDigest,
		})}`,
	);
}

export function computeGovernedRepositoryBindingDigest(
	projectRoot: string,
): string {
	return canonicalGovernedRepositoryBindingDigest(
		computeGovernedRepositoryBinding(projectRoot),
	);
}

/**
 * Kernel seam used before worktree creation. A caller-supplied V3 dispatch
 * cannot select a different repository merely because it shares the base SHA.
 */
export function createGovernedRepositoryBindingPort(
	options: CreateGovernedRepositoryBindingPortOptions = {},
): GovernedRepositoryBindingPort {
	const resolver = options.resolveBinding ?? computeGovernedRepositoryBinding;
	if (typeof resolver !== "function") {
		throw new TypeError(
			"governed repository binding resolver must be a function.",
		);
	}
	return Object.freeze({
		assertDispatchRepositoryBinding({
			projectRoot,
			dispatch,
		}: Parameters<
			GovernedRepositoryBindingPort["assertDispatchRepositoryBinding"]
		>[0]): void {
			const expected = canonicalGovernedRepositoryBindingDigest(
				resolver(projectRoot),
			);
			if (
				typeof dispatch.repositoryBindingDigest !== "string" ||
				!SHA256_DIGEST.test(dispatch.repositoryBindingDigest)
			) {
				throw new TypeError(
					"governed dispatch repositoryBindingDigest must be a canonical sha256 digest.",
				);
			}
			if (dispatch.repositoryBindingDigest !== expected) {
				throw new Error(
					"governed dispatch repository binding does not match the local target repository; no workspace or candidate may be created.",
				);
			}
		},
	});
}

function requireAbsoluteProjectRoot(projectRoot: string): string {
	if (
		typeof projectRoot !== "string" ||
		projectRoot.length === 0 ||
		projectRoot.includes("\0") ||
		!isAbsolute(projectRoot)
	) {
		throw new TypeError(
			"governed repository binding project root must be a non-empty absolute path.",
		);
	}
	return projectRoot;
}

function canonicalGitPath(path: string, label: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		throw new Error(
			`governed repository binding could not canonicalize ${label}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function git(projectRoot: string, args: readonly string[]): string {
	try {
		const output = execFileSync(
			governedGitExecutable(),
			[...GOVERNED_GIT_FIXED_OPTIONS, "-C", projectRoot, ...args],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				env: governedGitEnvironment(),
			},
		);
		const value = output.trim();
		if (value.length === 0) {
			throw new Error("Git returned an empty value.");
		}
		return value;
	} catch (error) {
		throw new Error(
			`governed repository binding Git query failed (${args.join(" ")}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function optionalGit(
	projectRoot: string,
	args: readonly string[],
): string | undefined {
	try {
		const output = execFileSync(
			governedGitExecutable(),
			[...GOVERNED_GIT_FIXED_OPTIONS, "-C", projectRoot, ...args],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				env: governedGitEnvironment(),
			},
		);
		const value = output.trim();
		return value.length === 0 ? undefined : value;
	} catch (error) {
		const status = (error as { readonly status?: unknown }).status;
		if (status === 1) {
			return undefined;
		}
		throw new Error(
			`governed repository binding Git query failed (${args.join(" ")}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * The governed lane is Linux/WSL-only. It does not resolve `git` through an
 * attacker-controlled PATH; raw/development workflows retain their normal
 * host command discovery separately.
 */
function governedGitExecutable(): string {
	if (process.platform !== "linux") {
		throw new Error(
			"governed repository binding requires Linux/WSL with the host-pinned /usr/bin/git executable.",
		);
	}
	const executable = "/usr/bin/git";
	try {
		const resolved = realpathSync(executable);
		if (!statSync(resolved).isFile()) {
			throw new Error("must resolve to a regular file");
		}
		return resolved;
	} catch (error) {
		throw new Error(
			`governed repository binding requires a regular /usr/bin/git executable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function governedGitEnvironment(): NodeJS.ProcessEnv {
	// Do not derive this from process.env: preloaders, HOME, GIT_CONFIG_* and
	// credential variables are ambient authority even if Git itself is pinned.
	// Git receives only the locale/path/config controls needed for read-only
	// repository identity queries.
	return {
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TZ: "UTC",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function assertBindingShape(
	binding: Readonly<GovernedRepositoryBindingV1>,
): void {
	if (!binding || typeof binding !== "object") {
		throw new TypeError("governed repository binding must be an object.");
	}
	if (binding.schemaVersion !== 1) {
		throw new TypeError("governed repository binding schemaVersion must be 1.");
	}
	for (const [name, value] of [
		["repositoryRoot", binding.repositoryRoot],
		["gitCommonDir", binding.gitCommonDir],
		["targetRef", binding.targetRef],
	] as const) {
		if (
			typeof value !== "string" ||
			value.length === 0 ||
			value.includes("\0")
		) {
			throw new TypeError(
				`governed repository binding ${name} must be non-empty.`,
			);
		}
	}
	if (!COMMIT_OBJECT_FORMATS.has(binding.objectFormat)) {
		throw new TypeError(
			"governed repository binding has an unsupported object format.",
		);
	}
	if (!binding.targetRef.startsWith("refs/heads/")) {
		throw new TypeError(
			"governed repository binding targetRef must be a local branch.",
		);
	}
	if (
		binding.originUrlDigest !== null &&
		(typeof binding.originUrlDigest !== "string" ||
			!SHA256_DIGEST.test(binding.originUrlDigest))
	) {
		throw new TypeError(
			"governed repository binding originUrlDigest must be null or a canonical sha256 digest.",
		);
	}
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
