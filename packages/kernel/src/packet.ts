import type {
	CommandExecutionBlock,
	ModelExecutionBlock,
	RoutingHints,
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

	const routingHints =
		packet.routingHints === undefined
			? undefined
			: parseRoutingHints(packet.routingHints);

	if (hasExecution) {
		return {
			unit,
			execution: parseExecutionBlock(packet.execution),
			verification,
			...(routingHints === undefined ? {} : { routingHints }),
		};
	}

	return {
		unit,
		model: parseModelBlock(packet.model),
		verification,
		...(routingHints === undefined ? {} : { routingHints }),
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

	// prompt: optional, but must not be empty if present
	const promptRaw = record.prompt;
	if (promptRaw !== undefined) {
		if (typeof promptRaw !== "string" || promptRaw.length === 0) {
			throw new TypeError("model.prompt must not be empty if present");
		}
	}
	const prompt = promptRaw as string | undefined;

	const tools = parseOptionalTools(record.tools);

	return {
		provider: readRequiredString(record, "provider", "packet.model"),
		model: readRequiredString(record, "model", "packet.model"),
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(prompt === undefined ? {} : { prompt }),
		...(tools === undefined ? {} : { tools }),
	};
}

function parseRoutingHints(raw: unknown): RoutingHints {
	const record = asRecord(raw, "packet.routingHints");

	const preferredWorkerRaw = record.preferredWorker;
	if (preferredWorkerRaw !== undefined) {
		if (preferredWorkerRaw !== "claude-code") {
			throw new TypeError(
				`packet.routingHints.preferredWorker must be "claude-code" if present, got: ${String(preferredWorkerRaw)}`,
			);
		}
	}
	const preferredWorker = preferredWorkerRaw as "claude-code" | undefined;

	const preferredModel = readOptionalString(
		record,
		"preferredModel",
		"packet.routingHints",
	);

	const effortRaw = record.effort;
	if (effortRaw !== undefined) {
		if (effortRaw !== "low" && effortRaw !== "medium" && effortRaw !== "high") {
			throw new TypeError(
				`packet.routingHints.effort must be "low", "medium", or "high" if present, got: ${String(effortRaw)}`,
			);
		}
	}
	const effort = effortRaw as "low" | "medium" | "high" | undefined;

	return {
		...(preferredWorker === undefined ? {} : { preferredWorker }),
		...(preferredModel === undefined ? {} : { preferredModel }),
		...(effort === undefined ? {} : { effort }),
	};
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
