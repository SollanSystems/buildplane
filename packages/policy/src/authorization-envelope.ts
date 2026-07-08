import { createHash } from "node:crypto";
import type {
	AuthorizationEnvelopeV0,
	EnvelopeProposal,
} from "@buildplane/kernel";
import { segmentGlobIsSubset } from "./segment-glob.js";

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
 * A proposal glob `child` is covered by an envelope glob `parent` iff every
 * path `child` matches is also matched by `parent` under the shared
 * segment-glob semantics (the broker's minimatch semantics) — so a
 * middle-wildcard envelope glob like `packages/**\/src/**` covers the
 * concrete `packages/kernel/src/**`. Fail-closed normalization
 * (absolute/traversal/NUL rejection) lives inside `segmentGlobIsSubset`;
 * a glob that does not normalize is never a subset of anything.
 */
function globIsSubset(child: string, parent: string): boolean {
	return segmentGlobIsSubset(child, parent);
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
