import { describe, expect, it } from "vitest";
import {
	type HostOwnedCandidateSessionOpenInputV1,
	type HostOwnedCandidateSessionV1,
	type HostOwnedGovernedBrokerV1,
	type HostOwnedPlanForgeAdmissionInputV1,
	type HostOwnedPlanForgeAdmissionV1,
	type HostOwnedPlanForgeCandidateSessionOpenInputV1,
	type HostOwnedPlanForgeCandidateSessionV1,
	type HostOwnedRecoverySessionOpenInputV1,
	type HostOwnedReviewerRunResultV1,
	type HostOwnedReviewerSessionOpenInputV1,
	type HostOwnedReviewerSessionV1,
	resolveHostOwnedGovernedBroker,
} from "../src/governed-authority-broker-host.js";

type Assert<T extends true> = T;
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <
		Value,
	>() => Value extends Right ? 1 : 2
		? true
		: false;

type CandidateSessionInputKeys = Extract<
	keyof HostOwnedCandidateSessionOpenInputV1,
	string
>;
type CandidateSessionKeys = Extract<keyof HostOwnedCandidateSessionV1, string>;
type HostBrokerKeys = Extract<keyof HostOwnedGovernedBrokerV1, string>;
type RecoverySessionInputKeys = Extract<
	keyof HostOwnedRecoverySessionOpenInputV1,
	string
>;
type PlanForgeAdmissionInputKeys = Extract<
	keyof HostOwnedPlanForgeAdmissionInputV1,
	string
>;
type PlanForgeAdmissionKeys = Extract<
	keyof HostOwnedPlanForgeAdmissionV1,
	string
>;
type PlanForgeCandidateSessionInputKeys = Extract<
	keyof HostOwnedPlanForgeCandidateSessionOpenInputV1,
	string
>;
type PlanForgeCandidateSessionKeys = Extract<
	keyof HostOwnedPlanForgeCandidateSessionV1,
	string
>;
type ReviewerSessionInputKeys = Extract<
	keyof HostOwnedReviewerSessionOpenInputV1,
	string
>;
type ReviewerSessionKeys = Extract<keyof HostOwnedReviewerSessionV1, string>;
type ReviewerRunResultKeys = Extract<
	keyof HostOwnedReviewerRunResultV1,
	string
>;

// Keep the host boundary deliberately narrow: source text, root, and an explicit
// approval reference are the only values a CLI may hand to a privileged host.
type _CandidateSessionInputIsNarrow = Assert<
	Equal<
		CandidateSessionInputKeys,
		"approval" | "kind" | "packetSource" | "projectRoot"
	>
>;
type _CandidateSessionOnlyRunsCandidateWork = Assert<
	Equal<CandidateSessionKeys, "kind" | "recoveryRef" | "run">
>;
type _RecoverySessionInputIsNarrow = Assert<
	Equal<
		RecoverySessionInputKeys,
		"approval" | "projectRoot" | "recoveryReference"
	>
>;
type _PlanForgeAdmissionInputIsNarrow = Assert<
	Equal<
		PlanForgeAdmissionInputKeys,
		"approval" | "kind" | "planSource" | "projectRoot"
	>
>;
type _PlanForgeAdmissionOnlyReturnsOpaqueReferencesAndDigests = Assert<
	Equal<
		PlanForgeAdmissionKeys,
		| "admissionDigest"
		| "admissionRef"
		| "kind"
		| "planSourceDigest"
		| "taskRefs"
	>
>;
type _PlanForgeCandidateSessionInputOnlyCarriesOpaqueHostReferences = Assert<
	Equal<
		PlanForgeCandidateSessionInputKeys,
		"admissionRef" | "kind" | "projectRoot" | "schemaVersion" | "taskRef"
	>
>;
type _PlanForgeCandidateSessionOnlyRunsBoundCandidateWork = Assert<
	Equal<
		PlanForgeCandidateSessionKeys,
		"kind" | "recoveryRef" | "run" | "schemaVersion"
	>
>;
type _ReviewerSessionInputOnlyCarriesOpaqueRecoveryIdentity = Assert<
	Equal<
		ReviewerSessionInputKeys,
		"kind" | "projectRoot" | "recoveryReference" | "schemaVersion"
	>
>;
type _ReviewerSessionOnlyRunsThePredeclaredReadOnlyActivity = Assert<
	Equal<ReviewerSessionKeys, "kind" | "recoveryRef" | "run">
>;
type _ReviewerResultHasNoPromotionOrActionAuthority = Assert<
	Equal<ReviewerRunResultKeys, "kind" | "recoveryRef" | "reviewReceipt">
>;
type _HostBrokerOnlyAdmitsPlanForgeOrOpensCandidateReviewerOrRecoverySessions =
	Assert<
		Equal<
			HostBrokerKeys,
			| "admitPlanForge"
			| "kind"
			| "openCandidateSession"
			| "openPlanForgeCandidateSession"
			| "openReviewerSession"
			| "openRecoverySession"
		>
	>;

void (0 as unknown as _CandidateSessionInputIsNarrow);
void (0 as unknown as _CandidateSessionOnlyRunsCandidateWork);
void (0 as unknown as _RecoverySessionInputIsNarrow);
void (0 as unknown as _PlanForgeAdmissionInputIsNarrow);
void (0 as unknown as _PlanForgeAdmissionOnlyReturnsOpaqueReferencesAndDigests);
void (0 as unknown as _PlanForgeCandidateSessionInputOnlyCarriesOpaqueHostReferences);
void (0 as unknown as _PlanForgeCandidateSessionOnlyRunsBoundCandidateWork);
void (0 as unknown as _ReviewerSessionInputOnlyCarriesOpaqueRecoveryIdentity);
void (0 as unknown as _ReviewerSessionOnlyRunsThePredeclaredReadOnlyActivity);
void (0 as unknown as _ReviewerResultHasNoPromotionOrActionAuthority);
void (0 as unknown as _HostBrokerOnlyAdmitsPlanForgeOrOpensCandidateReviewerOrRecoverySessions);

describe("host-owned governed authority broker resolver", () => {
	it("fails closed when this process has no privileged host integration", async () => {
		await expect(resolveHostOwnedGovernedBroker()).resolves.toBeUndefined();
	});

	it("does not mint or register a broker capability from the shipped module", async () => {
		const hostModule = await import("../src/governed-authority-broker-host.js");

		expect(Object.keys(hostModule).sort()).toEqual([
			"resolveHostOwnedGovernedBroker",
		]);
	});

	it("has no ambient fallback after repeated resolution attempts", async () => {
		const [first, second] = await Promise.all([
			resolveHostOwnedGovernedBroker(),
			resolveHostOwnedGovernedBroker(),
		]);

		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
	});
});
