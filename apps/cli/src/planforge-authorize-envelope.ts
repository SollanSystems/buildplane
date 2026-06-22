import { resolve } from "node:path";
import type { AuthorizationEnvelopeV0 } from "@buildplane/kernel";
import { createTapeEmitter, type TapeEmitter } from "@buildplane/ledger-client";
import {
	authorizationEnvelopeDigest,
	canonicalEnvelopeJson,
} from "@buildplane/policy";
import {
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
		max_iterations: Number.parseInt(requireFlag(args, "--max-iterations"), 10),
		token_budget: Number.parseInt(requireFlag(args, "--token-budget"), 10),
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
 * Deterministic run id from the envelope digest — re-authorizing the IDENTICAL
 * envelope resolves to the same run id, so the repo-root tape de-dups it. This
 * is the envelope's OWN signed emit, NOT the M5-S4 recordOperatorDecision path.
 */
export function envelopeRunId(envelope: AuthorizationEnvelopeV0): string {
	const hex = authorizationEnvelopeDigest(envelope).slice("sha256:".length);
	return `pf-envelope-${hex.slice(0, 16)}`;
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

export async function runPlanForgeAuthorizeEnvelopeCommand(
	args: readonly string[],
	cwd: string,
	stdout: (line: string) => void,
): Promise<number> {
	const parsed = parseEnvelopeArgs(args);
	const payload = buildAuthorizeEnvelopePayload(parsed, new Date());
	const workspace = resolve(cwd);
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
