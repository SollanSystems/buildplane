import { createHash } from "node:crypto";
import type {
	AuthorizationEnvelopeV0,
	EnvelopeProposal,
} from "@buildplane/kernel";

export interface EnvelopeAdmissionEvaluation {
	readonly gate: "authorization.envelope";
	readonly status: "admitted" | "paused";
	readonly milestoneMatches: boolean;
	readonly outOfEnvelopeSideEffects: readonly string[];
	readonly outOfEnvelopePathGlobs: readonly string[];
	readonly outOfEnvelopeVerificationCmds: readonly string[];
	readonly expired: boolean;
	readonly reasons: readonly string[];
}

export interface EnvelopePausedDecision {
	readonly outcome: "paused";
	readonly kind: "authorization.envelope";
	readonly reasons: readonly string[];
}

/**
 * Pure subset-admission gate. A proposal is auto-admitted iff it is a SUBSET of
 * the operator-authorized envelope: the milestone matches, every proposed side
 * effect is in `allowed_side_effects`, every proposed path glob is covered by
 * some envelope `path_glob`, every proposed verification command's argv0 is in
 * `allowed_verification_cmds`, and the envelope has not expired. Anything else
 * pauses for explicit operator review.
 */
export function evaluateEnvelopeAdmission(
	proposal: EnvelopeProposal,
	envelope: AuthorizationEnvelopeV0,
	now: Date,
): EnvelopeAdmissionEvaluation {
	const milestoneMatches = proposal.milestone === envelope.milestone;
	const allowedSideEffects = new Set(envelope.allowed_side_effects);
	const allowedCmds = new Set(envelope.allowed_verification_cmds);
	const expired = !(now.getTime() < Date.parse(envelope.expires_at));
	const outOfEnvelopeSideEffects = unique(
		proposal.sideEffects.filter((e) => !allowedSideEffects.has(e)),
	);
	const outOfEnvelopePathGlobs = unique(
		proposal.pathGlobs.filter(
			(g) => !envelope.path_globs.some((p) => globIsSubset(g, p)),
		),
	);
	const outOfEnvelopeVerificationCmds = unique(
		proposal.verificationCommands
			.map(argv0)
			.filter((c) => c.length > 0 && !allowedCmds.has(c)),
	);
	const reasons: string[] = [];
	if (!milestoneMatches) {
		reasons.push(
			`authorization.envelope paused: proposal milestone ${proposal.milestone} != envelope milestone ${envelope.milestone}.`,
		);
	}
	if (expired) {
		reasons.push(
			`authorization.envelope paused: envelope expired at ${envelope.expires_at}.`,
		);
	}
	for (const e of outOfEnvelopeSideEffects) {
		reasons.push(
			`authorization.envelope paused: side effect ${e} not in allowed_side_effects.`,
		);
	}
	for (const g of outOfEnvelopePathGlobs) {
		reasons.push(
			`authorization.envelope paused: path glob ${g} not covered by envelope path_globs.`,
		);
	}
	for (const c of outOfEnvelopeVerificationCmds) {
		reasons.push(
			`authorization.envelope paused: verification command ${c} not in allowed_verification_cmds.`,
		);
	}
	return {
		gate: "authorization.envelope",
		status: reasons.length === 0 ? "admitted" : "paused",
		milestoneMatches,
		outOfEnvelopeSideEffects,
		outOfEnvelopePathGlobs,
		outOfEnvelopeVerificationCmds,
		expired,
		reasons,
	};
}

export function envelopeAdmissionDecision(
	e: EnvelopeAdmissionEvaluation,
): EnvelopePausedDecision | undefined {
	if (e.status === "admitted") {
		return undefined;
	}
	return {
		outcome: "paused",
		kind: "authorization.envelope",
		reasons: e.reasons,
	};
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function argv0(command: string): string {
	return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * Reject traversal/absolute/NUL globs (fail closed) before any subset check,
 * mirroring diff-scope's normalizePattern null-rejection. A glob that does not
 * normalize is never a subset of anything, so a malformed proposal glob pauses.
 */
function normalizeGlob(glob: string): string | null {
	const trimmed = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (
		!trimmed ||
		trimmed.includes("\0") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("../") ||
		trimmed.includes("/../")
	) {
		return null;
	}
	return trimmed;
}

/**
 * A proposal glob `child` is covered by an envelope glob `parent` iff, after
 * fail-closed normalization, `parent` is `**`, `parent` equals `child`, or
 * `parent` is a `<prefix>/**` whose prefix is a path-prefix of `child` (so
 * `src/**` covers `src/kernel/**`).
 */
function globIsSubset(child: string, parent: string): boolean {
	const c = normalizeGlob(child);
	const p = normalizeGlob(parent);
	if (c === null || p === null) {
		return false;
	}
	if (p === "**") {
		return true;
	}
	if (p === c) {
		return true;
	}
	if (p.endsWith("/**")) {
		const prefix = p.slice(0, -3);
		const cPrefix = c.endsWith("/**") ? c.slice(0, -3) : c;
		return cPrefix === prefix || cPrefix.startsWith(`${prefix}/`);
	}
	return false;
}

function canonical(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	const src = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(src).sort()) {
		if (src[key] === undefined) {
			continue;
		}
		out[key] = canonical(src[key]);
	}
	return out;
}

/**
 * Canonical JSON of an authorization envelope: keys sorted recursively,
 * `undefined` dropped. This is the exact string stored in the signed
 * `operator_decision_recorded.envelope` field and hashed for the digest.
 */
export function canonicalEnvelopeJson(
	envelope: AuthorizationEnvelopeV0,
): string {
	return JSON.stringify(canonical(envelope)) ?? "null";
}

export function authorizationEnvelopeDigest(
	envelope: AuthorizationEnvelopeV0,
): string {
	return `sha256:${createHash("sha256").update(canonicalEnvelopeJson(envelope), "utf8").digest("hex")}`;
}
