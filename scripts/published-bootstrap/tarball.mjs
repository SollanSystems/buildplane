import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const TAR_BLOCK_SIZE = 512;
const REGULAR_FILE_TYPEFLAGS = new Set(["", "0", "7"]);

function isZeroBlock(block) {
	for (const byte of block) {
		if (byte !== 0) {
			return false;
		}
	}

	return true;
}

function readTarString(block, start, end) {
	const raw = block.subarray(start, end);
	const zeroIndex = raw.indexOf(0);
	return raw
		.subarray(0, zeroIndex === -1 ? raw.length : zeroIndex)
		.toString("utf8");
}

function failTarParse(tarballPath, message) {
	throw new Error(`Tar-parse error in ${tarballPath}: ${message}`);
}

function readTarOctal(block, start, end, tarballPath, fieldName) {
	const raw = readTarString(block, start, end).trim();
	if (!raw) {
		return 0;
	}

	if (!/^[0-7]+$/.test(raw)) {
		failTarParse(
			tarballPath,
			`Invalid ${fieldName} field ${JSON.stringify(raw)}: expected an octal value`,
		);
	}

	return Number.parseInt(raw, 8);
}

function isAsciiDigit(byte) {
	return byte >= 0x30 && byte <= 0x39;
}

function parsePaxHeaders(source, tarballPath) {
	const headers = {};
	let offset = 0;

	while (offset < source.length) {
		let lengthSeparatorIndex = offset;
		while (
			lengthSeparatorIndex < source.length &&
			isAsciiDigit(source[lengthSeparatorIndex])
		) {
			lengthSeparatorIndex += 1;
		}

		if (
			lengthSeparatorIndex === offset ||
			lengthSeparatorIndex >= source.length ||
			source[lengthSeparatorIndex] !== 0x20
		) {
			failTarParse(
				tarballPath,
				`malformed PAX header at byte ${offset}: PAX header length token must be ASCII digits followed by a space separator`,
			);
		}

		const recordLength = Number.parseInt(
			source.subarray(offset, lengthSeparatorIndex).toString("utf8"),
			10,
		);
		if (!Number.isFinite(recordLength) || recordLength <= 0) {
			failTarParse(
				tarballPath,
				`malformed PAX header at byte ${offset}: invalid record length ${JSON.stringify(source.subarray(offset, lengthSeparatorIndex).toString("utf8"))}`,
			);
		}
		if (offset + recordLength > source.length) {
			failTarParse(
				tarballPath,
				`malformed PAX header at byte ${offset}: declared record length ${recordLength} exceeds available header body bytes ${source.length - offset}`,
			);
		}

		const record = source
			.subarray(lengthSeparatorIndex + 1, offset + recordLength - 1)
			.toString("utf8");
		const equalsIndex = record.indexOf("=");
		if (equalsIndex !== -1) {
			headers[record.slice(0, equalsIndex)] = record.slice(equalsIndex + 1);
		}

		offset += recordLength;
	}

	return headers;
}

function readLongPath(body) {
	return body.toString("utf8").replace(/\0+$/, "");
}

function isWindowsAbsoluteArchivePath(path) {
	return /^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:/.test(path);
}

function assertArchiveRelativePath(entryPath) {
	const normalizedPath = entryPath.replace(/\\/g, "/");
	if (!normalizedPath) {
		throw new Error("Tar entry path must not be empty");
	}

	if (
		normalizedPath.startsWith("/") ||
		normalizedPath.startsWith("//") ||
		isWindowsAbsoluteArchivePath(entryPath)
	) {
		throw new Error(
			`Tar entry path must be relative: ${JSON.stringify(entryPath)}`,
		);
	}

	const segments = normalizedPath
		.split("/")
		.filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		throw new Error(
			`Tar entry path must not be empty: ${JSON.stringify(entryPath)}`,
		);
	}

	if (segments.some((segment) => segment === "." || segment === "..")) {
		throw new Error(
			`Tar entry path must stay within the extraction root: ${JSON.stringify(entryPath)}`,
		);
	}

	return segments.join("/");
}

function assertNoPreexistingSymlinkPathSegments(
	extractionRoot,
	destinationPath,
	entryPath,
) {
	const resolvedRoot = resolve(extractionRoot);
	const relativePath = relative(resolvedRoot, destinationPath);
	const segments = relativePath.split(/[\\/]+/).filter(Boolean);
	let currentPath = resolvedRoot;

	for (const segment of segments) {
		currentPath = join(currentPath, segment);
		if (existsSync(currentPath) && lstatSync(currentPath).isSymbolicLink()) {
			throw new Error(
				`Tar entry path must not traverse a pre-existing symlink under the extraction root: ${JSON.stringify(entryPath)} via ${currentPath}`,
			);
		}
	}
}

function toSafeDestinationPath(extractionRoot, entryPath) {
	const resolvedRoot = resolve(extractionRoot);
	const destinationPath = resolve(
		resolvedRoot,
		assertArchiveRelativePath(entryPath),
	);
	const relativePath = relative(resolvedRoot, destinationPath);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(
			`Tar entry path must stay within the extraction root: ${JSON.stringify(entryPath)}`,
		);
	}
	assertNoPreexistingSymlinkPathSegments(
		resolvedRoot,
		destinationPath,
		entryPath,
	);

	return destinationPath;
}

function readHeaderPath(block) {
	const name = readTarString(block, 0, 100);
	const prefix = readTarString(block, 345, 500);
	return prefix ? `${prefix}/${name}` : name;
}

