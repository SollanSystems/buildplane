/**
 * The public shape of an OS-authenticated host integration. The CLI can ask a
 * host to open a candidate-only session, but it cannot create, register, or
 * unwrap this capability itself.
 *
 * The private symbol brands deliberately make these values opaque to normal
 * TypeScript callers. A future privileged host integration owns validation of
 * the input, admission, dispatch, and candidate execution contract.
 */
import type { CandidateCreatedV2, ReviewVerdictV1 } from "@buildplane/kernel";

declare const hostOwnedGovernedBrokerBrand: unique symbol;
declare const hostOwnedCandidateSessionBrand: unique symbol;
declare const hostOwnedCandidateRunResultBrand: unique symbol;
declare const hostOwnedReviewerSessionBrand: unique symbol;
declare const hostOwnedReviewerRunResultBrand: unique symbol;
declare const hostOwnedPlanForgeAdmissionBrand: unique symbol;

export type HostOwnedCandidateApprovalV1 =
	| "operator-requested"
	| {
			readonly preauthorizationRef: string;
	  }
	| {
			/**
			 * Exact untrusted bytes supplied through `buildplane run --envelope`.
			 * The CLI has checked only the closed V3 shape and canonical digest; the
			 * privileged host must independently parse these bytes, resolve their
			 * signed-tape provenance, verify the detached signature and expiry, and
			 * bind them to the packet and repository before any activity is opened.
			 * This is deliberately source rather than a CLI-derived digest or broker
			 * reference, so the CLI cannot manufacture preauthorization identity.
			 */
			readonly preauthorizedEnvelopeSource: string;
	  };

/**
 * Opening a new candidate deliberately preserves the original packet source.
 * Governed authority must be derived and verified by the privileged host,
 * never synthesized from a parsed packet or envelope passed by the CLI.
 */
export interface HostOwnedNewCandidateSessionOpenInputV1 {
	readonly kind: "new-candidate";
	readonly packetSource: string;
	readonly projectRoot: string;
	readonly approval: HostOwnedCandidateApprovalV1;
}

export type HostOwnedCandidateSessionOpenInputV1 =
	HostOwnedNewCandidateSessionOpenInputV1;

/**
 * PlanForge admission carries the original file bytes, not a CLI-compiled plan
 * or a locally-derived digest. The privileged host owns parsing, task binding,
 * content addressing, signed-tape verification, expiry, and repository scope.
 */
export interface HostOwnedPlanForgeAdmissionInputV1 {
	readonly kind: "planforge-admission";
	readonly planSource: Uint8Array;
	readonly projectRoot: string;
	readonly approval: "operator-requested";
}

/**
 * The host returns display-safe handles only. Neither reference is accepted as
 * a signature, envelope, task definition, or promotion capability by the CLI.
 */
export interface HostOwnedPlanForgeAdmissionV1 {
	readonly kind: "host-owned-planforge-admission-v1";
	readonly admissionRef: string;
	readonly taskRefs: readonly string[];
	readonly planSourceDigest: string;
	readonly admissionDigest: string;
	readonly [hostOwnedPlanForgeAdmissionBrand]: true;
}

/**
 * Opens a candidate session for a task the privileged host already admitted.
 * The CLI forwards only display-safe, host-issued references; it must not
 * reconstruct a plan, packet, envelope, task definition, or authority from
 * either reference. The host resolves both references from its protected
 * workflow/tape state and rejects mismatched, expired, revoked, replayed, or
 * non-atomic task authority before it opens an activity.
 */
export interface HostOwnedPlanForgeCandidateSessionOpenInputV1 {
	readonly kind: "planforge-candidate-session-open-v1";
	readonly schemaVersion: 1;
	readonly projectRoot: string;
	readonly admissionRef: string;
	readonly taskRef: string;
}

/**
 * Signed candidate-completion binding for a PlanForge task. Reference digests
 * are SHA-256 over UTF-8 `"buildplane.planforge-host-reference.v1\\0" + ref`.
 * The repository identity is SHA-256 over UTF-8
 * `"buildplane.planforge-repository-identity.v1\\0" + canonical JSON` with
 * the real project root, target ref, base commit, and base tree. A host must
 * embed this exact closed record in the signed completion proof it verifies
 * before returning a result to the CLI.
 */
