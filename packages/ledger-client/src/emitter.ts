import type { Readable, Writable } from "node:stream";
import { WriteQueue } from "./backpressure.js";
import { buildEnvelope, newLedgerEventId } from "./envelope.js";
import { type LedgerFailure, StderrTailer } from "./failure.js";
import { performHandshake } from "./handshake.js";
import {
	type ActivityClaimResultLine,
	type ActivityHeartbeatResultLine,
	type ActivityResultResultLine,
	buildClaimActivityV1,
	buildClose,
	buildFlush,
	buildHeartbeatActivityV1,
	buildRecordActivityResultV1,
	type ClaimActivityV1Args,
	type HeartbeatActivityV1Args,
	isActivityControlResponseLine,
	parseAckLine,
	type RecordActivityResultV1Args,
} from "./wire.js";

/**
 * Generic tape emission is observational/legacy telemetry only. These event
 * kinds can advance governed authority or record an effect, so they must be
 * issued by a dedicated native control rather than caller-provided JSON.
 */
const CALLER_SUPPLIED_TRUST_SPINE_KINDS = new Set<string>([
	"dispatch_envelope",
	"dispatch_envelope_v2",
	"dispatch_envelope_v3",
	"dispatch_envelope_v4",
	"workflow_graph_declared_v1",
	"workflow_graph_declared_v2",
	"action_requested_v2",
	"model_action_intent_v1",
	"model_action_authorized_v1",
	"model_action_authorized_v2",
	"activity_claimed_v1",
	"activity_heartbeat_recorded_v1",
	"activity_result_recorded_v1",
	"action_receipt_recorded_v2",
	"action_receipt_set_recorded_v1",
	"attempt_context_recorded_v1",
	"candidate_created",
	"candidate_created_v2",
	"candidate_completion_recorded_v1",
	"candidate_acceptance_recorded",
	"review_verdict_recorded",
	"review_verdict_recorded_v2",
	"promotion_approval_requested",
	"promotion_decision_recorded",
	"promotion_result_recorded",
	"promotion_reconciliation_resolved",
	"workflow_timer_scheduled_v1",
	"workflow_timer_fired_v1",
	"workflow_cancellation_requested_v1",
	"workflow_terminal",
	"workflow_terminal_v2",
]);

export interface CreateTapeEmitterOptions {
	childStdin: Writable;
	childStderr: Readable;
	childExit: Promise<number>;
	workspacePath: string;
	runId: string;
	/** Default: 30_000 ms. */
	handshakeTimeoutMs?: number;
	/** Default: 1024 events. */
	queueHighWatermark?: number;
	/** Default: 1. */
	schemaVersion?: number;
	/** Default: 30_000 ms. Fail closed when an authority reply is unavailable. */
	activityControlTimeoutMs?: number;
}

export interface EmitOptions {
	/** Parent event id, if any. UUIDv7. */
	parent?: string;
	/** Override auto-assigned id (tests only). */
	id?: string;
	/** Override occurred_at (tests only). */
	occurredAt?: string;
}

export interface TapeEmitter {
	/**
	 * Emit an event envelope. Synchronous, fire-and-forget: the call returns
	 * immediately after enqueueing. The queue's `highWatermark` throttles
	 * **execution order** of pending writes through an internal promise chain,
	 * but does NOT admission-control the pending count — under a tight
	 * synchronous burst (e.g. `for (let i = 0; i < 1_000_000; i++) emit(...)`)
	 * all N promises and JSON strings will be enqueued before Node pumps
	 * the event loop.
	 *
	 * Memory is bounded by the producer's cadence, not by the emitter. If
	 * bounded memory under adversarial bursts matters, the producer should
	 * yield to the event loop periodically (`await new Promise(setImmediate)`)
	 * or use `flush()` as a soft backpressure signal.
	 */
	emit(kind: string, payload: unknown, opts?: EmitOptions): void;
	/**
	 * Ask the signed native ledger to claim one governed activity. Only a
	 * `granted` response carries a lease that may authorize an effect; pending,
	 * replayed, expired, and rejected outcomes must not execute it.
	 */
	claimActivity(
		args: Omit<ClaimActivityV1Args, "requestId"> & { requestId?: string },
	): Promise<ActivityClaimResultLine>;
	/** Record the terminal result for a previously granted activity lease. */
	recordActivityResult(
		args: Omit<RecordActivityResultV1Args, "requestId"> & {
			requestId?: string;
		},
	): Promise<ActivityResultResultLine>;
	/**
	 * Request a bounded, authority-owned extension of a currently active
	 * activity lease. Replaying the same heartbeat id resolves the original
	 * signed extension; it never creates a second effect authorization.
	 */
	heartbeatActivity(
		args: Omit<HeartbeatActivityV1Args, "requestId"> & { requestId?: string },
	): Promise<ActivityHeartbeatResultLine>;
	flush(): Promise<void>;
	close(): Promise<void>;
	onFailure(cb: (reason: LedgerFailure) => void): void;
	stats(): {
		eventsEmitted: number;
		lastAckedEventId: string | null;
		queueDepth: number;
	};
}

