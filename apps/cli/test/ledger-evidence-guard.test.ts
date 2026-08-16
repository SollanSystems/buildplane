import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerFailure, TapeEmitter } from "@buildplane/ledger-client";
import { describe, expect, it } from "vitest";
import { guardLedgerEvidence } from "../src/ledger-evidence-guard.js";
import { wrapToolRegistryForLedger } from "../src/ledger-tool-wrapper.js";

const runCliSource = readFileSync(
	resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "run-cli.ts"),
	"utf8",
);

type FailureCallback = (reason: LedgerFailure) => void;

interface FakeEmitter {
	readonly emitter: TapeEmitter;
	readonly emits: string[];
	/** Drive the emitter's failure channel the way `markFailed` does. */
	fail(message: string): void;
	closeCount: number;
}

/**
 * Stands in for a live `TapeEmitter`. The real `emit` is synchronous and routes
 * queue-write errors into `.catch(() => {})`, surfacing them only through
 * `onFailure` — so a fake that can fire `onFailure` independently of `emit`
 * reproduces the exact silent-resolution shape under test.
 */
function createFakeEmitter(
	options: { readonly closeError?: Error; readonly failOnEmit?: string } = {},
): FakeEmitter {
	const callbacks: FailureCallback[] = [];
	const emits: string[] = [];
	const fake: FakeEmitter = {
		emits,
		closeCount: 0,
		fail(message: string) {
			for (const cb of callbacks) {
				cb({
					kind: "protocol_error",
					exitCode: null,
					stderrTail: "",
					lastAckedEventId: null,
					message,
				});
			}
		},
		emitter: {
			emit(kind: string) {
				emits.push(kind);
				if (options.failOnEmit) fake.fail(options.failOnEmit);
			},
			async flush() {},
			async close() {
				fake.closeCount += 1;
				if (options.closeError) throw options.closeError;
			},
			onFailure(cb: FailureCallback) {
				callbacks.push(cb);
			},
			stats() {
				return {
					eventsEmitted: emits.length,
					lastAckedEventId: null,
					queueDepth: 0,
				};
			},
		} as unknown as TapeEmitter,
	};
	return fake;
}

describe("guardLedgerEvidence", () => {
	it("reports nothing and loses no evidence while the tape is healthy", async () => {
		const fake = createFakeEmitter();
		const reported: string[] = [];
		const guard = guardLedgerEvidence(fake.emitter, (line) =>
			reported.push(line),
		);

		fake.emitter.emit("unit_started", {});
		await guard.close();

		expect(guard.lostEvidence()).toBeNull();
		expect(reported).toEqual([]);
		expect(fake.closeCount).toBe(1);
	});

	it("latches and loudly reports an emit-path failure that emit() itself swallows", () => {
		const fake = createFakeEmitter();
		const reported: string[] = [];
		const guard = guardLedgerEvidence(fake.emitter, (line) =>
			reported.push(line),
		);

		// `emit()` returns void and never throws; the only failure channel is this.
		fake.fail("ledger exited with code 1");

		expect(guard.lostEvidence()).toContain("ledger exited with code 1");
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("ledger evidence lost");
		expect(reported[0]).toContain("ledger exited with code 1");
		expect(reported[0]?.endsWith("\n")).toBe(true);
	});

	it("keeps the FIRST failure reason when the tape fails repeatedly", () => {
		const fake = createFakeEmitter();
		const reported: string[] = [];
		const guard = guardLedgerEvidence(fake.emitter, (line) =>
			reported.push(line),
		);

		fake.fail("first");
		fake.fail("second");

		expect(guard.lostEvidence()).toContain("first");
		expect(guard.lostEvidence()).not.toContain("second");
		// A latched tape is already lost; do not spam the operator per event.
		expect(reported).toHaveLength(1);
	});

	it("surfaces a rejected close() instead of swallowing it", async () => {
		const fake = createFakeEmitter({
			closeError: new Error("close_ack never arrived"),
		});
		const reported: string[] = [];
		const guard = guardLedgerEvidence(fake.emitter, (line) =>
			reported.push(line),
		);

		await guard.close();

		expect(guard.lostEvidence()).toContain("close_ack never arrived");
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("ledger evidence lost");
	});

	it("never throws out of close(), so it is safe in a finally block", async () => {
		const fake = createFakeEmitter({ closeError: new Error("boom") });
		const guard = guardLedgerEvidence(fake.emitter, () => {});

		// A throw here would mask the original error a `finally` is unwinding.
		await expect(guard.close()).resolves.toBeUndefined();
	});

	it("closes at most once even if the caller unwinds twice", async () => {
		const fake = createFakeEmitter();
		const guard = guardLedgerEvidence(fake.emitter, () => {});

		await guard.close();
		await guard.close();

		expect(fake.closeCount).toBe(1);
	});

	it("surfaces a non-Error close rejection without losing the reason", async () => {
		const fake = createFakeEmitter();
		// A rejected promise need not carry an Error; `String(reason)` is the
		// fallback path and must not degrade to "[object Object]"-grade noise.
		fake.emitter.close = (async () => {
			throw "close_ack never arrived";
		}) as TapeEmitter["close"];
		const reported: string[] = [];
		const guard = guardLedgerEvidence(fake.emitter, (line) =>
			reported.push(line),
		);

		await guard.close();

		expect(guard.lostEvidence()).toBe("close_ack never arrived");
		expect(reported[0]).toContain("close_ack never arrived");
	});

	it("does not attempt close() after the tape already failed", async () => {
		const fake = createFakeEmitter();
		const guard = guardLedgerEvidence(fake.emitter, () => {});

		// The real emitter throws "ledger failed; close unavailable" here; calling
		// it would only produce a second, less informative failure.
		fake.fail("ledger exited with code 1");
		await guard.close();

		expect(fake.closeCount).toBe(0);
		expect(guard.lostEvidence()).toContain("ledger exited with code 1");
	});
});

