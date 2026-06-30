import {
	CAPABILITY_BUNDLE_SCHEMA_VERSION,
	type CapabilityBundleV0,
} from "./schema.js";

export type ParseCapabilityBundleResult =
	| { ok: true; bundle: CapabilityBundleV0 }
	| { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(
	field: string,
	value: unknown,
	errors: string[],
): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		errors.push(`${field} must be an array of strings`);
		return undefined;
	}
	const out: string[] = [];
	for (let i = 0; i < value.length; i++) {
		if (typeof value[i] !== "string") {
			errors.push(`${field}[${i}] must be a string`);
			continue;
		}
		out.push(value[i]);
	}
	return out;
}

function parseTools(
	value: unknown,
	errors: string[],
): CapabilityBundleV0["tools"] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isPlainObject(value)) {
		errors.push("tools must be an object");
		return undefined;
	}
	const tools: NonNullable<CapabilityBundleV0["tools"]> = {};

	const writeFile = value.write_file;
	if (writeFile !== undefined) {
		if (!isPlainObject(writeFile)) {
			errors.push("tools.write_file must be an object");
		} else if (
			writeFile.enabled !== undefined &&
			typeof writeFile.enabled !== "boolean"
		) {
			errors.push("tools.write_file.enabled must be a boolean");
		} else {
			tools.write_file = {
				...(writeFile.enabled !== undefined
					? { enabled: writeFile.enabled as boolean }
					: {}),
			};
		}
	}

	const runCommand = value.run_command;
	if (runCommand !== undefined) {
		if (!isPlainObject(runCommand)) {
			errors.push("tools.run_command must be an object");
		} else {
			const allowlist = parseStringArray(
				"tools.run_command.allowlist",
				runCommand.allowlist,
				errors,
			);
			tools.run_command = allowlist ? { allowlist } : {};
		}
	}

	return Object.keys(tools).length > 0 ? tools : {};
}

export function parseCapabilityBundle(
	input: unknown,
): ParseCapabilityBundleResult {
	const errors: string[] = [];

	if (!isPlainObject(input)) {
		return { ok: false, errors: ["bundle must be a JSON object"] };
	}

	const schemaVersion = input.schemaVersion;
	if (schemaVersion !== CAPABILITY_BUNDLE_SCHEMA_VERSION) {
		errors.push(`schemaVersion must be "${CAPABILITY_BUNDLE_SCHEMA_VERSION}"`);
	}

	const bundleId = input.bundleId;
	if (typeof bundleId !== "string" || bundleId.length === 0) {
		errors.push("bundleId must be a non-empty string");
	}

	const fsRead = parseStringArray("fsRead", input.fsRead, errors);
	const fsWrite = parseStringArray("fsWrite", input.fsWrite, errors);
	const netEgress = parseStringArray("netEgress", input.netEgress, errors);
	const tools = parseTools(input.tools, errors);

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		bundle: {
			schemaVersion: CAPABILITY_BUNDLE_SCHEMA_VERSION,
			bundleId: bundleId as string,
			...(fsRead !== undefined ? { fsRead } : {}),
			...(fsWrite !== undefined ? { fsWrite } : {}),
			...(netEgress !== undefined ? { netEgress } : {}),
			...(tools !== undefined && Object.keys(tools).length > 0
				? { tools }
				: {}),
		},
	};
}