export interface HostPlanForgeCandidateBindingV1 {
	readonly schemaVersion: 1;
	readonly admissionRefDigest: string;
	readonly taskRefDigest: string;
	readonly repositoryIdentityDigest: string;
}

/**
 * A recovery resume deliberately contains no packet or envelope. The host
 * must reconstruct the exact workflow from the protected tape/reducer state
 * identified by `recoveryReference`; caller-supplied source must never alter a
 * recovered activity identity or authority decision. `approval` is an
 * operator acknowledgement to reconcile this existing identity, never new
 * dispatch or promotion authority.
 */
export interface HostOwnedRecoverySessionOpenInputV1 {
	readonly projectRoot: string;
	readonly recoveryReference: string;
	readonly approval: "operator-requested";
}

/**
 * Open the one reviewer activity already declared by a recovered governed
 * workflow. The CLI can provide only an opaque recovery reference and a local
 * repository root for host binding; it cannot select a candidate, reviewer,
 * model, tool catalog, context, sandbox, or promotion decision.
 *
 * The privileged host must resolve the candidate, passed acceptance record,
 * and independent sealed-V3 reviewer dispatch from trusted recovery state. It
 * must mount the candidate read-only with no network or secrets, record the
 * review activity and its closed `ReviewVerdictRecordedV2`, and treat a retry
 * as lookup of the original activity identity rather than a second model call.
 */
export interface HostOwnedReviewerSessionOpenInputV1 {
	readonly kind: "governed-reviewer-session-open-v1";
	readonly schemaVersion: 1;
	readonly projectRoot: string;
	readonly recoveryReference: string;
}

/**
 * A native-verifiable, candidate-only completion receipt. `candidate` uses
 * the same closed V2 shape that is appended to the signed tape. The host must
 * resolve `nativeReceiptRef`, verify its detached signature and tape root in
 * a privileged/native boundary, and ensure every displayed field exactly
 * matches that receipt before returning it to the CLI.
 *
 * This data is evidence, not a promotion capability. The CLI validates its
 * closed shape and root binding, but never treats a TypeScript object or its
 * private symbol brand as signature proof.
 */
export interface HostVerifiedCandidateReceiptV1 {
	readonly schemaVersion: 1;
	/** Durable workflow/activity identity allocated before the first effect. */
	readonly recoveryRef: string;
	/** Checked-out target branch recorded before candidate execution. */
	readonly targetRef: string;
	/** Exact immutable candidate event materialized by the signed tape. */
	readonly candidate: CandidateCreatedV2;
	/** Signed-tape event identity for `candidate_created_v2`. */
	readonly candidateCreatedEventRef: string;
	/** Exact signed candidate-completion proof for the create-candidate action. */
	readonly candidateCompletionEventRef: string;
	/** Canonical digest of that closed candidate-completion proof. */
	readonly candidateCompletionDigest: string;
	/** Verified tape root that includes the candidate event and receipt lineage. */
	readonly tapeRootDigest: string;
	/** Opaque native receipt location; never a local path or authority token. */
	readonly nativeReceiptRef: string;
	/** Digest of the exact native signed receipt resolved by `nativeReceiptRef`. */
	readonly nativeReceiptDigest: string;
}

/**
 * Additive receipt binding for fresh governed candidate sessions. The
 * privileged host derives this digest from the exact closed governed packet
 * bound into its sealed V3 dispatch envelope. It is evidence only: the CLI
 * recomputes it from the original caller bytes to detect a mismatched host
 * result, while detached-signature and tape-root verification remain native
 * host responsibilities.
 */
export interface HostVerifiedCandidateReceiptV2
	extends Omit<HostVerifiedCandidateReceiptV1, "schemaVersion"> {
	readonly schemaVersion: 2;
	readonly governedPacketDigest: string;
}

