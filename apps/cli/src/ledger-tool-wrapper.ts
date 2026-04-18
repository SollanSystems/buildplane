import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type {
	RunCommandInput,
	RunCommandResult,
	ToolRegistry,
	WriteFileInput,
	WriteFileResult,
} from "@buildplane/adapters-tools";

export interface UnitCtx {
	unitId: string;
	parentEventId: string;
}

export interface LedgerEventEmitter {
	emit(
		kind: string,
		payload: unknown,
		opts?: { parent?: string; id?: string },
	): void;
}

function sha256(bytes: Buffer | string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Hash of an empty env map `{}`. Used when no env vars are captured —
 * a real digest rather than the misleading bare-prefix placeholder "sha256:".
 */
const EMPTY_ENV_HASH = `sha256:${createHash("sha256").update("{}").digest("hex")}`;

/** Wrap a ToolRegistry so every call emits tool_request / tool_result (and
 * workspace_write for write_file) to the ledger emitter. The original
 * registry is called unchanged; the wrapper is a transparent proxy.
 */
export function wrapToolRegistryForLedger(
	registry: ToolRegistry,
	emitter: LedgerEventEmitter,
	getUnitCtx: () => UnitCtx | null,
): ToolRegistry {
	return {
		write_file(input: WriteFileInput): WriteFileResult {
			const ctx = getUnitCtx();
			const toolReqId = randomUUID();

			// Pre-hash: capture the existing file content if any.
			let hashBefore: string | null = null;
			try {
				if (existsSync(input.path)) {
					hashBefore = sha256(readFileSync(input.path));
				}
			} catch {
				hashBefore = null;
			}

			const hashAfter = sha256(input.content);

			emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: "write_file",
						arguments: { path: input.path, content_hash: hashAfter },
						env: { redacted: true, hash: EMPTY_ENV_HASH, hint: "env_var" },
						working_directory: "",
						unit_id: ctx?.unitId ?? "",
					},
				},
				{ parent: ctx?.parentEventId, id: toolReqId },
			);

			const started = Date.now();
			const result = registry.write_file(input);
			const durationMs = Date.now() - started;

			if (result.success) {
				let sizeBytes = 0;
				try {
					sizeBytes = statSync(input.path).size;
				} catch {
					sizeBytes = Buffer.byteLength(input.content);
				}
				emitter.emit(
					"workspace_write",
					{
						WorkspaceWriteV1: {
							tool_request_id: toolReqId,
							path: input.path,
							hash_before: hashBefore,
							after: {
								status: "captured",
								hash: hashAfter,
								size_bytes: sizeBytes,
							},
						},
					},
					{ parent: toolReqId },
				);
			}

			emitter.emit(
				"tool_result",
				{
					ToolResultV1: {
						tool_request_id: toolReqId,
						stdout: "",
						stderr: result.error ?? "",
						exit_code: null,
						output: { success: result.success },
						duration_ms: durationMs,
					},
				},
				{ parent: toolReqId },
			);

			return result;
		},

		run_command(input: RunCommandInput): RunCommandResult {
			const ctx = getUnitCtx();
			const toolReqId = randomUUID();

			emitter.emit(
				"tool_request",
				{
					ToolRequestStoredV1: {
						tool_name: "run_command",
						arguments: {
							command: input.command,
							args: input.args ?? [],
						},
						env: { redacted: true, hash: EMPTY_ENV_HASH, hint: "env_var" },
						working_directory: input.cwd ?? "",
						unit_id: ctx?.unitId ?? "",
					},
				},
				{ parent: ctx?.parentEventId, id: toolReqId },
			);

			const started = Date.now();
			const result = registry.run_command(input);
			const durationMs = Date.now() - started;

			emitter.emit(
				"tool_result",
				{
					ToolResultV1: {
						tool_request_id: toolReqId,
						stdout: result.stdout,
						stderr: result.stderr,
						exit_code: result.exitCode,
						output: null,
						duration_ms: durationMs,
					},
				},
				{ parent: toolReqId },
			);

			return result;
		},
	};
}
