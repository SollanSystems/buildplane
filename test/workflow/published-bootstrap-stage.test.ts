import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir as nodeOsTmpdir } from "node:os";
import { delimiter, dirname, join, relative, win32 } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

/**
 * Hardened tmpdir that falls back to /tmp when os.safeTmpdir() returns a
 * non-string value. This happens on some CI runners (GitHub Actions Ubuntu)
 * inside Vitest worker threads when running under the positive verifier.
 */
function safeTmpdir(): string {
	const dir = nodeOsTmpdir();
	if (
		typeof dir === "string" &&
		dir.length > 0 &&
		dir !== "undefined" &&
		existsSync(dir)
	) {
		return dir;
	}
	const fallback = process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp";
	return existsSync(fallback) ? fallback : dir;
}

const REQUIRED_BUILD_OUTPUTS = [
	"apps/cli/dist/index.js",
	"apps/cli/dist/run-cli.js",
	"apps/cli/dist/version-guard.js",
	"packages/kernel/dist/index.js",
	"packages/runtime/dist/index.js",
	"packages/policy/dist/index.js",
	"packages/storage/dist/index.js",
	"packages/adapters-git/dist/index.js",
	"packages/adapters-tools/dist/index.js",
	"packages/ledger-client/dist/index.js",
] as const;
const WORKSPACE_ROOTS = ["apps", "packages"] as const;
const BOOTSTRAP_TIMEOUT_MS = 60_000;

vi.setConfig({
	hookTimeout: BOOTSTRAP_TIMEOUT_MS,
	testTimeout: BOOTSTRAP_TIMEOUT_MS,
});

afterAll(() => {
	vi.resetConfig();
});

type InspectionResult = {
	inputPath: string;
	sourceType: "directory" | "tarball";
	packageRoot?: string;
};

function listWorkspaceBuildArtifacts(rootPath: string) {
	const artifacts: string[] = [];

	const visit = (currentPath: string) => {
		if (!existsSync(currentPath)) {
			return;
		}

		for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
			const entryPath = join(currentPath, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "dist") {
					artifacts.push(entryPath);
					continue;
				}

				visit(entryPath);
				continue;
			}

			if (entry.isFile() && entry.name === "tsconfig.tsbuildinfo") {
				artifacts.push(entryPath);
			}
		}
	};

	for (const workspaceRoot of WORKSPACE_ROOTS) {
		visit(join(rootPath, workspaceRoot));
	}

	return artifacts.sort();
}

function detectCreatedWorkspaceBuildArtifacts(
	rootPath: string,
	existingArtifacts: string[],
) {
	const existingArtifactSet = new Set(existingArtifacts);
	return listWorkspaceBuildArtifacts(rootPath)
		.filter((path) => !existingArtifactSet.has(path))
		.sort((left, right) => {
			const depthDifference =
				right.split(/[\\/]/).length - left.split(/[\\/]/).length;
			return depthDifference !== 0
				? depthDifference
				: right.localeCompare(left);
		});
}

