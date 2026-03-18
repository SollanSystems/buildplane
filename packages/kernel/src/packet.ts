import type { UnitPacket } from "./run-loop.js";
import type { Unit } from "./types.js";

export function parseUnitPacket(input: unknown): UnitPacket {
	const packet = asRecord(input, "packet");
	const unitRecord = asRecord(packet.unit, "packet.unit");
	const executionRecord = asRecord(packet.execution, "packet.execution");
	const verificationRecord =
		packet.verification === undefined
			? {}
			: asRecord(packet.verification, "packet.verification");

	const unit: Unit = {
		id: readRequiredString(unitRecord, "id", "packet.unit"),
		kind: readRequiredString(unitRecord, "kind", "packet.unit"),
		scope: readRequiredString(unitRecord, "scope", "packet.unit"),
		inputRefs: readOptionalStringArray(unitRecord, "inputRefs", "packet.unit"),
		expectedOutputs: readOptionalStringArray(
			unitRecord,
			"expectedOutputs",
			"packet.unit",
		),
		verificationContract: readRequiredString(
			unitRecord,
			"verificationContract",
			"packet.unit",
		),
		policyProfile: readRequiredString(
			unitRecord,
			"policyProfile",
			"packet.unit",
		),
	};

	return {
		unit,
		execution: {
			command: readRequiredString(
				executionRecord,
				"command",
				"packet.execution",
			),
			args: readOptionalStringArray(
				executionRecord,
				"args",
				"packet.execution",
			),
			cwd:
				readOptionalString(executionRecord, "cwd", "packet.execution") ?? ".",
		},
		verification: {
			requiredOutputs: readOptionalStringArray(
				verificationRecord,
				"requiredOutputs",
				"packet.verification",
			),
		},
	};
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}

	return value as Record<string, unknown>;
}

function readRequiredString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${label}.${key} must be a non-empty string`);
	}

	return value;
}

function readOptionalString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${label}.${key} must be a non-empty string`);
	}

	return value;
}

function readOptionalStringArray(
	record: Record<string, unknown>,
	key: string,
	label: string,
): readonly string[] {
	const value = record[key];
	if (value === undefined) {
		return [];
	}

	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new TypeError(`${label}.${key} must be an array of strings`);
	}

	return value;
}
