export const SUPPORTED_NODE_MAJOR = 24;
export const SUPPORTED_NODE_VERSION = "24.13.1";

const SQLITE_EXPERIMENTAL_WARNING_PATTERN =
	/^SQLite is an experimental feature and might change at any time\.?$/i;
let cliWarningFilterInstalled = false;

export function shouldSuppressCliWarning(
	warning: string | Error,
	rest: readonly unknown[] = [],
): boolean {
	const warningMessage =
		typeof warning === "string" ? warning : (warning.message ?? "");
	const warningType =
		typeof warning === "string"
			? typeof rest[0] === "string"
				? rest[0]
				: isEmitWarningOptions(rest[0])
					? rest[0].type
					: undefined
			: warning.name;

	return (
		warningType === "ExperimentalWarning" &&
		SQLITE_EXPERIMENTAL_WARNING_PATTERN.test(warningMessage)
	);
}

function installCliWarningFilter(): void {
	if (cliWarningFilterInstalled) {
		return;
	}

	cliWarningFilterInstalled = true;
	const originalEmitWarning = process.emitWarning.bind(process);
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		if (shouldSuppressCliWarning(warning, rest)) {
			return;
		}

		return Reflect.apply(originalEmitWarning, process, [warning, ...rest]);
	}) as typeof process.emitWarning;
}

function isEmitWarningOptions(
	value: unknown,
): value is { type?: string | undefined } {
	return typeof value === "object" && value !== null && "type" in value;
}

export function assertSupportedNodeVersion(
	current = process.versions.node,
): void {
	const major = parseInt(current.split(".")[0], 10);
	if (major < SUPPORTED_NODE_MAJOR) {
		throw new Error(
			`Buildplane requires Node ${SUPPORTED_NODE_VERSION}+ (major ${SUPPORTED_NODE_MAJOR}). Detected ${current}.`,
		);
	}

	installCliWarningFilter();
}
