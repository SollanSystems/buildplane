import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { createTapeEmitter, type TapeEmitter } from "@buildplane/ledger-client";

import {
	LEDGER_TEST_REPO_ROOT,
	resolveNativeBinaryForLedgerTests,
} from "./fixtures.js";

export const PLANFORGE_CRASH_BOUNDARIES = [
	"admit-before-execute",
	"after-activity-completed",
	"execute-before-receipt",
] as const;

export type PlanForgeCrashBoundary =
	(typeof PLANFORGE_CRASH_BOUNDARIES)[number];

type EventKind =
	| "plan_admitted"
	| "activity_started"
	| "activity_completed"
	| "plan_receipt";

export interface CreatePlanForgeCrashTapeOptions {
	boundary: PlanForgeCrashBoundary;
}

export interface PlanForgeCrashTape {
	boundary: PlanForgeCrashBoundary;
	dir: string;
	home: string;
	eventsDbPath: string;
	runId: string;
	expectedKinds: EventKind[];
	expectedCompletedActivityResults: unknown[];
	cleanup: () => Promise<void>;
}

export interface CrashHarnessEvent {
	id: string;
	kind: EventKind;
	payload: Record<string, unknown>;
}

export interface PlanForgeCrashTapeState {
	eventsDbPath: string;
	runId: string;
	phase:
		| "admitted-before-execute"
		| "mid-execute-after-activity-completed"
		| "execute-before-receipt"
		| "receipt-recorded"
		| "unknown";
	events: CrashHarnessEvent[];
	admissionCount: number;
	startedActivityCount: number;
	completedActivityCount: number;
	receiptCount: number;
	signatureCount: number;
	completedActivityResults: unknown[];
	integrityCheck: string;
}

export interface BootFreshReadOnlyTapeProbeOptions {
	eventsDbPath: string;
	runId: string;
}

interface SignedLedgerProcess {
	child: ChildProcess;
	emitter: TapeEmitter;
	exit: Promise<number>;
}

const RUN_ID = "01919000-0000-7000-8000-000000000707";
const ADMISSION_EVENT_ID = "01919000-0000-7000-8000-000000000701";
const ACTIVITY_ONE_STARTED_ID = "01919000-0000-7000-8000-000000000702";
const ACTIVITY_ONE_COMPLETED_ID = "01919000-0000-7000-8000-000000000703";
const ACTIVITY_TWO_STARTED_ID = "01919000-0000-7000-8000-000000000704";
const ACTIVITY_TWO_COMPLETED_ID = "01919000-0000-7000-8000-000000000705";

const PLAN_ID = "pf-crash-harness";
const DECIDED_AT = "2026-06-05T00:00:00.000Z";

export async function createPlanForgeCrashTape(
	options: CreatePlanForgeCrashTapeOptions,
): Promise<PlanForgeCrashTape> {
	const dir = await mkdtemp(join(tmpdir(), "bp-s7-crash-ws-"));
	const home = await mkdtemp(join(tmpdir(), "bp-s7-crash-home-"));
	const keyDir = join(home, ".buildplane", "keys", "kernel");
	mkdirSync(keyDir, { recursive: true });
	writeFileSync(join(keyDir, "kernel-main.ed25519"), Buffer.alloc(32, 7));

	let ledger: SignedLedgerProcess | undefined;
	let childExited = false;
	try {
		ledger = await spawnSignedLedger(dir, home, RUN_ID);
		ledger.child.on("exit", () => {
			childExited = true;
		});

		const emitted = await emitUntilBoundary(ledger.emitter, options.boundary);
		await haltLedgerAfterBoundary(ledger.child, ledger.exit, () => childExited);

		return {
			boundary: options.boundary,
			dir,
			home,
			eventsDbPath: join(dir, ".buildplane", "ledger", "events.db"),
			runId: RUN_ID,
			expectedKinds: emitted.kinds,
			expectedCompletedActivityResults: emitted.completedResults,
			cleanup: async () => {
				await rm(dir, { recursive: true, force: true });
				await rm(home, { recursive: true, force: true });
			},
		};
	} catch (err) {
		if (ledger && !childExited) {
			ledger.child.kill("SIGTERM");
			await ledger.exit.catch(() => -1);
		}
		await rm(dir, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
		throw err;
	}
}

export async function bootFreshReadOnlyTapeProbe(
	options: BootFreshReadOnlyTapeProbeOptions,
): Promise<PlanForgeCrashTapeState> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(options.eventsDbPath, { readOnly: true });
	try {
		const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{
			integrity_check: string;
		}>;
		const rows = db
			.prepare(
				"SELECT id, kind, payload FROM events WHERE run_id = ? ORDER BY id ASC",
			)
			.all(options.runId) as Array<{
			id: string;
			kind: EventKind;
			payload: string;
		}>;
		const signatureRow = db
			.prepare(
				"SELECT COUNT(*) AS count FROM event_signatures s " +
					"JOIN events e ON e.id = s.event_id WHERE e.run_id = ?",
			)
			.get(options.runId) as { count: number };

		const events = rows.map((row) => ({
			id: row.id,
			kind: row.kind,
			payload: JSON.parse(row.payload) as Record<string, unknown>,
		}));
		const completedActivityResults = events
			.filter((event) => event.kind === "activity_completed")
			.map((event) => {
				const payload = event.payload.ActivityCompletedV1 as {
					result: unknown;
				};
				return payload.result;
			});

		const admissionCount = countKind(events, "plan_admitted");
		const startedActivityCount = countKind(events, "activity_started");
		const completedActivityCount = countKind(events, "activity_completed");
		const receiptCount = countKind(events, "plan_receipt");

		return {
			eventsDbPath: options.eventsDbPath,
			runId: options.runId,
			phase: classifyPhase({
				admissionCount,
				startedActivityCount,
				completedActivityCount,
				receiptCount,
			}),
			events,
			admissionCount,
			startedActivityCount,
			completedActivityCount,
			receiptCount,
			signatureCount: signatureRow.count,
			completedActivityResults,
			integrityCheck: integrity[0]?.integrity_check ?? "missing",
		};
	} finally {
		db.close();
	}
}