/**
 * The `buildplane run` handler has THREE independent `finally` blocks that close
 * the run ledger — the `useAsync && !useTui` branch, the `useTui` branch, and the
 * default sync branch. All three gate on a hard-coded `const useLedger = false`,
 * so none can be driven from a test without refactoring the handler to make the
 * flag injectable, which is out of scope here. That structural untestability is
 * exactly what let a first pass convert one branch and leave the other two
 * swallowing — nothing failed. These source-level assertions are the pin that
 * would have caught it, and they hold regardless of the `useLedger` gating.
 */
describe("run-cli ledger close parity", () => {
	it("routes every run-handler close through the guard, with no direct close left", () => {
		expect(runCliSource).not.toContain("ledgerEmitter.close(");
		expect(runCliSource).toContain("await runEvidence.close();");
	});

	it("leaves no swallowed close in the run handler", () => {
		// The verbatim comment that marked all three original swallows.
		expect(runCliSource).not.toContain("Cleanup best-effort");
		// The fork lane's equivalent swallow, replaced by the same guard.
		expect(runCliSource).not.toContain(
			"Best-effort close; the orchestrator result is authoritative.",
		);
		expect(runCliSource).toContain("await forkEvidence.close();");
	});

	it("guards all three run-handler branches, not just one", () => {
		const guardedCloses = runCliSource.match(/await runEvidence\.close\(\);/g);
		expect(guardedCloses).toHaveLength(3);
	});
});

describe("tool-sink family under a guarded emitter", () => {
	it("surfaces a rejected tool_request append that the sync ToolRegistry cannot reject", () => {
		// `wrapToolRegistryForLedger` returns a SYNCHRONOUS ToolRegistry: it cannot
		// await a flush and cannot reject, so the tool call is bound to resolve
		// clean even when its tape events never land. The guard is what makes the
		// loss observable.
		const fake = createFakeEmitter({ failOnEmit: "storage_failure: disk full" });
		const reported: string[] = [];
		const guard = guardLedgerEvidence(fake.emitter, (line) =>
			reported.push(line),
		);

		const registry = wrapToolRegistryForLedger(
			{
				write_file: () => ({ success: true }),
				run_command: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
			} as never,
			fake.emitter,
			() => ({ unitId: "unit-1", parentEventId: "evt-1" }),
		);

		const result = registry.run_command({ command: "true", args: [] });

		// The tool itself still reports success — that is the shape of the bug.
		expect(result.exitCode).toBe(0);
		expect(fake.emits).toContain("tool_request");
		// ...but the run no longer claims clean tape evidence.
		expect(guard.lostEvidence()).toContain("storage_failure: disk full");
		expect(reported).toHaveLength(1);
	});
});
