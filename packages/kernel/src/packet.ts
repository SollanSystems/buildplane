import type {
	BudgetLimits,
	CommandExecutionBlock,
	ModelExecutionBlock,
	ToolDefinition,
	UnitPacket,
} from "./run-loop.js";
import type { Unit } from "./types.js";

export function parseUnitPacket(input: string): UnitPacket {
	const packet = asRecord(JSON.parse(input), "packet");
	const unitRecord = asRecord(packet.unit, "packet.unit");
	const verificationRecord =
		packet.verification === undefined
			? {}
			: asRecord(packet.verification, "packet.verification");

	const hasExecution = packet.execution !== undefined;
	const hasModel = packet.model !== undefined;

	if (!hasExecution && !hasModel) {
		throw new TypeError(
			"packet must have either an 'execution' block or a 'model' block",
		);
	}

	if (hasExecution && hasModel) {
		throw new TypeError(
			"packet must have either 'execution' or 'model', not both",
		);
	}

	const unit: Unit = {
		id: readRequiredString(unitRecord, "id", "packet.unit"),
		kind: readRequiredString(unitRecord, "kind", "packet.unit"),
		scope: readRequiredString(unitRecord, "scope", "packet.unit"),
		inputRefs:
			readOptionalStringArray(unitRecord, "inputRefs", "packet.unit") ?? [],
		expectedOutputs:
			readOptionalStringArray(unitRecord, "expectedOutputs", "packet.unit") ??
			[],
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

	const verification = {
		requiredOutputs:
			readOptionalStringArray(
				verificationRecord,
				"requiredOutputs",
				"packet.verification",
			) ?? [],
	};

	const budget = parseOptionalBudget(packet.budget);

	if (hasExecution) {
		return {
			unit,
			execution: parseExecutionBlock(packet.execution),
			verification,
			...(budget === undefined ? {} : { budget }),
		};
	}

	return {
		unit,
		model: parseModelBlock(packet.model),
		verification,
		...(budget === undefined ? {} : { budget }),
	};
}

function parseExecutionBlock(raw: unknown): CommandExecutionBlock {
	const record = asRecord(raw, "packet.execution");
	const args = readOptionalStringArray(record, "args", "packet.execution");
	const cwd = readOptionalString(record, "cwd", "packet.execution");

	return {
		command: readRequiredString(record, "command", "packet.execution"),
		...(args === undefined ? {} : { args }),
		...(cwd === undefined ? {} : { cwd }),
	};
}

function parseModelBlock(raw: unknown): ModelExecutionBlock {
	const record = asRecord(raw, "packet.model");
	const systemPrompt = readOptionalString(
		record,
		"systemPrompt",
		"packet.model",
	);
	const tools = parseOptionalTools(record.tools);

	return {
		provider: readRequiredString(record, "provider", "packet.model"),
		model: readRequiredString(record, "model", "packet.model"),
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(tools === undefined ? {} : { tools }),
	};
}

function parseOptionalBudget(raw: unknown): BudgetLimits | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const record = asRecord(raw, "packet.budget");
	const budget: Record<string, unknown> = {};

	const maxDurationMs = readOptionalNumber(
		record,
		"maxDurationMs",
		"packet.budget",
	);
	const maxTotalTokens = readOptionalNumber(
		record,
		"maxTotalTokens",
		"packet.budget",
	);
	const maxCommandCount = readOptionalNumber(
		record,
		"maxCommandCount",
		"packet.budget",
	);
	const maxSteps = readOptionalNumber(record, "maxSteps", "packet.budget");
	const allowedPaths = readOptionalStringArray(
		record,
		"allowedPaths",
		"packet.budget",
	);
	const networkPolicy = readOptionalString(
		record,
		"networkPolicy",
		"packet.budget",
	);

	if (maxDurationMs !== undefined) budget.maxDurationMs = maxDurationMs;
	if (maxTotalTokens !== undefined) budget.maxTotalTokens = maxTotalTokens;
	if (maxCommandCount !== undefined) budget.maxCommandCount = maxCommandCount;
	if (maxSteps !== undefined) budget.maxSteps = maxSteps;
	if (allowedPaths !== undefined) budget.allowedPaths = allowedPaths;
	if (networkPolicy !== undefined) {
		if (networkPolicy !== "none" && networkPolicy !== "localhost-only") {
			throw new TypeError(
				'packet.budget.networkPolicy must be "none" or "localhost-only"',
			);
		}
		budget.networkPolicy = networkPolicy;
	}

	return budget as BudgetLimits;
}

function parseOptionalTools(
	raw: unknown,
): readonly ToolDefinition[] | undefined {
	if (raw === undefined) {
		return undefined;
	}

	if (!Array.isArray(raw)) {
		throw new TypeError("packet.model.tools must be an array");
	}

	return raw.map((item, i) => {
		const record = asRecord(item, `packet.model.tools[${i}]`);
		return {
			name: readRequiredString(record, "name", `packet.model.tools[${i}]`),
			description: readRequiredString(
				record,
				"description",
				`packet.model.tools[${i}]`,
			),
			parameters: asRecord(
				record.parameters ?? {},
				`packet.model.tools[${i}].parameters`,
			),
		};
	});
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

function readOptionalNumber(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${label}.${key} must be a finite number`);
	}

	return value;
}

function readOptionalStringArray(
	record: Record<string, unknown>,
	key: string,
	label: string,
): readonly string[] | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}

	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new TypeError(`${label}.${key} must be an array of strings`);
	}

	return value;
}