export async function createTapeEmitter(
	opts: CreateTapeEmitterOptions,
): Promise<TapeEmitter> {
	const schemaVersion = opts.schemaVersion ?? 1;
	const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 30_000;
	const highWatermark = opts.queueHighWatermark ?? 1024;
	const activityControlTimeoutMs = opts.activityControlTimeoutMs ?? 30_000;
	if (
		!Number.isSafeInteger(activityControlTimeoutMs) ||
		activityControlTimeoutMs <= 0
	) {
		throw new RangeError("activityControlTimeoutMs must be a positive integer");
	}

	const tailer = new StderrTailer(opts.childStderr);

	await performHandshake({
		stdin: opts.childStdin,
		stderr: opts.childStderr,
		runId: opts.runId,
		schemaVersion,
		timeoutMs: handshakeTimeoutMs,
	});

	const queue = new WriteQueue(opts.childStdin, { highWatermark });
	const failureCallbacks: Array<(r: LedgerFailure) => void> = [];
	let failed = false;
	let eventsEmitted = 0;
	let lastAckedEventId: string | null = null;
	let flushSeq = 0;
	const pendingFlushes = new Map<
		number,
		{ resolve: () => void; reject: (e: Error) => void }
	>();
	type ActivityResponse =
		| ActivityClaimResultLine
		| ActivityResultResultLine
		| ActivityHeartbeatResultLine;
	type PendingActivityControl = {
		expectedControl:
			| "claim_activity_v1_result"
			| "record_activity_result_v1_result"
			| "heartbeat_activity_v1_result";
		resolve: (response: ActivityResponse) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	};
	const pendingActivityControls = new Map<string, PendingActivityControl>();
	let closeResolve: (() => void) | null = null;
	let closeReject: ((e: Error) => void) | null = null;

	let stderrBuf = "";
	const onStderrData = (chunk: Buffer | string) => {
		const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		stderrBuf += s;
		const lines = stderrBuf.split("\n");
		stderrBuf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const ack = parseAckLine(line);
			if (!ack) {
				if (isActivityControlResponseLine(line)) {
					markFailed({
						kind: "protocol_error",
						exitCode: null,
						stderrTail: tailer.tail(),
						lastAckedEventId,
						message:
							"native ledger returned a malformed activity authority response",
					});
				}
				continue;
			}
			if (ack.control === "flush_ack") {
				lastAckedEventId = ack.last_event_id || lastAckedEventId;
				const pending = pendingFlushes.get(ack.seq);
				if (pending) {
					pending.resolve();
					pendingFlushes.delete(ack.seq);
				}
			} else if (ack.control === "close_ack") {
				lastAckedEventId = ack.last_event_id || lastAckedEventId;
				if (closeResolve) closeResolve();
			} else if (ack.control === "error") {
				markFailed({
					kind: "protocol_error",
					exitCode: null,
					stderrTail: tailer.tail(),
					lastAckedEventId,
					message: `${ack.kind}: ${ack.message}`,
				});
			} else if (
				ack.control === "claim_activity_v1_result" ||
				ack.control === "record_activity_result_v1_result" ||
				ack.control === "heartbeat_activity_v1_result"
			) {
				const pending = pendingActivityControls.get(ack.request_id);
				if (!pending) {
					markFailed({
						kind: "protocol_error",
						exitCode: null,
						stderrTail: tailer.tail(),
						lastAckedEventId,
						message: `native ledger returned an unsolicited ${ack.control} response`,
					});
					continue;
				}
				if (pending.expectedControl !== ack.control) {
					markFailed({
						kind: "protocol_error",
						exitCode: null,
						stderrTail: tailer.tail(),
						lastAckedEventId,
						message: `native ledger returned ${ack.control} for an incompatible pending control`,
					});
					continue;
				}
				pendingActivityControls.delete(ack.request_id);
				clearTimeout(pending.timeout);
				pending.resolve(ack);
			}
		}
	};
	opts.childStderr.on("data", onStderrData);

	function markFailed(failure: LedgerFailure): void {
		if (failed) return;
		failed = true;
		for (const cb of failureCallbacks) {
			try {
				cb(failure);
			} catch {}
		}
		for (const [, p] of pendingFlushes) {
			p.reject(new Error(failure.message));
		}
		pendingFlushes.clear();
		for (const [, pending] of pendingActivityControls) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(failure.message));
		}
		pendingActivityControls.clear();
		if (closeReject) closeReject(new Error(failure.message));
	}

	function requestActivityControl<T extends ActivityResponse>(
		requestId: string,
		line: string,
		expectedControl: PendingActivityControl["expectedControl"],
	): Promise<T> {
		if (failed) {
			return Promise.reject(
				new Error("ledger failed; governed activity control unavailable"),
			);
		}
		if (pendingActivityControls.has(requestId)) {
			return Promise.reject(
				new Error(
					`duplicate governed activity control request id: ${requestId}`,
				),
			);
		}
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (!pendingActivityControls.delete(requestId)) return;
				const error = new Error(
					`timed out awaiting ${expectedControl} for request ${requestId}`,
				);
				reject(error);
				markFailed({
					kind: "protocol_error",
					exitCode: null,
					stderrTail: tailer.tail(),
					lastAckedEventId,
					message: error.message,
				});
			}, activityControlTimeoutMs);
			pendingActivityControls.set(requestId, {
				expectedControl,
				resolve: (response) => resolve(response as T),
				reject,
				timeout,
			});
			queue.write(line).catch((error: unknown) => {
				const pending = pendingActivityControls.get(requestId);
				if (!pending) return;
				pendingActivityControls.delete(requestId);
				clearTimeout(pending.timeout);
				const failure = new Error(
					`failed to write ${expectedControl} request: ${String(error)}`,
				);
				pending.reject(failure);
				markFailed({
					kind: "protocol_error",
					exitCode: null,
					stderrTail: tailer.tail(),
					lastAckedEventId,
					message: failure.message,
				});
			});
		});
	}

	opts.childExit
		.then((code) => {
			if (code !== 0) {
				markFailed({
					kind: "exit",
					exitCode: code,
					stderrTail: tailer.tail(),
					lastAckedEventId,
					message: `ledger exited with code ${code}`,
				});
			}
		})
		.catch((err: unknown) => {
			markFailed({
				kind: "exit",
				exitCode: null,
				stderrTail: tailer.tail(),
				lastAckedEventId,
				message: `childExit promise rejected: ${String(err)}`,
			});
		});

	return {
		emit(kind, payload, emitOpts) {
			if (failed) return;
			if (CALLER_SUPPLIED_TRUST_SPINE_KINDS.has(kind)) {
				throw new Error(
					`trust-spine event ${kind} requires an authority-owned control`,
				);
			}
			const env = buildEnvelope({
				runId: opts.runId,
				schemaVersion,
				kind,
				payload,
				parent: emitOpts?.parent,
				id: emitOpts?.id,
				occurredAt: emitOpts?.occurredAt,
			});
			const line = `${JSON.stringify(env)}\n`;
			eventsEmitted += 1;
			queue.write(line).catch(() => {
				// Failure surfaced via onFailure; don't bubble here.
			});
		},
		claimActivity(args) {
			const requestId = args.requestId ?? newLedgerEventId();
			const line = buildClaimActivityV1({ ...args, requestId });
			return requestActivityControl<ActivityClaimResultLine>(
				requestId,
				line,
				"claim_activity_v1_result",
			);
		},
		recordActivityResult(args) {
			const requestId = args.requestId ?? newLedgerEventId();
			const line = buildRecordActivityResultV1({ ...args, requestId });
			return requestActivityControl<ActivityResultResultLine>(
				requestId,
				line,
				"record_activity_result_v1_result",
			);
		},
		heartbeatActivity(args) {
			const requestId = args.requestId ?? newLedgerEventId();
			const line = buildHeartbeatActivityV1({ ...args, requestId });
			return requestActivityControl<ActivityHeartbeatResultLine>(
				requestId,
				line,
				"heartbeat_activity_v1_result",
			);
		},
		async flush() {
			if (failed) throw new Error("ledger failed; flush unavailable");
			const seq = flushSeq++;
			const promise = new Promise<void>((resolve, reject) => {
				pendingFlushes.set(seq, { resolve, reject });
			});
			// Route through the queue so flush is serialized AFTER all preceding
			// emits. Bypassing would let flush ack before queued events reach the
			// ledger, breaking the "flush everything written so far" contract.
			await queue.write(buildFlush(seq));
			await promise;
		},
		async close() {
			if (failed) throw new Error("ledger failed; close unavailable");
			if (pendingActivityControls.size > 0) {
				throw new Error(
					"cannot close ledger while governed activity authority responses are pending",
				);
			}
			const seq = flushSeq++;
			const promise = new Promise<void>((resolve, reject) => {
				closeResolve = resolve;
				closeReject = reject;
			});
			await queue.write(buildClose(seq));
			await promise;
			const code = await opts.childExit;
			if (code !== 0 && !failed) {
				throw new Error(`ledger exited with code ${code} after close`);
			}
		},
		onFailure(cb) {
			failureCallbacks.push(cb);
		},
		stats() {
			return {
				eventsEmitted,
				lastAckedEventId,
				queueDepth: queue.depth(),
			};
		},
	};
}
