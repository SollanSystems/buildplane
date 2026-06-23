import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthorizationEnvelopeV0 } from "@buildplane/kernel";
import { createTapeEmitter, type TapeEmitter } from "@buildplane/ledger-client";
import {
	authorizationEnvelopeDigest,
	canonicalEnvelopeJson,
} from "@buildplane/policy";
import {
	assertKernelSigningKey,
	PLANFORGE_KERNEL_SIGNING_KEY_ID,
	resolveLedgerBinary,
	spawnLedgerSubprocess,
} from "./ledger-emit.js";

export interface ParsedEnvelopeArgs {
	readonly envelope: AuthorizationEnvelopeV0;
	readonly decidedBy: string;
	readonly json: boolean;
}

export interface AuthorizeEnvelopePayload {
	readonly run_id: string;
	readonly decision: "approved";
	readonly subject: "authorize-envelope";
	readonly envelope: string;
	readonly decided_by: string;
	readonly decided_at: string;
}

function readFlag(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	const value = index === -1 ? undefined : args[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

function requireFlag(args: readonly string[], flag: string): string {
	const v = readFlag(args, flag)?.trim();
	if (!v) {
		throw new Error(`planforge authorize-envelope requires ${flag}.`);
	}
	return v;
}

function splitCsv(v: string): string[] {
	return v
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Strict non-negative decimal integer parse for signed-envelope budget bounds.
 * `Number.parseInt` accepts trailing garbage (`8xyz` -> 8) and silently rounds
 * values above `Number.MAX_SAFE_INTEGER` before canonical-JSON signing, so the
 * signed wire shape would diverge from the operator's stated bound. Reject
 * anything that is not a plain run of decimal digits, or that exceeds the
 * safe-integer range, BEFORE the envelope is built or signed.
 */
function parseStrictBudget(raw: string, flag: string): number {
	if (!/^\d+$/.test(raw)) {
		throw new Error(`${flag} must be a non-negative decimal integer.`);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw new Error(
			`${flag} must be at most ${Number.MAX_SAFE_INTEGER} (a safe integer).`,
		);
	}
	return value;
}

export function parseEnvelopeArgs(args: readonly string[]): ParsedEnvelopeArgs {
	if (!args.includes("--approve")) {
		throw new Error(
			"planforge authorize-envelope requires explicit --approve to record a signed envelope.",
		);
	}
	const operator = requireFlag(args, "--operator");
	const envelope: AuthorizationEnvelopeV0 = {
		envelope_version: "v0",
		milestone: requireFlag(args, "--milestone"),
		allowed_side_effects: splitCsv(requireFlag(args, "--side-effects")),
		path_globs: splitCsv(requireFlag(args, "--path-globs")),
		max_iterations: parseStrictBudget(
			requireFlag(args, "--max-iterations"),
			"--max-iterations",
		),
		token_budget: parseStrictBudget(
			requireFlag(args, "--token-budget"),
			"--token-budget",
		),
		allowed_verification_cmds: splitCsv(
			requireFlag(args, "--verification-cmds"),
		).map((c) => c.split(/\s+/)[0] ?? c),
		expires_at: requireFlag(args, "--expires-at"),
	};
	if (
		!Number.isInteger(envelope.max_iterations) ||
		envelope.max_iterations <= 0
	) {
		throw new Error("--max-iterations must be a positive integer.");
	}
	if (!Number.isInteger(envelope.token_budget) || envelope.token_budget <= 0) {
		throw new Error("--token-budget must be a positive integer.");
	}
	if (Number.isNaN(Date.parse(envelope.expires_at))) {
		throw new Error("--expires-at must be RFC3339.");
	}
	const decidedBy = operator.startsWith("operator:")
		? operator
		: `operator:${operator}`;
	return { envelope, decidedBy, json: args.includes("--json") };
}

/**
 * Deterministic, UUID-shaped run id from the envelope digest — re-authorizing
 * the IDENTICAL envelope resolves to the same run id, so the repo-root tape
 * de-dups it. The native `ledger serve --run-id` parses this as a `RunId(Uuid)`,
 * so it MUST be syntactically a UUID (mirrors run-cli's planAdmitRunId). This is
 * the envelope's OWN signed emit, NOT the M5-S4 recordOperatorDecision path.
 */
export function envelopeRunId(envelope: AuthorizationEnvelopeV0): string {
	const h = authorizationEnvelopeDigest(envelope).slice("sha256:".length);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function buildAuthorizeEnvelopePayload(
	parsed: ParsedEnvelopeArgs,
	now: Date,
): AuthorizeEnvelopePayload {
	return {
		run_id: envelopeRunId(parsed.envelope),
		decision: "approved",
		subject: "authorize-envelope",
		envelope: canonicalEnvelopeJson(parsed.envelope),
		decided_by: parsed.decidedBy,
		decided_at: now.toISOString(),
	};
}

interface OperatorDecisionEventRow {
	id: string;
	payload: string;
}

interface KernelSignatureRow {
	actor_id?: string;
	key_id?: string;
	algorithm?: string;
}

/**
 * A matching events row may only suppress emission if it carries a kernel
 * Ed25519 signature. Structural signature check only (actor / key / algorithm
 * columns) — full byte verification is the external verifier's job (M3), and the
 * CLI has no in-process Ed25519 verifier. This mirrors run-cli's
 * `assertKernelSignature`. Without it, a forged/unsigned local `events` row
 * (no `event_signatures` entry, or a wrong actor/key) would make the probe
 * report `already_authorized` and suppress a real authorization (GAP-10 P2).
 */
function isKernelSigned(signature: KernelSignatureRow | undefined): boolean {
	return (
		signature?.actor_id === "kernel" &&
		signature.key_id === PLANFORGE_KERNEL_SIGNING_KEY_ID &&
		signature.algorithm === "ed25519"
	);
}

/**
 * Probe the repo-root tape for an already-recorded authorize-envelope decision
 * on this run id whose envelope matches byte-for-byte AND carries a kernel
 * signature. The native ledger does not dedupe by run id, so re-authorizing the
 * identical envelope is made a no-op here (mirrors run-cli's
 * findExistingPlanAdmitted), keyed on the deterministic envelope digest -> run
 * id. An unsigned or non-kernel-signed matching row is NOT treated as
 * authorized — it must not suppress a real signed emit.
 */
export async function findExistingAuthorizeEnvelope(
	workspace: string,
	runId: string,
	canonicalEnvelope: string,
): Promise<string | undefined> {
	const eventsDbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	if (!existsSync(eventsDbPath)) {
		return undefined;
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				"SELECT id, payload FROM events WHERE run_id = ? AND kind = 'operator_decision_recorded' ORDER BY id ASC",
			)
			.all(runId) as unknown as OperatorDecisionEventRow[];
		for (const row of rows) {
			const payload = JSON.parse(row.payload) as {
				OperatorDecisionRecordedV1?: {
					subject?: string;
					envelope?: string;
				};
			};
			const record = payload.OperatorDecisionRecordedV1;
			if (
				record?.subject !== "authorize-envelope" ||
				record.envelope !== canonicalEnvelope
			) {
				continue;
			}
			const signature = db
				.prepare(
					"SELECT actor_id, key_id, algorithm FROM event_signatures WHERE event_id = ?",
				)
				.get(row.id) as KernelSignatureRow | undefined;
			if (isKernelSigned(signature)) {
				return row.id;
			}
		}
		return undefined;
	} finally {
		db.close();
	}
}

/**
 * Load the active authorization envelope the supervisor loop runs under: the
 * LATEST (by `decided_at`) kernel-signed `authorize-envelope` decision on the
 * repo-root tape that has not yet expired at `now`. A forged/unsigned row is
 * rejected (GAP-10 P2) — the loop must never run under an unsigned envelope —
 * and an expired-only row returns null so the loop pauses for re-authorization.
 */
export async function loadActiveAuthorizationEnvelope(
	workspace: string,
	now: Date = new Date(),
): Promise<{ envelope: AuthorizationEnvelopeV0; eventId: string } | null> {
	const eventsDbPath = resolve(workspace, ".buildplane", "ledger", "events.db");
	if (!existsSync(eventsDbPath)) {
		return null;
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(eventsDbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				"SELECT id, payload FROM events WHERE kind = 'operator_decision_recorded' ORDER BY id ASC",
			)
			.all() as unknown as OperatorDecisionEventRow[];
		let best:
			| {
					envelope: AuthorizationEnvelopeV0;
					eventId: string;
					decidedAt: number;
			  }
			| undefined;
		for (const row of rows) {
			const payload = JSON.parse(row.payload) as {
				OperatorDecisionRecordedV1?: {
					subject?: string;
					envelope?: string;
					decided_at?: string;
				};
			};
			const record = payload.OperatorDecisionRecordedV1;
			if (record?.subject !== "authorize-envelope" || !record.envelope) {
				continue;
			}
			const signature = db
				.prepare(
					"SELECT actor_id, key_id, algorithm FROM event_signatures WHERE event_id = ?",
				)
				.get(row.id) as KernelSignatureRow | undefined;
			if (!isKernelSigned(signature)) {
				continue;
			}
			const envelope = JSON.parse(record.envelope) as AuthorizationEnvelopeV0;
			if (!(now.getTime() < Date.parse(envelope.expires_at))) {
				continue; // expired — does not authorize.
			}
			const decidedAt = Date.parse(record.decided_at ?? "") || 0;
			if (!best || decidedAt >= best.decidedAt) {
				best = { envelope, eventId: row.id, decidedAt };
			}
		}
		return best ? { envelope: best.envelope, eventId: best.eventId } : null;
	} finally {
		db.close();
	}
}

export async function runPlanForgeAuthorizeEnvelopeCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	const parsed = parseEnvelopeArgs(args);
	const payload = buildAuthorizeEnvelopePayload(parsed, new Date());
	const workspace = resolve(cwd);

	const existingEventId = await findExistingAuthorizeEnvelope(
		workspace,
		payload.run_id,
		payload.envelope,
	);
	if (existingEventId) {
		stdout(
			parsed.json
				? JSON.stringify(
						{
							status: "already_authorized",
							run_id: payload.run_id,
							event_id: existingEventId,
							payload,
						},
						null,
						2,
					)
				: `Envelope for ${parsed.envelope.milestone} is already authorized; no new tape event written.`,
		);
		return 0;
	}

	assertKernelSigningKey();
	const binary = resolveLedgerBinary(cwd);
	const ledgerChild = spawnLedgerSubprocess(binary, payload.run_id, workspace, {
		sign: true,
		signingKeyId: PLANFORGE_KERNEL_SIGNING_KEY_ID,
	});
	let emitter: TapeEmitter;
	try {
		emitter = await createTapeEmitter({
			childStdin: ledgerChild.stdin,
			childStderr: ledgerChild.stderr,
			childExit: ledgerChild.exit,
			workspacePath: workspace,
			runId: payload.run_id,
		});
	} catch (err) {
		if (ledgerChild.child.exitCode === null) {
			ledgerChild.child.kill("SIGTERM");
		}
		throw new Error(
			`authorize-envelope: signed ledger handshake failed: ${String(err)}`,
		);
	}
	try {
		emitter.emit("operator_decision_recorded", {
			OperatorDecisionRecordedV1: payload,
		});
		await emitter.flush();
		await emitter.close();
	} catch (err) {
		if (ledgerChild.child.exitCode === null) {
			ledgerChild.child.kill("SIGTERM");
		}
		throw new Error(
			`authorize-envelope: failed to append signed operator_decision_recorded: ${String(err)}`,
		);
	}
	const eventId = emitter.stats().lastAckedEventId ?? undefined;
	stdout(
		parsed.json
			? JSON.stringify(
					{
						status: "authorized",
						run_id: payload.run_id,
						event_id: eventId,
						payload,
					},
					null,
					2,
				)
			: `Authorized envelope for ${parsed.envelope.milestone} (signed operator_decision_recorded on run ${payload.run_id}).`,
	);
	return 0;
}