/** A candidate receipt whose signed completion is bound to one PlanForge task. */
export interface HostVerifiedPlanForgeCandidateReceiptV1
	extends HostVerifiedCandidateReceiptV1 {
	readonly planForgeBinding: HostPlanForgeCandidateBindingV1;
}

/**
 * Display-safe evidence that the privileged host recorded one closed review.
 * The refs and digest are not capabilities: consumers must resolve the native
 * receipt and verify its signed tape/root before treating any field as
 * evidence. In particular, no review receipt grants promotion authority.
 */
export interface HostVerifiedReviewReceiptV1 {
	readonly schemaVersion: 1;
	readonly recoveryRef: string;
	readonly candidateCreatedEventRef: string;
	readonly candidateCompletionEventRef: string;
	readonly candidateDigest: string;
	readonly acceptanceEventRef: string;
	readonly acceptanceDigest: string;
	readonly reviewerDispatchEventRef: string;
	readonly reviewerDispatchEnvelopeDigest: string;
	readonly reviewVerdictEventRef: string;
	readonly verdict: ReviewVerdictV1;
	readonly tapeRootDigest: string;
	readonly nativeReceiptRef: string;
	readonly nativeReceiptDigest: string;
}

/**
 * Opaque result of a candidate-only run. It intentionally provides no target
 * repository mutation, raw executor, or authority material. The durable
 * recovery identity is repeated so the CLI can retain it if receipt parsing or
 * local root-integrity validation fails after an external effect.
 */
export interface HostOwnedCandidateRunResultV1 {
	readonly kind: "host-owned-governed-candidate-run-result-v1";
	readonly recoveryRef: string;
	readonly candidateReceipt: HostVerifiedCandidateReceiptV1;
	readonly [hostOwnedCandidateRunResultBrand]: true;
}

/** A V2 host completion carries the exact governed-packet evidence binding. */
export interface HostOwnedCandidateRunResultV2 {
	readonly kind: "host-owned-governed-candidate-run-result-v1";
	readonly recoveryRef: string;
	readonly candidateReceipt: HostVerifiedCandidateReceiptV2;
	readonly [hostOwnedCandidateRunResultBrand]: true;
}

export type HostOwnedCandidateRunResult =
	| HostOwnedCandidateRunResultV1
	| HostOwnedCandidateRunResultV2;

/**
 * An opaque host-owned session. Its sole executable operation is a
 * candidate-only run; promotion is outside this interface.
 */
export interface HostOwnedCandidateSessionV1 {
	readonly kind: "host-owned-governed-candidate-session-v1";
	/**
	 * The host must persist this opaque recovery identity before returning the
	 * session and before any model, tool, Git, network, or secret effect.
	 */
	readonly recoveryRef: string;
	readonly run: () => Promise<HostOwnedCandidateRunResult>;
	readonly [hostOwnedCandidateSessionBrand]: true;
}

/**
 * Opaque host-owned reviewer session. Its sole executable operation is the
 * already declared, technically read-only reviewer activity. It has no worker
 * selection, generic callback, action gateway, secret, Git, or promotion
 * surface.
 */
export interface HostOwnedReviewerSessionV1 {
	readonly kind: "host-owned-governed-reviewer-session-v1";
	readonly recoveryRef: string;
	readonly run: () => Promise<HostOwnedReviewerRunResultV1>;
	readonly [hostOwnedReviewerSessionBrand]: true;
}

/**
 * Opaque result of the one host-owned reviewer activity. The semantic verdict
 * is nested in a display receipt, but the result intentionally contains no
 * boolean promotion eligibility, decision handle, or target mutation API.
 */
export interface HostOwnedReviewerRunResultV1 {
	readonly kind: "host-owned-governed-reviewer-run-result-v1";
	readonly recoveryRef: string;
	readonly reviewReceipt: HostVerifiedReviewReceiptV1;
	readonly [hostOwnedReviewerRunResultBrand]: true;
}

/**
 * PlanForge has its own closed candidate-session/result contract so an opaque
 * admission/task pair cannot be confused with another governed candidate.
 */
