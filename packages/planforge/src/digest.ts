import { createHash } from "node:crypto";

export type CanonicalValue =
	| string
	| number
	| boolean
	| null
	| CanonicalValue[]
	| { [key: string]: CanonicalValue };

function canonicalize(value: unknown): CanonicalValue {
	if (value === null || typeof value !== "object") {
		return value as CanonicalValue;
	}
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	const source = value as Record<string, unknown>;
	const sorted: { [key: string]: CanonicalValue } = {};
	for (const key of Object.keys(source).sort()) {
		const child = source[key];
		if (child === undefined) {
			continue;
		}
		sorted[key] = canonicalize(child);
	}
	return sorted;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function digest(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(canonicalJson(value), "utf8")
		.digest("hex")}`;
}
