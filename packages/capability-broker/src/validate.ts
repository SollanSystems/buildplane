import { parseCapabilityBundle } from "./parse.js";
import type { CapabilityBundleV0 } from "./schema.js";

export type ValidateCapabilityBundleResult =
	| { ok: true; bundle: CapabilityBundleV0 }
	| { ok: false; errors: string[] };

function isValidRelativeGlob(pattern: string): boolean {
	if (pattern.length === 0 || pattern.includes("\0")) {
		return false;
	}
	if (pattern.startsWith("/") || pattern.startsWith("\\")) {
		return false;
	}
	if (/^[a-zA-Z]:/.test(pattern)) {
		return false;
	}
	for (const segment of pattern.split("/")) {
		if (segment === "..") {
			return false;
		}
	}
	return true;
}

function validateGlobList(
	field: string,
	patterns: string[] | undefined,
): string[] {
	const errors: string[] = [];
	if (patterns === undefined) {
		return errors;
	}
	for (let i = 0; i < patterns.length; i++) {
		if (!isValidRelativeGlob(patterns[i])) {
			errors.push(
				`${field}[${i}] must be a relative glob without ".." segments`,
			);
		}
	}
	return errors;
}

function validateAllowlist(allowlist: string[] | undefined): string[] {
	const errors: string[] = [];
	if (allowlist === undefined) {
		return errors;
	}
	for (let i = 0; i < allowlist.length; i++) {
		const entry = allowlist[i];
		if (entry.length === 0 || entry.includes("\0")) {
			errors.push(
				`tools.run_command.allowlist[${i}] must be a non-empty string without NUL`,
			);
		}
	}
	return errors;
}

export function validateCapabilityBundle(
	input: unknown,
): ValidateCapabilityBundleResult {
	const parsed = parseCapabilityBundle(input);
	if (!parsed.ok) {
		return parsed;
	}

	const errors: string[] = [
		...validateGlobList("fsRead", parsed.bundle.fsRead),
		...validateGlobList("fsWrite", parsed.bundle.fsWrite),
		...validateAllowlist(parsed.bundle.tools?.run_command?.allowlist),
	];

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, bundle: parsed.bundle };
}