export function assertPlanForgeCrashBoundary(
	state: PlanForgeCrashTapeState,
	boundary: PlanForgeCrashBoundary,
): void {
	const expected = expectedForBoundary(boundary);
	const kinds = state.events.map((event) => event.kind);
	assertEqual(
		state.integrityCheck,
		"ok",
		`expected ${boundary} DB integrity ok`,
	);
	assertEqual(state.phase, expected.phase, `expected ${boundary} phase`);
	assertArrayEqual(kinds, expected.kinds, `expected ${boundary} event kinds`);
	assertEqual(
		state.admissionCount,
		1,
		`expected ${boundary} to carry one plan_admitted event`,
	);
	assertEqual(
		state.receiptCount,
		0,
		`expected ${boundary} to halt before plan_receipt`,
	);
	assertEqual(
		state.signatureCount,
		state.events.length,
		`expected ${boundary} to sign every crash-point event`,
	);
	assertArrayEqual(
		state.completedActivityResults,
		expected.completedResults,
		`expected ${boundary} recorded activity results`,
	);
	assertArrayEqual(
		state.events.map((event) => event.id),
		[...state.events.map((event) => event.id)].sort(),
		`expected ${boundary} events ordered by durable event id`,
	);
}

async function spawnSignedLedger(
	dir: string,
	home: string,
	runId: string,
): Promise<SignedLedgerProcess> {
	const binary = resolveNativeBinaryForLedgerTests();
	const child = spawn(
		binary,
		[
			"ledger",
			"serve",
			"--run-id",
			runId,
			"--workspace",
			dir,
			"--schema-version",
			"1",
			"--sign",
			"--signing-key-id",
			"kernel-main",
		],
		{
			stdio: ["pipe", "inherit", "pipe"],
			cwd: LEDGER_TEST_REPO_ROOT,
			env: { ...process.env, HOME: home },
		},
	);
	if (!child.stdin || !child.stderr) {
		throw new Error("signed ledger subprocess stdio unexpectedly missing");
	}
	const exit = new Promise<number>((resolve, reject) => {
		child.on("exit", (code) => resolve(code ?? -1));
		child.on("error", (err) => reject(err));
	});
	exit.catch(() => {});
	const emitter = await createTapeEmitter({
		childStdin: child.stdin as Writable,
		childStderr: child.stderr as Readable,
		childExit: exit,
		workspacePath: dir,
		runId,
		handshakeTimeoutMs: 5_000,
	});
	return { child, emitter, exit };
}

