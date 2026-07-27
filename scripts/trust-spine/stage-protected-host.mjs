import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const UNIT_DIRECTORY = join(
	REPOSITORY_ROOT,
	"deploy",
	"trust-spine",
	"systemd",
);

const FILES = Object.freeze([
	Object.freeze({
		sourceKind: "binary",
		sourceName: "buildplane-governed-session-client",
		path: "libexec/buildplane-governed-session-client",
		installPath: "/usr/libexec/buildplane/buildplane-governed-session-client",
		mode: 0o755,
	}),
	Object.freeze({
		sourceKind: "binary",
		sourceName: "buildplane-governed-session-host",
		path: "libexec/buildplane-governed-session-host",
		installPath: "/usr/libexec/buildplane/buildplane-governed-session-host",
		mode: 0o755,
	}),
	Object.freeze({
		sourceKind: "unit",
		sourceName: "buildplane-governed-session-host.service",
		path: "systemd/buildplane-governed-session-host.service",
		installPath:
			"/usr/lib/systemd/system/buildplane-governed-session-host.service",
		mode: 0o644,
	}),
	Object.freeze({
		sourceKind: "unit",
		sourceName: "buildplane-governed-session-host.socket",
		path: "systemd/buildplane-governed-session-host.socket",
		installPath:
			"/usr/lib/systemd/system/buildplane-governed-session-host.socket",
		mode: 0o644,
	}),
]);

/**
 * Stage a content-addressed deployment bundle without installing or starting
 * privileged services. The protected host must independently provision and
 * verify this bundle; staging never grants authority.
 */
export function stageProtectedHostBundleV1(input) {
	const binaryDirectory = requireAbsolutePath(
		input?.binaryDirectory,
		"binaryDirectory",
	);
	const outputDirectory = requireAbsolutePath(
		input?.outputDirectory,
		"outputDirectory",
	);
	const sources = FILES.map((file) => {
		const sourcePath =
			file.sourceKind === "binary"
				? join(binaryDirectory, file.sourceName)
				: join(UNIT_DIRECTORY, file.sourceName);
		const { contents, stat } = readSourceSnapshot(sourcePath, file.sourceName);
		if (file.sourceKind === "binary") {
			const header = contents.subarray(0, 4);
			if (
				header.length !== 4 ||
				header[0] !== 0x7f ||
				header[1] !== 0x45 ||
				header[2] !== 0x4c ||
				header[3] !== 0x46
			) {
				throw new Error(`${file.sourceName} must be a Linux ELF binary.`);
			}
			if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
				throw new Error(`${file.sourceName} must be executable.`);
			}
		}
		return Object.freeze({ contents, file });
	});
	mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });

	const manifestFiles = sources.map(({ contents, file }) => {
		const destinationPath = join(outputDirectory, ...file.path.split("/"));
		mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o755 });
		writeFileSync(destinationPath, contents, { flag: "wx", mode: file.mode });
		chmodSync(destinationPath, file.mode);
		const stagedStat = lstatSync(destinationPath);
		if (
			!stagedStat.isFile() ||
			stagedStat.isSymbolicLink() ||
			stagedStat.nlink !== 1
		) {
			throw new Error(`${file.path} was not staged as a single-link file.`);
		}
		return Object.freeze({
			path: file.path,
			installPath: file.installPath,
			mode: file.mode.toString(8).padStart(4, "0"),
			sha256: createHash("sha256").update(contents).digest("hex"),
			sizeBytes: contents.byteLength,
		});
	});

	const manifestPath = join(outputDirectory, "manifest.json");
	writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				artifact: "buildplane-protected-governed-session-host",
				files: manifestFiles,
			},
			null,
			2,
		)}\n`,
		{ encoding: "utf8", mode: 0o644, flag: "wx" },
	);
	return Object.freeze({ bundleDirectory: outputDirectory, manifestPath });
}

function requireAbsolutePath(value, label) {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		resolve(value) !== value
	) {
		throw new TypeError(`${label} must be an absolute normalized path.`);
	}
	return value;
}

function readSourceSnapshot(path, label) {
	const linkStat = lstatSync(path);
	if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
		throw new Error(`${label} must be a regular, non-symlinked file.`);
	}
	const descriptor = openSync(
		path,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const before = fstatSync(descriptor);
		if (!before.isFile()) {
			throw new Error(`${label} must remain a regular file.`);
		}
		const contents = readFileSync(descriptor);
		const after = fstatSync(descriptor);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		) {
			throw new Error(
				`${label} changed while its deployment snapshot was read.`,
			);
		}
		return Object.freeze({ contents, stat: after });
	} finally {
		closeSync(descriptor);
	}
}

function parseArguments(argv) {
	let binaryDirectory;
	let outputDirectory;
	const separatorIndex = argv.indexOf("--");
	if (separatorIndex !== -1 && argv.indexOf("--", separatorIndex + 1) !== -1) {
		throw new Error("The argument separator may appear at most once.");
	}
	const argumentsWithoutSeparator =
		separatorIndex === -1
			? argv
			: [...argv.slice(0, separatorIndex), ...argv.slice(separatorIndex + 1)];
	for (let index = 0; index < argumentsWithoutSeparator.length; index += 2) {
		const flag = argumentsWithoutSeparator[index];
		const value = argumentsWithoutSeparator[index + 1];
		if (flag === "--bin-dir") binaryDirectory = value;
		else if (flag === "--out") outputDirectory = value;
		else throw new Error(`Unsupported argument: ${flag ?? "<missing>"}`);
	}
	return {
		binaryDirectory: resolve(binaryDirectory ?? ""),
		outputDirectory: resolve(outputDirectory ?? ""),
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const result = stageProtectedHostBundleV1(
			parseArguments(process.argv.slice(2)),
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : "protected-host staging failed"}\n`,
		);
		process.exitCode = 1;
	}
}