function readHeaderChecksum(block, tarballPath, entryPath) {
	const raw = block
		.subarray(148, 156)
		.toString("utf8")
		.replace(/\0.*$/, "")
		.trim();
	if (!raw) {
		return 0;
	}

	if (!/^[0-7]+$/.test(raw)) {
		failTarParse(
			tarballPath,
			`Invalid checksum field ${JSON.stringify(raw)} for entry ${JSON.stringify(entryPath)}: expected an octal value`,
		);
	}

	return Number.parseInt(raw, 8);
}

function calculateHeaderChecksum(block) {
	let checksum = 0;
	for (let index = 0; index < block.length; index += 1) {
		checksum += index >= 148 && index < 156 ? 0x20 : block[index];
	}
	return checksum;
}

function assertValidHeaderChecksum(block, tarballPath) {
	const entryPath = readHeaderPath(block) || "<unnamed entry>";
	const actualChecksum = calculateHeaderChecksum(block);
	const expectedChecksum = readHeaderChecksum(block, tarballPath, entryPath);
	if (actualChecksum !== expectedChecksum) {
		failTarParse(
			tarballPath,
			`entry ${JSON.stringify(entryPath)} has invalid ustar checksum ${expectedChecksum}; expected ${actualChecksum}`,
		);
	}

	return entryPath;
}

function ensureEntryBlockWithinArchive(
	archive,
	offset,
	size,
	tarballPath,
	entryPath,
) {
	const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
	if (offset + paddedSize > archive.length) {
		failTarParse(
			tarballPath,
			`entry ${JSON.stringify(entryPath)} overruns its padded tar block or the archive tail is truncated`,
		);
	}

	return paddedSize;
}

function assertZeroPadding(padding, tarballPath, entryPath) {
	if (padding.length === 0 || isZeroBlock(padding)) {
		return;
	}

	failTarParse(
		tarballPath,
		`entry ${JSON.stringify(entryPath)} has non-zero per-entry block padding`,
	);
}

function assertTrailingZeroBlocks(archive, offset, tarballPath) {
	if (offset + TAR_BLOCK_SIZE > archive.length) {
		failTarParse(
			tarballPath,
			"Tar archive is missing required trailing zero blocks",
		);
	}

	const secondZeroBlock = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
	if (!isZeroBlock(secondZeroBlock)) {
		failTarParse(
			tarballPath,
			"Tar archive is missing required trailing zero blocks",
		);
	}

	offset += TAR_BLOCK_SIZE;
	for (const byte of archive.subarray(offset)) {
		if (byte !== 0) {
			failTarParse(
				tarballPath,
				"Tar archive must not contain non-zero data after its trailing zero blocks",
			);
		}
	}
}

export function extractTarballToDirectory(tarballPath, extractionRoot) {
	const archive = gunzipSync(readFileSync(tarballPath));
	if (archive.length % TAR_BLOCK_SIZE !== 0) {
		failTarParse(
			tarballPath,
			`Tar archive byte length ${archive.length} is not aligned to ${TAR_BLOCK_SIZE}-byte blocks`,
		);
	}

	let offset = 0;
	let globalPaxHeaders = {};
	let nextPaxHeaders = {};
	let nextLongPath;
	let foundTrailingZeroBlocks = false;

	while (offset + TAR_BLOCK_SIZE <= archive.length) {
		const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
		offset += TAR_BLOCK_SIZE;

		if (isZeroBlock(header)) {
			assertTrailingZeroBlocks(archive, offset, tarballPath);
			foundTrailingZeroBlocks = true;
			break;
		}

		const headerPath = assertValidHeaderChecksum(header, tarballPath);
		const size = readTarOctal(header, 124, 136, tarballPath, "size");
		const typeflag = readTarString(header, 156, 157);
		const paddedSize = ensureEntryBlockWithinArchive(
			archive,
			offset,
			size,
			tarballPath,
			headerPath,
		);
		const body = archive.subarray(offset, offset + size);
		assertZeroPadding(
			archive.subarray(offset + size, offset + paddedSize),
			tarballPath,
			headerPath,
		);
		offset += paddedSize;

		if (typeflag === "g") {
			globalPaxHeaders = {
				...globalPaxHeaders,
				...parsePaxHeaders(body, tarballPath),
			};
			continue;
		}

		if (typeflag === "x") {
			nextPaxHeaders = {
				...nextPaxHeaders,
				...parsePaxHeaders(body, tarballPath),
			};
			continue;
		}

		if (typeflag === "L") {
			nextLongPath = readLongPath(body);
			continue;
		}

		const entryHeaders = {
			...globalPaxHeaders,
			...nextPaxHeaders,
		};
		nextPaxHeaders = {};

		const entryPath =
			entryHeaders.path ?? nextLongPath ?? readHeaderPath(header);
		nextLongPath = undefined;
		const destinationPath = toSafeDestinationPath(extractionRoot, entryPath);
		const mode = readTarOctal(header, 100, 108, tarballPath, "mode") & 0o777;

		if (typeflag === "5") {
			mkdirSync(destinationPath, { recursive: true });
			continue;
		}

		if (!REGULAR_FILE_TYPEFLAGS.has(typeflag)) {
			throw new Error(
				`Unsupported tar entry type ${JSON.stringify(typeflag)} in ${tarballPath}: ${entryPath}`,
			);
		}

		mkdirSync(dirname(destinationPath), { recursive: true });
		writeFileSync(destinationPath, body);
		if (mode !== 0) {
			chmodSync(destinationPath, mode);
		}
	}

	if (!foundTrailingZeroBlocks) {
		failTarParse(
			tarballPath,
			"Tar archive is missing required trailing zero blocks",
		);
	}
}