async function emitUntilBoundary(
	emitter: TapeEmitter,
	boundary: PlanForgeCrashBoundary,
): Promise<{ kinds: EventKind[]; completedResults: unknown[] }> {
	const emittedKinds: EventKind[] = [];
	const completedResults: unknown[] = [];

	emitter.emit(
		"plan_admitted",
		{
			PlanAdmittedV1: {
				plan_id: PLAN_ID,
				plan_digest: digest({ plan: PLAN_ID }),
				input_digest: digest({ input: "crash-harness" }),
				trusted_base: "148ad7333d15f7ddc2246f76fbc18cb2046cf01a",
				decided_by: "operator:test",
				decided_at: DECIDED_AT,
				idempotency_key: "planforge:v0:crash-harness:001",
				authorized_next_step: "dispatch_admitted_plan",
			},
		},
		{ id: ADMISSION_EVENT_ID, occurredAt: DECIDED_AT },
	);
	emittedKinds.push("plan_admitted");
	await emitter.flush();
	if (boundary === "admit-before-execute") {
		return { kinds: emittedKinds, completedResults };
	}

	await emitCompletedActivity(emitter, {
		activityId: "pf-task-1",
		startedEventId: ACTIVITY_ONE_STARTED_ID,
		completedEventId: ACTIVITY_ONE_COMPLETED_ID,
		parent: ADMISSION_EVENT_ID,
		result: { status: "passed", output: "activity-1-ok" },
	});
	emittedKinds.push("activity_started", "activity_completed");
	completedResults.push({ status: "passed", output: "activity-1-ok" });
	if (boundary === "after-activity-completed") {
		return { kinds: emittedKinds, completedResults };
	}

	await emitCompletedActivity(emitter, {
		activityId: "pf-task-2",
		startedEventId: ACTIVITY_TWO_STARTED_ID,
		completedEventId: ACTIVITY_TWO_COMPLETED_ID,
		parent: ACTIVITY_ONE_COMPLETED_ID,
		result: { status: "passed", output: "activity-2-ok" },
	});
	emittedKinds.push("activity_started", "activity_completed");
	completedResults.push({ status: "passed", output: "activity-2-ok" });
	return { kinds: emittedKinds, completedResults };
}

async function emitCompletedActivity(
	emitter: TapeEmitter,
	input: {
		activityId: string;
		startedEventId: string;
		completedEventId: string;
		parent: string;
		result: unknown;
	},
): Promise<void> {
	emitter.emit(
		"activity_started",
		{
			ActivityStartedV1: {
				run_id: RUN_ID,
				activity_id: input.activityId,
				activity_type: "command",
				input_digest: digest({ activity: input.activityId, input: "run" }),
			},
		},
		{ id: input.startedEventId, parent: input.parent, occurredAt: DECIDED_AT },
	);
	await emitter.flush();
	emitter.emit(
		"activity_completed",
		{
			ActivityCompletedV1: {
				run_id: RUN_ID,
				activity_id: input.activityId,
				result_digest: digest(input.result),
				result: input.result,
			},
		},
		{
			id: input.completedEventId,
			parent: input.startedEventId,
			occurredAt: DECIDED_AT,
		},
	);
	await emitter.flush();
}

async function haltLedgerAfterBoundary(
	child: ChildProcess,
	exit: Promise<number>,
	childExited: () => boolean,
): Promise<void> {
	if (!childExited()) {
		child.kill("SIGKILL");
		await Promise.race([exit, once(child, "exit")]);
	}
}

function classifyPhase(input: {
	admissionCount: number;
	startedActivityCount: number;
	completedActivityCount: number;
	receiptCount: number;
}): PlanForgeCrashTapeState["phase"] {
	if (input.receiptCount > 0) return "receipt-recorded";
	if (
		input.admissionCount === 1 &&
		input.startedActivityCount === 0 &&
		input.completedActivityCount === 0
	) {
		return "admitted-before-execute";
	}
	if (input.startedActivityCount === 1 && input.completedActivityCount === 1) {
		return "mid-execute-after-activity-completed";
	}
	if (input.startedActivityCount === 2 && input.completedActivityCount === 2) {
		return "execute-before-receipt";
	}
	return "unknown";
}

function expectedForBoundary(boundary: PlanForgeCrashBoundary): {
	phase: PlanForgeCrashTapeState["phase"];
	kinds: EventKind[];
	completedResults: unknown[];
} {
	if (boundary === "admit-before-execute") {
		return {
			phase: "admitted-before-execute",
			kinds: ["plan_admitted"],
			completedResults: [],
		};
	}
	if (boundary === "after-activity-completed") {
		return {
			phase: "mid-execute-after-activity-completed",
			kinds: ["plan_admitted", "activity_started", "activity_completed"],
			completedResults: [{ status: "passed", output: "activity-1-ok" }],
		};
	}
	return {
		phase: "execute-before-receipt",
		kinds: [
			"plan_admitted",
			"activity_started",
			"activity_completed",
			"activity_started",
			"activity_completed",
		],
		completedResults: [
			{ status: "passed", output: "activity-1-ok" },
			{ status: "passed", output: "activity-2-ok" },
		],
	};
}

function countKind(events: CrashHarnessEvent[], kind: EventKind): number {
	return events.filter((event) => event.kind === kind).length;
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(value))
		.digest("hex")}`;
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(
			`${label}: expected ${String(expected)}, got ${String(actual)}`,
		);
	}
}

function assertArrayEqual(
	actual: unknown[],
	expected: unknown[],
	label: string,
): void {
	const actualJson = JSON.stringify(stableJsonValue(actual));
	const expectedJson = JSON.stringify(stableJsonValue(expected));
	if (actualJson !== expectedJson) {
		throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
	}
}

function stableJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableJsonValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, stableJsonValue(nested)]),
		);
	}
	return value;
}