export interface HostOwnedPlanForgeCandidateRunResultV1 {
	readonly kind: "host-owned-planforge-candidate-run-result-v1";
	readonly schemaVersion: 1;
	readonly recoveryRef: string;
	readonly candidateReceipt: HostVerifiedPlanForgeCandidateReceiptV1;
	readonly [hostOwnedCandidateRunResultBrand]: true;
}

export interface HostOwnedPlanForgeCandidateSessionV1 {
	readonly kind: "host-owned-planforge-candidate-session-v1";
	readonly schemaVersion: 1;
	readonly recoveryRef: string;
	readonly run: () => Promise<HostOwnedPlanForgeCandidateRunResultV1>;
	readonly [hostOwnedCandidateSessionBrand]: true;
}

/**
 * A capability originating in a privileged host integration, rather than the
 * CLI process. There is intentionally no exported construction or registration
 * API for this interface.
 */
export interface HostOwnedGovernedBrokerV1 {
	readonly kind: "host-owned-governed-broker-v1";
	/**
	 * Admit exact untrusted PlanForge source through the privileged host. This is
	 * intentionally distinct from opening a candidate session: admission does
	 * not hand the CLI a packet, envelope, signer, tape writer, executor, or
	 * promotion authority.
	 */
	readonly admitPlanForge: (
		input: HostOwnedPlanForgeAdmissionInputV1,
	) => Promise<HostOwnedPlanForgeAdmissionV1>;
	/**
	 * Opens exactly one immutable candidate session for an already admitted
	 * PlanForge task. This intentionally accepts only the host-owned admission
	 * and task references plus the project root. It has no plan source, worker
	 * flags, ambient executor, signer, tape writer, or promotion surface.
	 */
	readonly openPlanForgeCandidateSession: (
		input: HostOwnedPlanForgeCandidateSessionOpenInputV1,
	) => Promise<HostOwnedPlanForgeCandidateSessionV1>;
	/**
	 * Opens one sealed, atomic, implementer candidate session. The privileged
	 * host—not the CLI—must strict-parse and content-address `packetSource`,
	 * bind it to a broker-owned repository target, verify the detached broker
	 * admission plus fresh tape/reducer projection, and initialize a rootless
	 * OCI ActionGateway before returning. It must reject expired, stale,
	 * unsigned, non-atomic, non-implementer, or replay-inconsistent input.
	 *
	 * `openRecoverySession` must resolve and reconcile the existing workflow
	 * exclusively from `recoveryReference`, rejecting an expired lease,
	 * unknown effect, mismatched actor, or stale reducer/tape state. A resume
	 * must never create a fresh attempt or accept caller-provided replacement
	 * authority.
	 *
	 * The returned session may create an immutable candidate only. It must not
	 * reveal signer material, raw executors, tape write credentials, or any
	 * promotion operation.
	 */
	readonly openCandidateSession: (
		input: HostOwnedCandidateSessionOpenInputV1,
	) => Promise<HostOwnedCandidateSessionV1>;
	/**
	 * Open the predeclared reviewer activity for one recovered candidate
	 * workflow. This is deliberately distinct from candidate execution and
	 * promotion: the host resolves all candidate, acceptance, role, manifest,
	 * sandbox, and activity identities from protected tape/reducer state.
	 */
	readonly openReviewerSession: (
		input: HostOwnedReviewerSessionOpenInputV1,
	) => Promise<HostOwnedReviewerSessionV1>;
	/**
	 * Recover one host-recorded workflow. Kept separate from fresh admission so
	 * a recovery call cannot carry a replacement packet, envelope, or preauth.
	 */
	readonly openRecoverySession: (
		input: HostOwnedRecoverySessionOpenInputV1,
	) => Promise<HostOwnedCandidateSessionV1>;
	readonly [hostOwnedGovernedBrokerBrand]: true;
}

/**
 * Resolves a capability provided by an OS-authenticated host integration.
 *
 * This distribution has no privileged host integration yet. It intentionally
 * performs no environment, command-line, filesystem, network, global, or
 * fallback lookup; governed callers must treat `undefined` as blocked.
 */
export async function resolveHostOwnedGovernedBroker(): Promise<
	HostOwnedGovernedBrokerV1 | undefined
> {
	return undefined;
}
