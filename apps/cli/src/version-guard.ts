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

export function shouldBypassNodeVersionGuardForArgv(
	argv: readonly string[] = process.argv.slice(2),
): boolean {
	return (
		(argv.length === 2 && argv[0] === "bootstrap" && argv[1] === "doctor") ||
		(argv.length === 3 &&
			argv[0] === "bootstrap" &&
			argv[1] === "doctor" &&
			argv[2] === "--json")
	);
}

export function assertPublishedCliNodeVersion(
	argv: readonly string[],
	current = process.versions.node,
): void {
	assertSupportedNodeVersion(current, argv);
}

export function assertSupportedNodeVersion(
	current = process.versions.node,
	argv: readonly string[] = process.argv.slice(2),
): void {
	installCliWarningFilter();
	if (shouldBypassNodeVersionGuardForArgv(argv)) {
		return;
	}
	if (current !== SUPPORTED_NODE_VERSION) {
		throw new Error(
			`Buildplane requires Node ${SUPPORTED_NODE_VERSION}. Detected ${current}.`,
		);
	}
}
