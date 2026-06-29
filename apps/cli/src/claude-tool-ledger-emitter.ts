import type { ClaudeToolEvent } from "@buildplane/adapters-models";
import { newEventId } from "@buildplane/ledger-client";
import {
	EMPTY_ENV_HASH,
	type LedgerEventEmitter,
	type UnitCtx,
} from "./ledger-tool-wrapper.js";

/**
 * Map the Claude Code worker's per-tool-call stream events onto the signed tape
 * (`tool_request` → `ToolRequestStoredV1`, `tool_result` → `ToolResultV1`),
 * mirroring `wrapToolRegistryForLedger` for buildplane's own deterministic tools
 * (M6-S8). The executor stays transport-agnostic and forwards parsed
 * `ClaudeToolEvent`s here; this is the only place the ledger payloads are built.
 *
 * `projectRoot` is the run's workspace cwd — the directory the worker's tools
 * execute against — recorded as `working_directory`, matching the workspace
 * root `wrapToolRegistryForLedger` records for buildplane's own tools.
 *
 * A `tool_result` is correlated to its originating `tool_request` event id via
 * the worker's `tool_use_id`. A result with no recorded request (out-of-order
 * or pre-sink stream) is dropped rather than emitting an orphan event.
 */
export function createClaudeToolLedgerEmitter(
	emitter: LedgerEventEmitter,
	getUnitCtx: () => UnitCtx | null,
	projectRoot: string,
): (event: ClaudeToolEvent) => void {
	const pending = new Map<string, { eventId: string; startedAt: number }>();

	return (event: ClaudeToolEvent): void => {
		if (event.phase === "request") {
			const ctx = getUnitCtx();
			const toolReqId = newEventId();
			pending.set(event.toolUseId, {
				eventId: toolReqId,
				startedAt: Date.now(),
			});
			emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: event.toolName,
						arguments: event.input,
						env: { redacted: true, hash: EMPTY_ENV_HASH, hint: "env_var" },
						working_directory: projectRoot,
						unit_id: ctx?.unitId ?? "",
					},
				},
				{ parent: ctx?.parentEventId, id: toolReqId },
			);
			return;
		}

		const open = pending.get(event.toolUseId);
		if (!open) return;
		pending.delete(event.toolUseId);

		emitter.emit(
			"tool_result",
			{
				ToolResultV1: {
					tool_request_id: open.eventId,
					stdout: event.isError ? "" : event.content,
					stderr: event.isError ? event.content : "",
					exit_code: null,
					output: { is_error: event.isError },
					duration_ms: Date.now() - open.startedAt,
				},
			},
			{ parent: open.eventId },
		);
	};
}
