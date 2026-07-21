import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthorizationEnvelopeV0 } from "@buildplane/kernel";
import {
	authorizationEnvelopeDigest,
	canonicalEnvelopeJson,
} from "@buildplane/policy";
import { GOVERNED_AUTHORITY_BROKER_REQUIRED } from "./governed-ledger-authority.js";

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
	const valueFlags = new Set([
		"--operator",
		"--milestone",
		"--side-effects",
		"--path-globs",
		"--max-iterations",
		"--token-budget",
		"--verification-cmds",
		"--expires-at",
	]);
	const values = new Map<string, string>();
	let approve = false;
	let json = false;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--approve") {
			if (approve) {
				throw new Error("Duplicate --approve flag.");
			}
			approve = true;
			continue;
		}
		if (argument === "--json") {
			if (json) {
				throw new Error("Duplicate --json flag.");
			}
			json = true;
			continue;
		}
		if (!valueFlags.has(argument)) {
			throw new Error(
				`Unsupported planforge authorize-envelope argument: ${argument}.`,
			);
		}
		if (values.has(argument)) {
			throw new Error(`Duplicate ${argument} flag.`);
		}
		const value = args[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`planforge authorize-envelope requires ${argument}.`);
		}
		values.set(argument, value.trim());
		index += 1;
	}

	const requireFlag = (flag: string): string => {
		const value = values.get(flag);
		if (!value) {
			throw new Error(`planforge authorize-envelope requires ${flag}.`);
		}
		return value;
	};

	if (!approve) {
		throw new Error(
			"planforge authorize-envelope requires explicit --approve to record a signed envelope.",
		);
	}
	const operator = requireFlag("--operator");
	const envelope: AuthorizationEnvelopeV0 = {
		envelope_version: "v0",
		milestone: requireFlag("--milestone"),
		allowed_side_effects: splitCsv(requireFlag("--side-effects")),
		path_globs: splitCsv(requireFlag("--path-globs")),
		max_iterations: parseStrictBudget(
			requireFlag("--max-iterations"),
			"--max-iterations",
		),
		token_budget: parseStrictBudget(
			requireFlag("--token-budget"),
			"--token-budget",
		),
		allowed_verification_cmds: splitCsv(requireFlag("--verification-cmds")).map(
			(c) => c.split(/\s+/)[0] ?? c,
		),
		expires_at: requireFlag("--expires-at"),
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
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
			envelope.expires_at,
		) ||
		Number.isNaN(Date.parse(envelope.expires_at))
	) {
		throw new Error("--expires-at must be RFC3339.");
	}
	if (Date.parse(envelope.expires_at) <= Date.now()) {
		throw new Error("--expires-at must be in the future.");
	}
	const decidedBy = operator.startsWith("operator:")
		? operator
		: `operator:${operator}`;
	return { envelope, decidedBy, json };
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
 * `event_signatures` is mutable SQLite metadata, not a trust root. The CLI has
 * neither the native canonical-event serializer nor a trusted public-key
 * registry, so it cannot safely establish a detached Ed25519 verification from
 * this row. Fail closed until a reducer-verified projection is supplied by the
 * native ledger; actor/key/algorithm labels alone never authorize anything.
 */
function isKernelSigned(_signature: KernelSignatureRow | undefined): boolean {
	return false;
}

/**
 * Probe the repo-root tape for an already-recorded authorize-envelope decision
 * on this run id whose envelope matches byte-for-byte and has been
 * cryptographically verified by the native ledger. The current CLI deliberately
 * has no such verifier, so this returns no trusted match rather than treating
 * mutable signature metadata as authority.
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
 * LATEST (by `decided_at`) cryptographically verified `authorize-envelope`
 * decision on the repo-root tape that has not yet expired at `now`. Until the
 * native reducer exposes that verification result, no mutable SQLite row is
 * considered active authority.
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
	_args: readonly string[],
	_cwd: string,
	_stdout: (line: string) => void,
): Promise<never> {
	/**
	 * A V0 CLI-generated envelope is not an externally verified V3 dispatch
	 * authority. The controller must never use its own native subprocess as a
	 * signing substitute: until the isolated broker returns a verified V3
	 * authority statement, do not parse, probe, append, or report authority.
	 */
	throw new Error(GOVERNED_AUTHORITY_BROKER_REQUIRED);
}
