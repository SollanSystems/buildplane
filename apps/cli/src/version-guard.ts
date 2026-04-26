import {
	formatUnsupportedNodeVersionMessage,
	isNodeSqliteAvailable,
	isSupportedNodeVersion,
	SUPPORTED_NODE_RANGE,
} from "./capabilities.js";

export { SUPPORTED_NODE_RANGE };
export const SUPPORTED_NODE_VERSION = "24.13.1";

export interface RuntimeGuardOptions {
	readonly nodeSqliteAvailable?: boolean | (() => boolean);
}

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

function hasOnlySupportedBootstrapDoctorFlags(
	flags: readonly string[],
): boolean {
	const allowed = new Set(["--json", "--capabilities"]);
	const seen = new Set<string>();
	for (const flag of flags) {
		if (!allowed.has(flag) || seen.has(flag)) {
			return false;
		}
		seen.add(flag);
	}
	return true;
}

function resolveNodeSqliteAvailability(options: RuntimeGuardOptions): boolean {
	if (typeof options.nodeSqliteAvailable === "function") {
		return options.nodeSqliteAvailable();
	}
	if (typeof options.nodeSqliteAvailable === "boolean") {
		return options.nodeSqliteAvailable;
	}
	return isNodeSqliteAvailable();
}

function formatMissingNodeSqliteMessage(): string {
	return "Buildplane requires the Node node:sqlite runtime feature. Run `buildplane bootstrap doctor --capabilities --json` for host diagnostics.";
}

export function shouldBypassNodeVersionGuardForArgv(
	argv: readonly string[] = process.argv.slice(2),
): boolean {
	if (argv[0] !== "bootstrap" || argv[1] !== "doctor") {
		return false;
	}
	return hasOnlySupportedBootstrapDoctorFlags(argv.slice(2));
}

export function assertPublishedCliNodeVersion(
	argv: readonly string[],
	current = process.versions.node,
	options: RuntimeGuardOptions = {},
): void {
	assertSupportedNodeVersion(current, argv, options);
}

export function assertSupportedNodeVersion(
	current = process.versions.node,
	argv: readonly string[] = process.argv.slice(2),
	options: RuntimeGuardOptions = {},
): void {
	installCliWarningFilter();
	if (shouldBypassNodeVersionGuardForArgv(argv)) {
		return;
	}
	if (!isSupportedNodeVersion(current)) {
		throw new Error(formatUnsupportedNodeVersionMessage(current));
	}
	if (!resolveNodeSqliteAvailability(options)) {
		throw new Error(formatMissingNodeSqliteMessage());
	}
}