function writeStubPackageManagerExecutable(
	binRoot: string,
	commandName: string,
	markerPath: string,
) {
	const executablePath = join(binRoot, commandName);
	mkdirSync(binRoot, { recursive: true });
	writeFileSync(
		executablePath,
		[
			"#!/usr/bin/env node",
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(markerPath)}, process.argv.slice(2).join(" "));`,
		].join("\n"),
	);
	chmodSync(executablePath, 0o755);
	return executablePath;
}

function listPublishedBootstrapTempDirs() {
	return readdirSync(safeTmpdir(), { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() && entry.name.startsWith("buildplane-published-"),
		)
		.map((entry) => join(safeTmpdir(), entry.name))
		.sort();
}

function collectRuntimeFilesWithSourceMapComments(rootPath: string) {
	const filesWithComments: string[] = [];
	const visit = (currentPath: string) => {
		if (!existsSync(currentPath)) {
			return;
		}

		for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
			const entryPath = join(currentPath, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
				continue;
			}

			if (!entry.isFile() || !entry.name.endsWith(".js")) {
				continue;
			}

			if (
				/\/\/# sourceMappingURL=.*\.map(?:\s*$)?/m.test(
					readFileSync(entryPath, "utf8"),
				)
			) {
				filesWithComments.push(entryPath);
			}
		}
	};

	visit(rootPath);
	return filesWithComments.sort();
}

function createTarHeader(
	path: string,
	body: Buffer,
	typeflag = "0",
	mode = 0o644,
	rawSizeField?: string,
) {
	const header = Buffer.alloc(512, 0);
	const writeTarString = (value: string, offset: number, length: number) => {
		header.write(value.slice(0, length), offset, length, "utf8");
	};
	const writeTarOctal = (value: number, offset: number, length: number) => {
		writeTarString(
			`${value.toString(8).padStart(length - 1, "0")}\0`,
			offset,
			length,
		);
	};

	writeTarString(path, 0, 100);
	writeTarOctal(mode, 100, 8);
	writeTarOctal(0, 108, 8);
	writeTarOctal(0, 116, 8);
	if (rawSizeField) {
		writeTarString(rawSizeField, 124, 12);
	} else {
		writeTarOctal(body.length, 124, 12);
	}
	writeTarOctal(0, 136, 12);
	header.fill(0x20, 148, 156);
	writeTarString(typeflag, 156, 1);
	writeTarString("ustar", 257, 6);
	writeTarString("00", 263, 2);

	const checksum = header.reduce((total, byte) => total + byte, 0);
	writeTarString(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);

	return header;
}

function createTarballBuffer(
	entries: Array<{
		path: string;
		body: string;
		mode?: number;
		typeflag?: string;
		padding?: Buffer;
		rawSizeField?: string;
	}>,
	options?: {
		trailingZeroBlocks?: number;
	},
) {
	const chunks: Buffer[] = [];

	for (const entry of entries) {
		const body = Buffer.from(entry.body, "utf8");
		chunks.push(
			createTarHeader(
				entry.path,
				body,
				entry.typeflag ?? "0",
				entry.mode ?? 0o644,
				entry.rawSizeField,
			),
			body,
		);

		const padding = (512 - (body.length % 512)) % 512;
		if (entry.padding) {
			chunks.push(entry.padding);
		} else if (padding > 0) {
			chunks.push(Buffer.alloc(padding, 0));
		}
	}

	chunks.push(Buffer.alloc((options?.trailingZeroBlocks ?? 2) * 512, 0));
	return gzipSync(Buffer.concat(chunks));
}

function createPaxRecord(key: string, value: string) {
	const payload = `${key}=${value}\n`;
	let recordLength = Buffer.byteLength(` ${payload}`, "utf8");

	while (true) {
		const record = `${recordLength} ${payload}`;
		const nextRecordLength = Buffer.byteLength(record, "utf8");
		if (nextRecordLength === recordLength) {
			return record;
		}

		recordLength = nextRecordLength;
	}
}

function corruptFirstTarHeaderChecksum(tarball: Buffer) {
	const archive = gunzipSync(tarball);
	archive.write("000001\0 ", 148, 8, "utf8");
	return gzipSync(archive);
}

function resolvePackageManagerCommand(
	packageManager: "pnpm" | "npm",
	platform: NodeJS.Platform = process.platform,
) {
	return platform === "win32" ? `${packageManager}.cmd` : packageManager;
}

function ensureWorkspaceBuildOutputs() {
	const existingBuildArtifacts = listWorkspaceBuildArtifacts(process.cwd());

	execFileSync(resolvePackageManagerCommand("pnpm"), ["build", "--force"], {
		cwd: process.cwd(),
		encoding: "utf8",
	});

	const stillMissing = REQUIRED_BUILD_OUTPUTS.filter(
		(path) => !existsSync(join(process.cwd(), path)),
	);
	if (stillMissing.length > 0) {
		throw new Error(
			`pnpm build did not create required published bootstrap outputs: ${stillMissing.join(", ")}`,
		);
	}

	return detectCreatedWorkspaceBuildArtifacts(
		process.cwd(),
		existingBuildArtifacts,
	);
}

function writeMinimalPublishedPackage(
	packageRoot: string,
	runtimeModulePath = "./cli.js",
	options: {
		readonly includeNative?: boolean;
	} = {},
) {
	mkdirSync(join(packageRoot, "dist"), { recursive: true });
	mkdirSync(join(packageRoot, "vendor"), { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		`${JSON.stringify(
			{
				name: "buildplane",
				version: "0.1.0",
				type: "module",
				bin: {
					buildplane: "./dist/index.js",
				},
				engines: {
					node: ">=24.13.1 <25",
				},
				files: ["README.md", "dist", "vendor"],
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(packageRoot, "README.md"),
		"npm install -g buildplane\nbuildplane init\n",
	);
	writeFileSync(
		join(packageRoot, "dist", "index.js"),
		[
			"#!/usr/bin/env node",
			'import { assertSupportedNodeVersion } from "./version-guard.js";',
			"assertSupportedNodeVersion();",
			`const cli = await import(${JSON.stringify(runtimeModulePath)});`,
			"export default cli;",
		].join("\n"),
	);
	chmodSync(join(packageRoot, "dist", "index.js"), 0o755);
	writeFileSync(
		join(packageRoot, "dist", "version-guard.js"),
		[
			"export function assertSupportedNodeVersion(current = process.versions.node) {",
			'\tif (current !== "24.13.1") {',
			'\t\tthrow new Error("Buildplane requires Node 24.13.1. Detected " + current + ".");',
			"\t}",
			"}",
		].join("\n"),
	);
	writeFileSync(
		join(packageRoot, "dist", runtimeModulePath.replace(/^\.\//, "")),
		"export {};\n",
	);

	if (options.includeNative ?? true) {
		const nativePath = join(
			packageRoot,
			"vendor",
			"native",
			"linux-x64",
			"buildplane-native",
		);
		mkdirSync(dirname(nativePath), { recursive: true });
		writeFileSync(nativePath, "#!/bin/sh\nexit 0\n");
		chmodSync(nativePath, 0o755);
	}
}

describe("workspace build artifact discovery", () => {
	it("finds dist roots and tsbuildinfo files for cleanup", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-artifacts-"),
		);

		try {
			mkdirSync(join(tempRoot, "apps", "cli", "dist"), { recursive: true });
			mkdirSync(join(tempRoot, "packages", "runtime", "dist"), {
				recursive: true,
			});
			mkdirSync(join(tempRoot, "packages", "runtime", "src"), {
				recursive: true,
			});
			writeFileSync(join(tempRoot, "apps", "cli", "tsconfig.tsbuildinfo"), "");
			writeFileSync(
				join(tempRoot, "packages", "runtime", "tsconfig.tsbuildinfo"),
				"",
			);
			writeFileSync(
				join(tempRoot, "packages", "runtime", "src", "index.ts"),
				"export {}\n",
			);

			expect(
				listWorkspaceBuildArtifacts(tempRoot).map((path) =>
					relative(tempRoot, path),
				),
			).toEqual([
				"apps/cli/dist",
				"apps/cli/tsconfig.tsbuildinfo",
				"packages/runtime/dist",
				"packages/runtime/tsconfig.tsbuildinfo",
			]);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});
});

describe("workspace build output preparation", () => {
	it.each([
		{ platform: "linux", packageManager: "pnpm", expected: "pnpm" },
		{ platform: "linux", packageManager: "npm", expected: "npm" },
		{ platform: "win32", packageManager: "pnpm", expected: "pnpm.cmd" },
		{ platform: "win32", packageManager: "npm", expected: "npm.cmd" },
	])("resolves $packageManager for $platform as $expected", ({
		expected,
		packageManager,
		platform,
	}) => {
		expect(resolvePackageManagerCommand(packageManager, platform)).toBe(
			expected,
		);
	});

	it("forces a fresh build even when the required published outputs already exist", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-build-invocation-"),
		);
		const binRoot = join(tempRoot, "bin");
		const buildMarkerPath = join(tempRoot, "build-invoked.txt");
		const originalCwd = process.cwd();
		const originalPath = process.env.PATH;

		try {
			for (const requiredOutput of REQUIRED_BUILD_OUTPUTS) {
				const outputPath = join(tempRoot, requiredOutput);
				mkdirSync(dirname(outputPath), { recursive: true });
				writeFileSync(outputPath, "already-built\n");
			}

			writeStubPackageManagerExecutable(binRoot, "pnpm", buildMarkerPath);
			process.chdir(tempRoot);
			process.env.PATH = [binRoot, originalPath ?? ""]
				.filter(Boolean)
				.join(delimiter);

			expect(ensureWorkspaceBuildOutputs()).toEqual([]);
			expect(readFileSync(buildMarkerPath, "utf8")).toBe("build --force");
		} finally {
			process.chdir(originalCwd);
			process.env.PATH = originalPath;
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("returns only build artifacts created by the fresh build for later cleanup", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-build-cleanup-"),
		);
		const binRoot = join(tempRoot, "bin");
		const buildMarkerPath = join(tempRoot, "build-invoked.txt");
		const originalCwd = process.cwd();
		const originalPath = process.env.PATH;
		const requiredOutputsLiteral = JSON.stringify([...REQUIRED_BUILD_OUTPUTS]);

		try {
			const executablePath = join(binRoot, "pnpm");
			mkdirSync(binRoot, { recursive: true });
			writeFileSync(
				executablePath,
				[
					"#!/usr/bin/env node",
					'import { mkdirSync, writeFileSync } from "node:fs";',
					'import { dirname, join } from "node:path";',
					`const requiredOutputs = ${requiredOutputsLiteral};`,
					`writeFileSync(${JSON.stringify(buildMarkerPath)}, process.argv.slice(2).join(" "));`,
					"for (const requiredOutput of requiredOutputs) {",
					"const outputPath = join(process.cwd(), requiredOutput);",
					"mkdirSync(dirname(outputPath), { recursive: true });",
					'writeFileSync(outputPath, "fresh-build\\n");',
					"}",
					'writeFileSync(join(process.cwd(), "apps", "cli", "tsconfig.tsbuildinfo"), "{}\\n");',
					'writeFileSync(join(process.cwd(), "packages", "kernel", "tsconfig.tsbuildinfo"), "{}\\n");',
				].join("\n"),
			);
			chmodSync(executablePath, 0o755);
			process.chdir(tempRoot);
			process.env.PATH = [binRoot, originalPath ?? ""]
				.filter(Boolean)
				.join(delimiter);

			expect(
				ensureWorkspaceBuildOutputs()
					.map((path) => {
						const normalizedPath = path.replaceAll("\\", "/");
						const appsIndex = normalizedPath.indexOf("/apps/");
						if (appsIndex >= 0) {
							return normalizedPath.slice(appsIndex + 1);
						}

						const packagesIndex = normalizedPath.indexOf("/packages/");
						if (packagesIndex >= 0) {
							return normalizedPath.slice(packagesIndex + 1);
						}

						return normalizedPath;
					})
					.sort(),
			).toEqual([
				"apps/cli/dist",
				"apps/cli/tsconfig.tsbuildinfo",
				"packages/adapters-git/dist",
				"packages/adapters-tools/dist",
				"packages/kernel/dist",
				"packages/kernel/tsconfig.tsbuildinfo",
				"packages/ledger-client/dist",
				"packages/policy/dist",
				"packages/runtime/dist",
				"packages/storage/dist",
			]);
			expect(readFileSync(buildMarkerPath, "utf8")).toBe("build --force");
		} finally {
			process.chdir(originalCwd);
			process.env.PATH = originalPath;
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});
});

describe("published bootstrap staging", () => {
	let derivePublishedReadme: (sourceReadme?: string) => string;
	let stagePublishedPackage: () => {
		stagingRoot: string;
		packageRoot: string;
	};
	let inspectPublishedPackage: (
		inputPath: string,
		options?: {
			arch?: string;
			platform?: NodeJS.Platform;
		},
	) => InspectionResult;
	let assertRuntimeImportClosure: (
		entryFilePaths: string[],
		options?: Record<string, unknown>,
	) => string[];
	let isPathWithinRootBoundary: (
		rootPath: string,
		candidatePath: string,
		pathImplementation?: {
			isAbsolute(path: string): boolean;
			relative(from: string, to: string): string;
			resolve(...paths: string[]): string;
		},
	) => boolean;
	let extractTarballToDirectory: (
		tarballPath: string,
		extractionRoot: string,
	) => void;
	const cleanupPaths: string[] = [];
	const hiddenBuildOutputs: Array<{
		originalPath: string;
		hiddenPath: string;
	}> = [];
	const originalPublishedNativeBin =
		process.env.BUILDPLANE_PUBLISHED_NATIVE_BIN;
	let fakePublishedNativeRoot: string | undefined;
	let buildArtifactsCreatedByTest: string[] = [];

	afterEach(() => {
		while (hiddenBuildOutputs.length > 0) {
			const hiddenOutput = hiddenBuildOutputs.pop();
			if (hiddenOutput) {
				renameSync(hiddenOutput.hiddenPath, hiddenOutput.originalPath);
			}
		}

		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path) {
				rmSync(path, { force: true, recursive: true });
			}
		}
	});

	afterAll(() => {
		if (originalPublishedNativeBin === undefined) {
			delete process.env.BUILDPLANE_PUBLISHED_NATIVE_BIN;
		} else {
			process.env.BUILDPLANE_PUBLISHED_NATIVE_BIN = originalPublishedNativeBin;
		}
		if (fakePublishedNativeRoot) {
			rmSync(fakePublishedNativeRoot, { force: true, recursive: true });
		}
		for (const path of buildArtifactsCreatedByTest) {
			rmSync(path, { force: true, recursive: true });
		}
	});

	beforeAll(async () => {
		buildArtifactsCreatedByTest = ensureWorkspaceBuildOutputs();
		fakePublishedNativeRoot = mkdtempSync(
			join(safeTmpdir(), "buildplane-published-native-fixture-"),
		);
		const fakeNativeBin = join(fakePublishedNativeRoot, "buildplane-native");
		writeFileSync(
			fakeNativeBin,
			'#!/bin/sh\nprintf \'{"ok":true,"fixture":"published-native"}\\n\'\n',
		);
		chmodSync(fakeNativeBin, 0o755);
		process.env.BUILDPLANE_PUBLISHED_NATIVE_BIN = fakeNativeBin;

		const readmeModule = await import(
			"../../scripts/published-bootstrap/readme.mjs"
		);
		derivePublishedReadme = readmeModule.derivePublishedReadme;

		const stageModule = await import(
			"../../scripts/published-bootstrap/stage-package.mjs"
		);
		stagePublishedPackage = stageModule.stagePublishedPackage;

		const inspectModule = await import(
			"../../scripts/published-bootstrap/inspect-package.mjs"
		);
		inspectPublishedPackage = inspectModule.inspectPublishedPackage;

		const runtimeClosureModule = await import(
			"../../scripts/published-bootstrap/runtime-closure.mjs"
		);
		assertRuntimeImportClosure =
			runtimeClosureModule.assertRuntimeImportClosure;
		isPathWithinRootBoundary = runtimeClosureModule.isPathWithinRootBoundary;

		const tarballModule = await import(
			"../../scripts/published-bootstrap/tarball.mjs"
		);
		extractTarballToDirectory = tarballModule.extractTarballToDirectory;
	}, 60_000);

	it("derives a publish-facing README from the repo-root structure without repo leakage", () => {
		const sourceReadme = readFileSync(join(process.cwd(), "README.md"), "utf8");
		const publishedReadme = derivePublishedReadme(sourceReadme);

		expect(publishedReadme).toContain("Buildplane by **SollanSystems**");
		expect(publishedReadme).toContain("## Why Buildplane");
		expect(publishedReadme).toContain("## Distribution");
		expect(publishedReadme).toContain(
			'tmp="$(mktemp)" && curl -fsSL https://raw.githubusercontent.com/SollanSystems/buildplane/main/scripts/published-bootstrap/install.sh -o "$tmp" && bash "$tmp"',
		);
		expect(publishedReadme).toContain("npm install -g buildplane");
		expect(publishedReadme).toContain("buildplane bootstrap doctor --json");
		expect(publishedReadme).toContain("buildplane init");
		expect(publishedReadme).toContain(
			"Published/global native memory is packaged and verified on Linux x64.",
		);
		expect(publishedReadme).toContain("buildplane memory doctor --json");
		expect(publishedReadme).toContain(
			"buildplane run --packet /absolute/path/to/packet.json",
		);
		expect(publishedReadme).not.toContain(
			"buildplane run --packet ./packet.json",
		);
		expect(publishedReadme).not.toContain("## Status");
		expect(publishedReadme).not.toContain("Milestone 1");
		expect(publishedReadme).not.toContain(
			"## Getting started (repo development)",
		);
		expect(publishedReadme).not.toContain("## In-repo built CLI path");
		expect(publishedReadme).not.toContain("## Local run loop");
		expect(publishedReadme).not.toContain("pnpm buildplane");
	});

	it("replaces the root Distribution section while preserving later publish-facing sections", () => {
		const sourceReadme = [
			"# Buildplane",
			"",
			"High-level context.",
			"",
			"## Why Buildplane",
			"",
			"Because control matters.",
			"",
			"## Status",
			"",
			"Milestone 1 is still focused on the execution kernel.",
			"",
			"## Getting started (repo development)",
			"",
			"pnpm buildplane init",
			"",
			"## In-repo built CLI path",
			"",
			"node apps/cli/dist/index.js init",
			"",
			"## Distribution",
			"",
			"> Published distribution is not yet available.",
			"",
			"## Operator workflow",
			"",
			"Run \\`buildplane status --json\\` after installation.",
		].join("\n");

		const publishedReadme = derivePublishedReadme(sourceReadme);

		expect(publishedReadme).toContain("High-level context.");
		expect(publishedReadme).toContain("## Distribution");
		expect(publishedReadme).toContain("npm install -g buildplane");
		expect(publishedReadme).toMatch(
			/## Distribution[\s\S]*npm install -g buildplane[\s\S]*## Operator workflow/,
		);
		expect(publishedReadme).toContain(
			"Run \\`buildplane status --json\\` after installation.",
		);
		expect(publishedReadme).not.toContain("## Status");
		expect(publishedReadme).not.toContain(
			"## Getting started (repo development)",
		);
		expect(publishedReadme).not.toContain("## In-repo built CLI path");
		expect(publishedReadme).not.toContain("not yet available");
		expect(publishedReadme).not.toContain("## Install globally");
	});

	it("stages the compiled package outside the repo and rewrites internal runtime imports", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		expect(staged.packageRoot.startsWith(process.cwd())).toBe(false);

		const pkg = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as {
			name?: string;
			private?: boolean;
			bin?: Record<string, string>;
		};
		const stagedReadme = readFileSync(
			join(staged.packageRoot, "README.md"),
			"utf8",
		);
		const stagedIndex = readFileSync(
			join(staged.packageRoot, "dist", "index.js"),
			"utf8",
		);
		const stagedRunCli = readFileSync(
			join(staged.packageRoot, "dist", "run-cli.js"),
			"utf8",
		);
		const stagedEntryMode =
			statSync(join(staged.packageRoot, "dist", "index.js")).mode & 0o111;

		expect(pkg.name).toBe("buildplane");
		expect(pkg.private).toBeUndefined();
		expect(pkg.bin?.buildplane).toBe("./dist/index.js");
		expect(existsSync(join(staged.packageRoot, "dist", "index.js"))).toBe(true);
		expect(existsSync(join(staged.packageRoot, "dist", "cli.js"))).toBe(true);
		expect(existsSync(join(staged.packageRoot, "dist", "cli-main.js"))).toBe(
			false,
		);
		expect(stagedIndex).toContain(
			'import { assertSupportedNodeVersion } from "./version-guard.js";',
		);
		expect(stagedIndex).toContain("assertSupportedNodeVersion();");
		expect(stagedIndex).toContain('const cli = await import("./cli.js");');
		expect(
			existsSync(
				join(staged.packageRoot, "vendor", "@buildplane", "kernel", "index.js"),
			),
		).toBe(true);
		expect(
			existsSync(
				join(
					staged.packageRoot,
					"vendor",
					"@buildplane",
					"adapters-tools",
					"index.js",
				),
			),
		).toBe(true);
		expect(
			existsSync(
				join(
					staged.packageRoot,
					"vendor",
					"@buildplane",
					"ledger-client",
					"index.js",
				),
			),
		).toBe(true);
		expect(stagedReadme).not.toContain("pnpm buildplane");
		expect(stagedRunCli).toContain("../vendor/@buildplane/kernel/index.js");
		expect(stagedRunCli).toContain(
			"../vendor/@buildplane/adapters-tools/index.js",
		);
		expect(stagedRunCli).toContain(
			"../vendor/@buildplane/ledger-client/index.js",
		);
		expect(stagedRunCli).not.toContain('import("@buildplane/kernel")');
		expect(stagedEntryMode).not.toBe(0);
		expect(
			existsSync(
				join(
					staged.packageRoot,
					"vendor",
					"native",
					"linux-x64",
					"buildplane-native",
				),
			),
		).toBe(true);
	}, 60_000);

	it("strips stale sourceMappingURL comments from staged runtime modules", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		const runtimeFilesWithSourceMapComments =
			collectRuntimeFilesWithSourceMapComments(staged.packageRoot).map((path) =>
				relative(staged.packageRoot, path),
			);

		expect(runtimeFilesWithSourceMapComments).toEqual([]);
	});

	it("falls back to a staging temp root outside the checkout when TMPDIR points inside it", () => {
		const originalTmpdir = process.env.TMPDIR;
		const inRepoTmpdir = join(
			process.cwd(),
			"published-bootstrap-stage-tmp-root",
		);

		mkdirSync(inRepoTmpdir, { recursive: true });
		cleanupPaths.push(inRepoTmpdir);

		try {
			process.env.TMPDIR = inRepoTmpdir;
			const staged = stagePublishedPackage();
			cleanupPaths.push(staged.stagingRoot);

			expect(isPathWithinRootBoundary(process.cwd(), staged.stagingRoot)).toBe(
				false,
			);
			expect(isPathWithinRootBoundary(inRepoTmpdir, staged.stagingRoot)).toBe(
				false,
			);
		} finally {
			process.env.TMPDIR = originalTmpdir;
		}
	});

	it("rewrites side-effect, export-from, and dynamic internal runtime imports without touching incidental text", () => {
		const cliMainPath = join(
			process.cwd(),
			"apps",
			"cli",
			"dist",
			"cli-main.js",
		);
		const fixturePath = join(
			process.cwd(),
			"apps",
			"cli",
			"dist",
			"rewrite-fixture.js",
		);
		const originalCliMain = readFileSync(cliMainPath, "utf8");

		try {
			writeFileSync(
				fixturePath,
				[
					'import "@buildplane/kernel";',
					'export * from "@buildplane/policy";',
					'export { createCommandExecutor } from "@buildplane/runtime";',
					'const loadStorage = () => import("@buildplane/storage");',
					'const loadStorageWithOptions = (options) => import("@buildplane/storage", options);',
					"const fromText = 'This string says from \"@buildplane/kernel\".';",
					"const dynamicText = 'This string says import(\"@buildplane/storage\").';",
					'// from "@buildplane/policy" should stay in comments.',
					'// import("@buildplane/runtime") should stay in comments.',
					"export { loadStorage, loadStorageWithOptions, fromText, dynamicText };",
				].join("\n"),
			);
			writeFileSync(
				cliMainPath,
				`${originalCliMain}\nimport "./rewrite-fixture.js";\n`,
			);

			const staged = stagePublishedPackage();
			cleanupPaths.push(staged.stagingRoot);

			const stagedFixture = readFileSync(
				join(staged.packageRoot, "dist", "rewrite-fixture.js"),
				"utf8",
			);

			expect(stagedFixture).toContain(
				'import "../vendor/@buildplane/kernel/index.js";',
			);
			expect(stagedFixture).toContain(
				'export * from "../vendor/@buildplane/policy/index.js";',
			);
			expect(stagedFixture).toContain(
				'export { createCommandExecutor } from "../vendor/@buildplane/runtime/index.js";',
			);
			expect(stagedFixture).toContain(
				'const loadStorage = () => import("../vendor/@buildplane/storage/index.js");',
			);
			expect(stagedFixture).toContain(
				'const loadStorageWithOptions = (options) => import("../vendor/@buildplane/storage/index.js", options);',
			);
			expect(stagedFixture).toContain(
				"const fromText = 'This string says from \"@buildplane/kernel\".';",
			);
			expect(stagedFixture).toContain(
				"const dynamicText = 'This string says import(\"@buildplane/storage\").';",
			);
			expect(stagedFixture).toContain(
				'// from "@buildplane/policy" should stay in comments.',
			);
			expect(stagedFixture).toContain(
				'// import("@buildplane/runtime") should stay in comments.',
			);
			expect(inspectPublishedPackage(staged.packageRoot)).toEqual({
				inputPath: staged.packageRoot,
				packageRoot: staged.packageRoot,
				sourceType: "directory",
			});
		} finally {
			writeFileSync(cliMainPath, originalCliMain);
			rmSync(fixturePath, { force: true });
		}
	});

	it("fails staging when a transitive compiled runtime dependency is missing", () => {
		const missingRuntimePath = join(
			process.cwd(),
			"packages",
			"kernel",
			"dist",
			"workspace-paths.js",
		);
		const hiddenPath = `${missingRuntimePath}.published-bootstrap-hidden`;
		renameSync(missingRuntimePath, hiddenPath);
		hiddenBuildOutputs.push({
			originalPath: missingRuntimePath,
			hiddenPath,
		});

		expect(() => stagePublishedPackage()).toThrow(/workspace-paths\.js/);
	});

	it("fails staging when the runtime closure reaches a symlinked JavaScript file", () => {
		const cliMainPath = join(
			process.cwd(),
			"apps",
			"cli",
			"dist",
			"cli-main.js",
		);
		const symlinkPath = join(
			process.cwd(),
			"apps",
			"cli",
			"dist",
			"symlinked-runtime.js",
		);
		const originalCliMain = readFileSync(cliMainPath, "utf8");
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-symlink-stage-"),
		);
		const escapedRuntimePath = join(tempRoot, "escaped-runtime.js");
		cleanupPaths.push(tempRoot);

		try {
			writeFileSync(escapedRuntimePath, "export const escaped = true;\n");
			symlinkSync(escapedRuntimePath, symlinkPath, "file");
			writeFileSync(
				cliMainPath,
				`${originalCliMain}\nimport "./symlinked-runtime.js";\n`,
			);

			expect(() => stagePublishedPackage()).toThrow(/symlink/i);
		} finally {
			writeFileSync(cliMainPath, originalCliMain);
			rmSync(symlinkPath, { force: true });
		}
	});

	it("ignores unreachable compiled runtime files outside the CLI closure", () => {
		const brokenExtraRuntimePath = join(
			process.cwd(),
			"packages",
			"kernel",
			"dist",
			"orphan-runtime.js",
		);
		writeFileSync(
			brokenExtraRuntimePath,
			'import "./missing-runtime.js";\nexport const orphanRuntime = true;\n',
		);
		cleanupPaths.push(brokenExtraRuntimePath);

		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		expect(
			existsSync(
				join(
					staged.packageRoot,
					"vendor",
					"@buildplane",
					"kernel",
					"orphan-runtime.js",
				),
			),
		).toBe(false);
	});

	it("rejects runtime imports that resolve outside their configured root boundary", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-root-"),
		);

		try {
			const runtimeRoot = join(tempRoot, "dist");
			const entryPath = join(runtimeRoot, "index.js");
			const leakedPath = join(tempRoot, "escape.js");

			mkdirSync(runtimeRoot, { recursive: true });
			writeFileSync(leakedPath, "export const leaked = true;\n");
			writeFileSync(entryPath, 'import "../escape.js";\n');

			expect(() =>
				assertRuntimeImportClosure([entryPath], {
					rootBoundaryPaths: [runtimeRoot],
				}),
			).toThrow(/outside.*runtime root/i);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("treats symlinked-directory ancestor escapes as outside the runtime root boundary", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-realpath-"),
		);

		try {
			const runtimeRoot = join(tempRoot, "dist");
			const escapedRoot = join(tempRoot, "escaped");
			const symlinkedDirectory = join(runtimeRoot, "linked");
			const escapedPath = join(symlinkedDirectory, "escape.js");

			mkdirSync(runtimeRoot, { recursive: true });
			mkdirSync(escapedRoot, { recursive: true });
			writeFileSync(
				join(escapedRoot, "escape.js"),
				"export const leaked = true;\n",
			);
			symlinkSync(escapedRoot, symlinkedDirectory, "dir");

			expect(isPathWithinRootBoundary(runtimeRoot, escapedPath)).toBe(false);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects runtime imports that escape through symlinked directory ancestors", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-symlink-dir-"),
		);

		try {
			const runtimeRoot = join(tempRoot, "dist");
			const entryPath = join(runtimeRoot, "index.js");
			const escapedRoot = join(tempRoot, "escaped");
			const symlinkedDirectory = join(runtimeRoot, "linked");

			mkdirSync(runtimeRoot, { recursive: true });
			mkdirSync(escapedRoot, { recursive: true });
			writeFileSync(
				join(escapedRoot, "escape.js"),
				"export const leaked = true;\n",
			);
			symlinkSync(escapedRoot, symlinkedDirectory, "dir");
			writeFileSync(entryPath, 'import "./linked/escape.js";\n');

			expect(() =>
				assertRuntimeImportClosure([entryPath], {
					rootBoundaryPaths: [runtimeRoot],
				}),
			).toThrow(/symlinked path segment|outside.*runtime root/i);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects runtime imports that traverse a symlinked directory segment even when the target stays inside the runtime root", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-symlink-segment-"),
		);

		try {
			const runtimeRoot = join(tempRoot, "dist");
			const entryPath = join(runtimeRoot, "index.js");
			const realDirectory = join(runtimeRoot, "real");
			const symlinkedDirectory = join(runtimeRoot, "linked");

			mkdirSync(realDirectory, { recursive: true });
			writeFileSync(
				join(realDirectory, "nested.js"),
				"export const nested = true;\n",
			);
			symlinkSync(realDirectory, symlinkedDirectory, "dir");
			writeFileSync(entryPath, 'import "./linked/nested.js";\n');

			expect(() =>
				assertRuntimeImportClosure([entryPath], {
					rootBoundaryPaths: [runtimeRoot],
				}),
			).toThrow(/symlink/i);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("treats Windows cross-drive paths as outside the runtime root boundary", () => {
		expect(
			isPathWithinRootBoundary(
				"C:\\repo\\dist",
				"C:\\repo\\dist\\nested\\index.js",
				win32,
			),
		).toBe(true);
		expect(
			isPathWithinRootBoundary(
				"C:\\repo\\dist",
				"C:\\repo\\other\\index.js",
				win32,
			),
		).toBe(false);
		expect(
			isPathWithinRootBoundary(
				"C:\\repo\\dist",
				"D:\\repo\\dist\\nested\\index.js",
				win32,
			),
		).toBe(false);
	});

	it.each([
		"/tmp/buildplane-runtime-leak.js",
		"C:\\temp\\buildplane-runtime-leak.js",
		"\\\\server\\share\\buildplane-runtime-leak.js",
	])("rejects absolute filesystem runtime import specifiers (%s)", (specifier) => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-specifier-"),
		);

		try {
			const runtimeRoot = join(tempRoot, "dist");
			const entryPath = join(runtimeRoot, "index.js");

			mkdirSync(runtimeRoot, { recursive: true });
			writeFileSync(entryPath, `import ${JSON.stringify(specifier)};\n`);

			expect(() =>
				assertRuntimeImportClosure([entryPath], {
					rootBoundaryPaths: [runtimeRoot],
				}),
			).toThrow(/absolute filesystem specifier/i);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("cleans up published staging temp directories when staging fails after creation", () => {
		const manifestPath = join(process.cwd(), "apps", "cli", "package.json");
		const hiddenPath = `${manifestPath}.published-bootstrap-hidden`;
		const beforeTempDirs = listPublishedBootstrapTempDirs();

		renameSync(manifestPath, hiddenPath);
		hiddenBuildOutputs.push({
			originalPath: manifestPath,
			hiddenPath,
		});

		expect(() => stagePublishedPackage()).toThrow(
			/apps[\\/]cli[\\/]package\.json/i,
		);
		expect(listPublishedBootstrapTempDirs()).toEqual(beforeTempDirs);
	});

	it("returns an honest directory inspection result", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		expect(inspectPublishedPackage(staged.packageRoot)).toEqual({
			inputPath: staged.packageRoot,
			packageRoot: staged.packageRoot,
			sourceType: "directory",
		});
	});

	it("rejects unexpected extra payload at the staged package root during directory inspection", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(join(staged.packageRoot, "LEAKED.txt"), "leaked payload\n");

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/unexpected staged package root payload.*LEAKED\.txt/i,
		);
	});

	it("accepts the boring staged wrapper contract with ./cli.js as its runtime boundary", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-boundary-"),
		);
		const packageRoot = join(tempRoot, "package");
		cleanupPaths.push(tempRoot);

		writeMinimalPublishedPackage(packageRoot);

		expect(inspectPublishedPackage(packageRoot)).toEqual({
			inputPath: packageRoot,
			packageRoot,
			sourceType: "directory",
		});
	});

	it("rejects a wrapper runtime boundary other than ./cli.js", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-boundary-invalid-"),
		);
		const packageRoot = join(tempRoot, "package");
		cleanupPaths.push(tempRoot);

		writeMinimalPublishedPackage(packageRoot, "./runtime-boundary.js");

		expect(() => inspectPublishedPackage(packageRoot)).toThrow(
			/dist[\\/]index\.js.*\.\/cli\.js|runtime boundary/i,
		);
	});

	it("fails linux-x64 inspection when the packaged native binary is missing", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-native-missing-"),
		);
		const packageRoot = join(tempRoot, "package");
		cleanupPaths.push(tempRoot);

		writeMinimalPublishedPackage(packageRoot, "./cli.js", {
			includeNative: false,
		});

		expect(() =>
			inspectPublishedPackage(packageRoot, { arch: "x64", platform: "linux" }),
		).toThrow(/missing packaged linux-x64 native binary/i);
	});

	it("fails linux-x64 inspection when the packaged native binary is not executable", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-native-mode-"),
		);
		const packageRoot = join(tempRoot, "package");
		cleanupPaths.push(tempRoot);

		writeMinimalPublishedPackage(packageRoot);
		chmodSync(
			join(packageRoot, "vendor", "native", "linux-x64", "buildplane-native"),
			0o644,
		);

		expect(() =>
			inspectPublishedPackage(packageRoot, { arch: "x64", platform: "linux" }),
		).toThrow(/packaged linux-x64 native binary must be executable/i);
	});

	it("inspects tarballs and returns the tarball input path", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		const tarballName = execFileSync(
			resolvePackageManagerCommand("npm"),
			["pack"],
			{
				cwd: staged.packageRoot,
				encoding: "utf8",
			},
		)
			.trim()
			.split("\n")
			.at(-1);
		const tarballPath = join(staged.packageRoot, tarballName ?? "");

		expect(tarballName).toBeTruthy();
		expect(inspectPublishedPackage(tarballPath)).toEqual({
			inputPath: tarballPath,
			sourceType: "tarball",
		});
	});

	it("inspects tarballs without requiring npm on PATH", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		const tarballName = execFileSync(
			resolvePackageManagerCommand("npm"),
			["pack"],
			{
				cwd: staged.packageRoot,
				encoding: "utf8",
			},
		)
			.trim()
			.split("\n")
			.at(-1);
		const tarballPath = join(staged.packageRoot, tarballName ?? "");
		const originalPathEnv = process.env.PATH;

		expect(tarballName).toBeTruthy();

		try {
			process.env.PATH = "";
			expect(inspectPublishedPackage(tarballPath)).toEqual({
				inputPath: tarballPath,
				sourceType: "tarball",
			});
		} finally {
			process.env.PATH = originalPathEnv;
		}
	});

	it("rejects tarballs with absolute entry paths", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-absolute-"),
		);
		const tarballPath = join(tempRoot, "absolute-entry.tgz");
		const extractionRoot = join(tempRoot, "extracted");

		try {
			writeFileSync(
				tarballPath,
				createTarballBuffer([
					{
						path: "/package/package.json",
						body: '{"name":"buildplane"}\n',
					},
				]),
			);

			expect(() =>
				extractTarballToDirectory(tarballPath, extractionRoot),
			).toThrow(/tar entry path must be relative/i);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects tarballs that would extract through a pre-existing symlinked ancestor under the extraction root", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-symlink-ancestor-"),
		);
		const tarballPath = join(tempRoot, "symlink-ancestor.tgz");
		const extractionRoot = join(tempRoot, "extracted");
		const escapedRoot = join(tempRoot, "escaped");
		const symlinkedAncestor = join(extractionRoot, "linked");

		try {
			mkdirSync(extractionRoot, { recursive: true });
			mkdirSync(escapedRoot, { recursive: true });
			symlinkSync(escapedRoot, symlinkedAncestor, "dir");
			writeFileSync(
				tarballPath,
				createTarballBuffer([
					{
						path: "linked/payload.txt",
						body: "escaped through symlink\n",
					},
				]),
			);

			expect(() =>
				extractTarballToDirectory(tarballPath, extractionRoot),
			).toThrow(/symlink/i);
			expect(existsSync(join(escapedRoot, "payload.txt"))).toBe(false);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects tarballs with extra top-level entries outside package/", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-top-level-"),
		);
		const tarballPath = join(tempRoot, "extra-top-level.tgz");

		try {
			writeFileSync(
				tarballPath,
				createTarballBuffer([
					{
						path: "package/package.json",
						body: `${JSON.stringify(
							{
								name: "buildplane",
								type: "module",
								bin: {
									buildplane: "./dist/index.js",
								},
								engines: {
									node: ">=24.13.1 <25",
								},
								files: ["README.md", "dist", "vendor"],
							},
							null,
							2,
						)}\n`,
					},
					{
						path: "package/README.md",
						body: "npm install -g buildplane\nbuildplane init\n",
					},
					{
						path: "package/dist/index.js",
						body: [
							"#!/usr/bin/env node",
							"assertSupportedNodeVersion();",
							'const cli = await import("./cli-main.js");',
							"export default cli;",
						].join("\n"),
						mode: 0o755,
					},
					{
						path: "package/dist/cli-main.js",
						body: "export {};\n",
					},
					{
						path: "README.md",
						body: "leaked top-level file\n",
					},
				]),
			);

			expect(() => inspectPublishedPackage(tarballPath)).toThrow(
				/top-level.*package\//i,
			);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects tarballs with malformed PAX headers whose declared record length overruns the available body", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-pax-"),
		);
		const tarballPath = join(tempRoot, "malformed-pax.tgz");
		const extractionRoot = join(tempRoot, "extracted");

		try {
			writeFileSync(
				tarballPath,
				createTarballBuffer([
					{
						path: "PaxHeader/package.json",
						typeflag: "x",
						body: "999 path=package/package.json\n",
					},
					{
						path: "placeholder-path",
						body: `${JSON.stringify(
							{
								name: "buildplane",
								type: "module",
								version: "0.1.0",
								bin: {
									buildplane: "./dist/index.js",
								},
								engines: {
									node: ">=24.13.1 <25",
								},
								files: ["README.md", "dist", "vendor"],
							},
							null,
							2,
						)}\n`,
					},
				]),
			);

			expect(() =>
				extractTarballToDirectory(tarballPath, extractionRoot),
			).toThrow(/malformed PAX header|tar-parse error/i);
			expect(() => inspectPublishedPackage(tarballPath)).toThrow(
				/Failed to extract tarball .*malformed PAX header|tar-parse error/i,
			);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects tarballs with malformed PAX length tokens that are not ASCII digits followed by a space", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-pax-length-"),
		);

		try {
			for (const testCase of [
				{
					name: "nondigit-length-token",
					body: "4x a\n",
				},
				{
					name: "missing-length-separator",
					body: "4a\n",
				},
			]) {
				const tarballPath = join(tempRoot, `${testCase.name}.tgz`);
				const extractionRoot = join(tempRoot, `${testCase.name}-extracted`);

				writeFileSync(
					tarballPath,
					createTarballBuffer([
						{
							path: "PaxHeader/package.json",
							typeflag: "x",
							body: testCase.body,
						},
						{
							path: "placeholder-path",
							body: '{"name":"buildplane"}\n',
						},
					]),
				);

				expect(() =>
					extractTarballToDirectory(tarballPath, extractionRoot),
				).toThrow(/PAX header length|separator|tar-parse error/i);
				expect(() => inspectPublishedPackage(tarballPath)).toThrow(
					/Failed to extract tarball .*PAX header length|separator|tar-parse error/i,
				);
			}
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("accepts tarballs with valid UTF-8 PAX headers whose record lengths count bytes, not characters", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-pax-utf8-"),
		);
		const tarballPath = join(tempRoot, "utf8-pax.tgz");
		const extractionRoot = join(tempRoot, "extracted");
		const paxHeaders = [
			createPaxRecord("path", "package/dist/cli.js"),
			createPaxRecord("comment", "mañana metadata"),
		].join("");

		try {
			writeFileSync(
				tarballPath,
				createTarballBuffer([
					{
						path: "package/package.json",
						body: `${JSON.stringify(
							{
								name: "buildplane",
								type: "module",
								version: "0.1.0",
								bin: {
									buildplane: "./dist/index.js",
								},
								engines: {
									node: ">=24.13.1 <25",
								},
								files: ["README.md", "dist", "vendor"],
							},
							null,
							2,
						)}\n`,
					},
					{
						path: "package/README.md",
						body: "npm install -g buildplane\nbuildplane init\n",
					},
					{
						path: "package/dist/index.js",
						body: [
							"#!/usr/bin/env node",
							'import { assertSupportedNodeVersion } from "./version-guard.js";',
							"assertSupportedNodeVersion();",
							'const cli = await import("./cli.js");',
							"export default cli;",
						].join("\n"),
						mode: 0o755,
					},
					{
						path: "package/dist/version-guard.js",
						body: [
							"export function assertSupportedNodeVersion(current = process.versions.node) {",
							'\tif (current !== "24.13.1") {',
							'\t\tthrow new Error("Buildplane requires Node 24.13.1. Detected " + current + ".");',
							"\t}",
							"}",
						].join("\n"),
					},
					{
						path: "PaxHeader/cafe.js",
						typeflag: "x",
						body: paxHeaders,
					},
					{
						path: "placeholder-path",
						body: "export const cliRuntime = true;\n",
					},
					{
						path: "package/vendor/native/linux-x64/buildplane-native",
						body: "#!/bin/sh\nexit 0\n",
						mode: 0o755,
					},
				]),
			);

			extractTarballToDirectory(tarballPath, extractionRoot);
			expect(
				readFileSync(join(extractionRoot, "package", "dist", "cli.js"), "utf8"),
			).toContain("cliRuntime");
			expect(inspectPublishedPackage(tarballPath)).toEqual({
				inputPath: tarballPath,
				sourceType: "tarball",
			});
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects tarballs with non-octal size fields", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-size-field-"),
		);
		const tarballPath = join(tempRoot, "non-octal-size.tgz");
		const extractionRoot = join(tempRoot, "extracted");

		try {
			writeFileSync(
				tarballPath,
				createTarballBuffer([
					{
						path: "package/package.json",
						body: '{"name":"buildplane"}\n',
						rawSizeField: "00000000009 ",
					},
				]),
			);

			expect(() =>
				extractTarballToDirectory(tarballPath, extractionRoot),
			).toThrow(/size field|octal|tar-parse error/i);
			expect(() => inspectPublishedPackage(tarballPath)).toThrow(
				/Failed to extract tarball .*size field|octal|tar-parse error/i,
			);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects tarballs with invalid ustar header checksums", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-checksum-"),
		);
		const tarballPath = join(tempRoot, "invalid-checksum.tgz");
		const extractionRoot = join(tempRoot, "extracted");

		try {
			writeFileSync(
				tarballPath,
				corruptFirstTarHeaderChecksum(
					createTarballBuffer([
						{
							path: "package/package.json",
							body: `${JSON.stringify(
								{
									name: "buildplane",
									type: "module",
									version: "0.1.0",
									bin: {
										buildplane: "./dist/index.js",
									},
									engines: {
										node: ">=24.13.1 <25",
									},
								},
								null,
								2,
							)}\n`,
						},
						{
							path: "package/README.md",
							body: "npm install -g buildplane\nbuildplane init\n",
						},
						{
							path: "package/dist/index.js",
							body: [
								"#!/usr/bin/env node",
								'import { assertSupportedNodeVersion } from "./version-guard.js";',
								"assertSupportedNodeVersion();",
								'const cli = await import("./cli.js");',
								"export default cli;",
							].join("\n"),
							mode: 0o755,
						},
						{
							path: "package/dist/version-guard.js",
							body: [
								"export function assertSupportedNodeVersion(current = process.versions.node) {",
								'\tif (current !== "24.13.1") {',
								'\t\tthrow new Error("Buildplane requires Node 24.13.1. Detected " + current + ".");',
								"\t}",
								"}",
							].join("\n"),
						},
						{
							path: "package/dist/cli.js",
							body: "export {};\n",
						},
					]),
				),
			);

			expect(() =>
				extractTarballToDirectory(tarballPath, extractionRoot),
			).toThrow(/checksum|ustar|tar-parse error/i);
			expect(() => inspectPublishedPackage(tarballPath)).toThrow(
				/Failed to extract tarball .*checksum|ustar|tar-parse error/i,
			);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects tarballs whose entry padding is truncated before the next block boundary", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-padding-"),
		);
		const tarballPath = join(tempRoot, "truncated-padding.tgz");
		const extractionRoot = join(tempRoot, "extracted");
		const body = '{"name":"buildplane"}\n';
		const expectedPaddingLength =
			(512 - (Buffer.byteLength(body, "utf8") % 512)) % 512;

		try {
			writeFileSync(
				tarballPath,
				createTarballBuffer(
					[
						{
							path: "package/package.json",
							body,
							padding: Buffer.alloc(Math.max(expectedPaddingLength - 1, 0), 0),
						},
					],
					{
						trailingZeroBlocks: 0,
					},
				),
			);

			expect(() =>
				extractTarballToDirectory(tarballPath, extractionRoot),
			).toThrow(/padding|block boundary|truncated|tar-parse error/i);
			expect(() => inspectPublishedPackage(tarballPath)).toThrow(
				/Failed to extract tarball .*padding|block boundary|truncated|tar-parse error/i,
			);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("rejects tarballs that omit the required trailing zero blocks", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-tarball-trailing-zeroes-"),
		);
		const tarballPath = join(tempRoot, "missing-zero-blocks.tgz");
		const extractionRoot = join(tempRoot, "extracted");

		try {
			writeFileSync(
				tarballPath,
				createTarballBuffer(
					[
						{
							path: "package/package.json",
							body: '{"name":"buildplane"}\n',
						},
					],
					{ trailingZeroBlocks: 1 },
				),
			);

			expect(() =>
				extractTarballToDirectory(tarballPath, extractionRoot),
			).toThrow(/trailing zero blocks|archive terminator|tar-parse error/i);
			expect(() => inspectPublishedPackage(tarballPath)).toThrow(
				/Failed to extract tarball .*trailing zero blocks|archive terminator|tar-parse error/i,
			);
		} finally {
			rmSync(tempRoot, { force: true, recursive: true });
		}
	});

	it("fails inspection when repo-dev pnpm guidance leaks into the staged README", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "README.md"),
			"npm install -g buildplane\nbuildplane init\nbuildplane run --packet ./packet.json\nbuildplane status --json\nbuildplane inspect <run-id> --json\npnpm buildplane init\n",
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/README\.md.*pnpm buildplane/i,
		);
	});

	it("fails inspection when repo-dev-only install or execution guidance leaks into the staged README", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		for (const leakedSnippet of [
			"pnpm install",
			"pnpm build",
			"This runs the CLI from TypeScript source via tsx.",
			"node apps/cli/dist/index.js init",
		]) {
			writeFileSync(
				join(staged.packageRoot, "README.md"),
				[
					"npm install -g buildplane",
					"buildplane init",
					"buildplane run --packet ./packet.json",
					"buildplane status --json",
					"buildplane inspect <run-id> --json",
					leakedSnippet,
				].join("\n"),
			);

			expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
				/README\.md.*(pnpm install|pnpm build|tsx|node apps\/cli\/dist\/index\.js)/i,
			);
		}
	});

	it("fails inspection when repo-status or milestone text leaks into the staged README", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "README.md"),
			[
				"# Buildplane",
				"",
				"Buildplane by **SollanSystems** is an operator-first execution system.",
				"",
				"## Status",
				"",
				"Milestone 1 is still focused on the execution kernel.",
				"",
				"## Install globally",
				"",
				"```bash",
				"npm install -g buildplane",
				"buildplane init",
				"```",
			].join("\n"),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/README\.md.*(repo-status|milestone|Status)/i,
		);
	});

	it("accepts a staged README with published install guidance without requiring the full operator command contract", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "README.md"),
			[
				"# Buildplane",
				"",
				"Install the published CLI with npm before running commands.",
				"",
				"```bash",
				"npm install -g buildplane",
				"buildplane init",
				"```",
			].join("\n"),
		);

		expect(inspectPublishedPackage(staged.packageRoot)).toEqual({
			inputPath: staged.packageRoot,
			packageRoot: staged.packageRoot,
			sourceType: "directory",
		});
	});

	it("fails inspection when the staged README omits published install guidance", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "README.md"),
			"Buildplane is published on npm. Run buildplane init after installation.\n",
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/README\.md.*npm install -g buildplane/i,
		);
	}, 60_000);

	it("wraps staged package.json parse failures with the offending path", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const manifestPath = join(staged.packageRoot, "package.json");

		writeFileSync(manifestPath, '{\n\t"name": "buildplane",\n\t"version": }\n');

		let message = "";
		try {
			inspectPublishedPackage(staged.packageRoot);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toMatch(/Failed to parse JSON file/i);
		expect(message).toContain(manifestPath);
	}, 60_000);

	it("rejects any present package.json.private value except explicit false", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...JSON.parse(
						readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
					),
					private: "false",
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.private must be absent or false/i,
		);
	});

	it.each([
		{
			label: "omits version",
			mutate: (manifest: Record<string, unknown>) => {
				const { version: _version, ...withoutVersion } = manifest;
				return withoutVersion;
			},
		},
		{
			label: "uses an invalid version",
			mutate: (manifest: Record<string, unknown>) => ({
				...manifest,
				version: "latest",
			}),
		},
	])("rejects a staged manifest that $label", ({ mutate }) => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(mutate(baseManifest), null, 2)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.version/i,
		);
	});

	it.each([
		{
			label: "omits type",
			mutate: (manifest: Record<string, unknown>) => {
				const { type: _type, ...withoutType } = manifest;
				return withoutType;
			},
		},
		{
			label: "uses a non-module type",
			mutate: (manifest: Record<string, unknown>) => ({
				...manifest,
				type: "commonjs",
			}),
		},
	])("rejects a staged manifest that $label", ({ mutate }) => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(mutate(baseManifest), null, 2)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.type must be "module"/i,
		);
	});

	it.each([
		{
			field: "dependencies",
			invalidValue: ["chalk"],
			label: "an array",
		},
		{
			field: "optionalDependencies",
			invalidValue: "chalk",
			label: "a string",
		},
		{
			field: "peerDependencies",
			invalidValue: ["chalk"],
			label: "an array",
		},
		{
			field: "devDependencies",
			invalidValue: "chalk",
			label: "a string",
		},
	])("rejects a staged manifest when package.json.$field is $label instead of a plain object", ({
		field,
		invalidValue,
	}) => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...baseManifest,
					[field]: invalidValue,
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			new RegExp(`package\\.json\\.${field} must be a plain object`, "i"),
		);
	}, 60_000);

	it.each([
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"devDependencies",
	] as const)("rejects a staged manifest when package.json.%s aliases an internal @buildplane package through npm:", (field) => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...baseManifest,
					[field]: {
						aliasedKernel: "npm:@buildplane/kernel@0.1.0",
					},
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			new RegExp(`package\\.json\\.${field}\\.aliasedKernel`, "i"),
		);
	});

	it.each([
		{
			invalidValue: ["node ./scripts/build-from-source.js"],
			label: "an array",
		},
		{
			invalidValue: "node ./scripts/build-from-source.js",
			label: "a string",
		},
	])("rejects a staged manifest when package.json.scripts is $label instead of a plain object", ({
		invalidValue,
	}) => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...baseManifest,
					scripts: invalidValue,
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.scripts must be a plain object/i,
		);
	});

	it.each([
		{
			field: "files",
			leakedPath: "src/utils",
		},
		{
			field: "files",
			leakedPath: "test/helpers",
		},
		{
			field: "bundleDependencies",
			leakedPath: "@buildplane/kernel",
		},
		{
			field: "bundledDependencies",
			leakedPath: "src/utils",
		},
		{
			field: "bundledDependencies",
			leakedPath: "test/helpers",
		},
		{
			field: "bundledDependencies",
			leakedPath: "@buildplane/kernel",
		},
	])("rejects a staged manifest when package.json.$field includes forbidden staged payloads or internal package names", ({
		field,
		leakedPath,
	}) => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...baseManifest,
					[field]: [leakedPath],
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			new RegExp(
				`package\\.json\\.${field}.*${leakedPath.replace("/", "[\\\\/]")}`,
				"i",
			),
		);
	});

	it("rejects package.json.files when the published manifest omits it entirely", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;
		const { files: _files, ...manifestWithoutFiles } = baseManifest;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(manifestWithoutFiles, null, 2)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.files.*required|must be an array/i,
		);
	});

	it("rejects package.json.files when the published manifest makes it a non-array value", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...baseManifest,
					files: "dist",
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.files.*array/i,
		);
	});

	it("rejects package.json.files when it contains non-string entries", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...baseManifest,
					files: ["README.md", "dist", "vendor", 42],
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.files.*string.*42/i,
		);
	});

	it("rejects package.json.files when it widens the staged runtime surface", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...baseManifest,
					files: ["README.md", "dist", "vendor", "**"],
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.files.*README\.md.*dist.*vendor.*\*\*/i,
		);
	});

	it("rejects package.json.files when it stops whitelisting the full published runtime surface", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		writeFileSync(
			join(staged.packageRoot, "package.json"),
			`${JSON.stringify(
				{
					...baseManifest,
					files: ["README.md", "dist/index.js"],
				},
				null,
				2,
			)}\n`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/package\.json\.files.*(?:runtime surface.*dist\/index\.js|dist\/\*\*.*vendor\/\*\*.*README\.md.*dist\/index\.js)/i,
		);
	});

	it("rejects install lifecycle hooks in the staged manifest", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const baseManifest = JSON.parse(
			readFileSync(join(staged.packageRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;

		for (const lifecycleHook of [
			"preinstall",
			"install",
			"postinstall",
		] as const) {
			writeFileSync(
				join(staged.packageRoot, "package.json"),
				`${JSON.stringify(
					{
						...baseManifest,
						scripts: {
							[lifecycleHook]: "node ./scripts/build-from-source.js",
						},
					},
					null,
					2,
				)}\n`,
			);

			expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
				new RegExp(`package\\.json\\.scripts\\.${lifecycleHook}`, "i"),
			);
		}
	});

	it("fails inspection when the staged runtime tree contains a symlinked JavaScript file", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-runtime-symlink-inspect-"),
		);
		const escapedRuntimePath = join(tempRoot, "escaped-runtime.js");
		const stagedSymlinkPath = join(
			staged.packageRoot,
			"dist",
			"symlinked-runtime.js",
		);
		cleanupPaths.push(tempRoot);

		writeFileSync(escapedRuntimePath, "export const escaped = true;\n");
		symlinkSync(escapedRuntimePath, stagedSymlinkPath, "file");

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/symlink/i,
		);
	});

	it("fails inspection when dist/ ships extra runtime files outside the dist/index.js closure", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "dist", "debug.js"),
			"export const debug = true;\n",
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/dist[\\/]debug\.js/i,
		);
	});

	it.each([
		"debug.mjs",
		"debug.cjs",
	])("fails inspection when dist/ ships extra runtime file %s outside the dist/index.js closure", (fileName) => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "dist", fileName),
			"export const debug = true;\n",
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			`dist/${fileName}`,
		);
	});

	it("fails inspection when vendor/ ships extra runtime files outside the dist/index.js closure", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const extraVendorPath = join(
			staged.packageRoot,
			"vendor",
			"react",
			"index.js",
		);

		mkdirSync(join(extraVendorPath, ".."), { recursive: true });
		writeFileSync(extraVendorPath, "export const react = true;\n");

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/vendor[\\/]react[\\/]index\.js/i,
		);
	});

	it("fails inspection when a staged runtime file still contains @buildplane imports", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "dist", "run-cli.js"),
			`${readFileSync(join(staged.packageRoot, "dist", "run-cli.js"), "utf8")}
import "@buildplane/kernel";
`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/@buildplane\/kernel/,
		);
	});

	it("fails inspection when a staged runtime file still contains internal dynamic imports with extra arguments", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "dist", "run-cli.js"),
			`${readFileSync(join(staged.packageRoot, "dist", "run-cli.js"), "utf8")}
const loadKernel = (options) => import("@buildplane/kernel", options);
export { loadKernel };
`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/@buildplane\/kernel/,
		);
	});

	it("fails inspection when a staged vendored runtime file imports an undeclared bare external dependency", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const vendoredKernelPath = join(
			staged.packageRoot,
			"vendor",
			"@buildplane",
			"kernel",
			"index.js",
		);

		writeFileSync(
			vendoredKernelPath,
			`${readFileSync(vendoredKernelPath, "utf8")}
import "chalk";
`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/chalk|declared|dependency/i,
		);
	});

	it("fails inspection when a staged runtime file uses a computed dynamic import specifier", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		writeFileSync(
			join(staged.packageRoot, "dist", "run-cli.js"),
			`${readFileSync(join(staged.packageRoot, "dist", "run-cli.js"), "utf8")}
const name = "kernel";
const loadKernel = () => import(\`@buildplane/\${name}\`);
export { loadKernel };
`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/computed dynamic import|string literal/i,
		);
	});

	it("enforces dist/index.js execute bits on POSIX platforms", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		chmodSync(join(staged.packageRoot, "dist", "index.js"), 0o644);

		expect(() =>
			inspectPublishedPackage(staged.packageRoot, { platform: "linux" }),
		).toThrow(/dist\/index\.js must be executable/i);
	});

	it("skips dist/index.js execute-bit enforcement on win32", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);

		chmodSync(join(staged.packageRoot, "dist", "index.js"), 0o644);

		expect(
			inspectPublishedPackage(staged.packageRoot, { platform: "win32" }),
		).toEqual({
			inputPath: staged.packageRoot,
			packageRoot: staged.packageRoot,
			sourceType: "directory",
		});
	});

	it("fails inspection when the wrapper only mentions the Node version guard inside a nested function before the runtime boundary", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'assertSupportedNodeVersion();\nconst cli = await import("./cli.js");',
				[
					"function assertNodeVersionLater() {",
					"\tassertSupportedNodeVersion();",
					"}",
					'const cli = await import("./cli.js");',
					"assertNodeVersionLater();",
				].join("\n"),
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/assertSupportedNodeVersion\(\) before importing .*runtime boundary/i,
		);
	});

	it("fails inspection when the wrapper calls an undefined assertSupportedNodeVersion() before the runtime boundary", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'import { assertSupportedNodeVersion } from "./version-guard.js";\n',
				"",
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/import|define|assertSupportedNodeVersion/i,
		);
	});

	it("fails inspection when the wrapper default-imports assertSupportedNodeVersion before the runtime boundary", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'import { assertSupportedNodeVersion } from "./version-guard.js";',
				'import assertSupportedNodeVersion from "./version-guard.js";',
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/named import|assertSupportedNodeVersion/i,
		);
	}, 60_000);

	it("fails inspection when the wrapper namespace-imports assertSupportedNodeVersion before the runtime boundary", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'import { assertSupportedNodeVersion } from "./version-guard.js";',
				'import * as assertSupportedNodeVersion from "./version-guard.js";',
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/named import|assertSupportedNodeVersion/i,
		);
	}, 60_000);

	it("fails inspection when the runtime boundary is a bare awaited import expression", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'const cli = await import("./cli.js");',
				'await import("./cli.js");',
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/top-level variable statement|runtime boundary/i,
		);
	}, 60_000);

	it("fails inspection when the runtime boundary is not awaited inside its top-level variable statement", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'const cli = await import("./cli.js");',
				'const cli = import("./cli.js");',
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/top-level variable statement|runtime boundary/i,
		);
	}, 60_000);

	it("fails inspection when the runtime boundary statement does extra work in the same declaration", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'const cli = await import("./cli.js");',
				'const noop = sideEffect(), cli = await import("./cli.js");',
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/top-level variable statement|runtime boundary/i,
		);
	}, 60_000);

	it("fails inspection when the wrapper performs another top-level awaited runtime import after the required boundary", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(join(staged.packageRoot, "dist", "extra.js"), "export {}\n");
		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'const cli = await import("./cli.js");',
				[
					'const cli = await import("./cli.js");',
					'await import("./extra.js");',
				].join("\n"),
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/top-level dynamic import|runtime boundary|\.\/extra\.js/i,
		);
	}, 60_000);

	it.each([
		{
			label: "a top-level variable statement",
			trailingStatement: 'const loadExtra = () => import("./extra.js");',
		},
		{
			label: "a top-level expression statement",
			trailingStatement: '(async () => import("./extra.js"))();',
		},
	])("fails inspection when the wrapper leaves a nested local dynamic import inside $label after the required boundary", ({
		trailingStatement,
	}) => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(join(staged.packageRoot, "dist", "extra.js"), "export {}\n");
		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'const cli = await import("./cli.js");',
				['const cli = await import("./cli.js");', trailingStatement].join("\n"),
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/top-level dynamic import|runtime boundary|\.\/extra\.js/i,
		);
	}, 60_000);

	it("fails inspection when the wrapper imports its runtime boundary before asserting the Node version", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				/(assertSupportedNodeVersion\(\);\n)(const .* = await import\([^\n]+\);)/,
				"$2\nassertSupportedNodeVersion();",
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/assertSupportedNodeVersion\(\) before importing .*runtime boundary/i,
		);
	});

	it("fails inspection when a pre-guard IIFE executes a nested runtime import before asserting the Node version", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			[
				"#!/usr/bin/env node",
				'import { assertSupportedNodeVersion } from "./version-guard.js";',
				"await (async function bootstrap() {",
				"\tasync function loadCli() {",
				'\t\treturn import("./cli.js");',
				"\t}",
				"\treturn loadCli();",
				"})();",
				"assertSupportedNodeVersion();",
			].join("\n"),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/assertSupportedNodeVersion\(\) before importing .*runtime boundary/i,
		);
	});

	it("fails inspection when a member-expression runtime loader executes before asserting the Node version", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			[
				"#!/usr/bin/env node",
				'import { assertSupportedNodeVersion } from "./version-guard.js";',
				"[async function loadCli() {",
				'\treturn import("./cli.js");',
				"}][0]();",
				"assertSupportedNodeVersion();",
				'const cli = await import("./cli.js");',
				"export default cli;",
			].join("\n"),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/assertSupportedNodeVersion\(\) before importing .*runtime boundary/i,
		);
	});

	it("fails inspection when a class static block imports the runtime before the intended top-level boundary", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			[
				"#!/usr/bin/env node",
				'import { assertSupportedNodeVersion } from "./version-guard.js";',
				"assertSupportedNodeVersion();",
				"class Bootstrap {",
				"\tstatic {",
				'\t\timport("./cli.js");',
				"\t}",
				"}",
				'const cli = await import("./cli.js");',
				"export default cli;",
			].join("\n"),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/top-level statements before (?:the )?runtime boundary|assertSupportedNodeVersion\(\) before importing .*runtime boundary/i,
		);
	});

	it("fails inspection when a destructuring default imports the runtime before the intended top-level boundary", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			[
				"#!/usr/bin/env node",
				'import { assertSupportedNodeVersion } from "./version-guard.js";',
				"assertSupportedNodeVersion();",
				'const { cli = await import("./cli.js") } = {};',
				'const actualCli = await import("./cli.js");',
				"export default actualCli;",
			].join("\n"),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/top-level statements before (?:the )?runtime boundary|assertSupportedNodeVersion\(\) before importing .*runtime boundary/i,
		);
	});

	it("fails inspection when the wrapper statically imports a relative runtime module before asserting the Node version", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'import { assertSupportedNodeVersion } from "./version-guard.js";\nassertSupportedNodeVersion();',
				[
					'import { assertSupportedNodeVersion } from "./version-guard.js";',
					'import "./cli.js";',
					"assertSupportedNodeVersion();",
				].join("\n"),
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/dist[\\/]index\.js.*static import|\.\/cli\.js/i,
		);
	});

	it("fails inspection when the wrapper statically imports a relative runtime module after asserting the Node version", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				"assertSupportedNodeVersion();",
				["assertSupportedNodeVersion();", 'import "./cli.js";'].join("\n"),
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/dist[\\/]index\.js.*static import|\.\/cli\.js/i,
		);
	});

	it("fails inspection when the wrapper has any other top-level static import before asserting the Node version", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const distIndexPath = join(staged.packageRoot, "dist", "index.js");

		writeFileSync(
			distIndexPath,
			readFileSync(distIndexPath, "utf8").replace(
				'import { assertSupportedNodeVersion } from "./version-guard.js";',
				[
					'import "node:process";',
					'import { assertSupportedNodeVersion } from "./version-guard.js";',
				].join("\n"),
			),
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/dist[/\\]index\.js.*static import.*assertSupportedNodeVersion|node:process/i,
		);
	});

	it("fails inspection when a staged runtime import resolves to a TypeScript file", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const leakedRuntimePath = join(staged.packageRoot, "dist", "leak.ts");

		writeFileSync(leakedRuntimePath, "export const leaked = true;\n");
		writeFileSync(
			join(staged.packageRoot, "dist", "run-cli.js"),
			`${readFileSync(join(staged.packageRoot, "dist", "run-cli.js"), "utf8")}
import "./leak.ts";
`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/TypeScript source.*\.\/leak\.ts/i,
		);
	});

	it("inspects staged packages from ancestor paths containing src without false leakage failures", () => {
		const tempRoot = mkdtempSync(
			join(safeTmpdir(), "published-bootstrap-ancestor-root-"),
		);
		const packageRoot = join(tempRoot, "src", "package");
		cleanupPaths.push(tempRoot);

		writeMinimalPublishedPackage(packageRoot);

		expect(inspectPublishedPackage(packageRoot)).toEqual({
			inputPath: packageRoot,
			packageRoot,
			sourceType: "directory",
		});
	});

	it("fails inspection when a staged runtime import resolves to a src/** path", () => {
		const staged = stagePublishedPackage();
		cleanupPaths.push(staged.stagingRoot);
		const leakedRuntimePath = join(
			staged.packageRoot,
			"dist",
			"src",
			"leak.js",
		);

		mkdirSync(join(staged.packageRoot, "dist", "src"), { recursive: true });
		writeFileSync(leakedRuntimePath, "export const leaked = true;\n");
		writeFileSync(
			join(staged.packageRoot, "dist", "run-cli.js"),
			`${readFileSync(join(staged.packageRoot, "dist", "run-cli.js"), "utf8")}
import "./src/leak.js";
`,
		);

		expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
			/src\/\*\* (?:path|payloads)|dist[\\/]src(?:[\\/]leak\.js)?/i,
		);
	});

	it("fails inspection when source or test payloads leak anywhere into the shipped runtime tree", () => {
		for (const leakedRelativePath of [
			join("dist", "src", "orphan.js"),
			join("dist", "test", "orphan.js"),
			join("vendor", "@buildplane", "kernel", "src", "orphan.js"),
		]) {
			const staged = stagePublishedPackage();
			cleanupPaths.push(staged.stagingRoot);
			const leakedPath = join(staged.packageRoot, leakedRelativePath);

			mkdirSync(join(leakedPath, ".."), { recursive: true });
			writeFileSync(leakedPath, "export const leaked = true;\n");

			expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
				new RegExp(
					relative(staged.packageRoot, leakedPath)
						.replace(/[\\/][^\\/]+$/, "")
						.replaceAll("\\", "\\\\"),
					"i",
				),
			);
		}
	}, 60_000);

	it("fails inspection when empty src or test directories leak into the shipped runtime tree", () => {
		for (const leakedRelativePath of [
			join("dist", "src"),
			join("dist", "test"),
			join("vendor", "@buildplane", "kernel", "test"),
		]) {
			const staged = stagePublishedPackage();
			cleanupPaths.push(staged.stagingRoot);
			const leakedPath = join(staged.packageRoot, leakedRelativePath);

			mkdirSync(leakedPath, { recursive: true });

			expect(() => inspectPublishedPackage(staged.packageRoot)).toThrow(
				new RegExp(
					relative(staged.packageRoot, leakedPath).replaceAll("\\", "\\\\"),
					"i",
				),
			);
		}
	}, 60_000);
});
