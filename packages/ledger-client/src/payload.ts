// Hand-written TypeScript for `Payload` — the Rust type uses serde's default
// external tag format ({ "VariantName": { ...fields } }) which typeshare cannot
// express. Phase B may introduce a wrapper type; for now this mirrors the wire
// format exactly.
//
// See: native/crates/bp-ledger/src/payload/mod.rs

import type {
	AcceptanceRecordedV1,
	ActivityCompletedV1,
	ActivityStartedV1,
	CapabilityDeniedV1,
	GitCheckpointV1,
	ModelRequestV1,
	ModelResponseV1,
	PlanAdmittedV1,
	PlanReceiptRecordedV1,
	RunAdmissionRecordedV1,
	RunCompletedV1,
	RunFailedV1,
	RunStartedV1,
	TapeCheckpointV1,
	ToolRequestStoredV1,
	ToolResultV1,
	UnitCancelledV1,
	UnitCompletedV1,
	UnitFailedV1,
	UnitStartedV1,
	WorkspaceReadV1,
	WorkspaceWriteV1,
} from "./generated/index.js";

/** Externally-tagged payload union — mirrors `bp_ledger::payload::Payload`. */
export type Payload =
	| { RunStartedV1: RunStartedV1 }
	| { RunCompletedV1: RunCompletedV1 }
	| { RunFailedV1: RunFailedV1 }
	| { RunAdmissionRecordedV1: RunAdmissionRecordedV1 }
	| { PlanAdmittedV1: PlanAdmittedV1 }
	| { PlanReceiptRecordedV1: PlanReceiptRecordedV1 }
	| { ActivityStartedV1: ActivityStartedV1 }
	| { ActivityCompletedV1: ActivityCompletedV1 }
	| { UnitStartedV1: UnitStartedV1 }
	| { UnitCompletedV1: UnitCompletedV1 }
	| { UnitFailedV1: UnitFailedV1 }
	| { UnitCancelledV1: UnitCancelledV1 }
	| { GitCheckpointV1: GitCheckpointV1 }
	| { ModelRequestV1: ModelRequestV1 }
	| { ModelResponseV1: ModelResponseV1 }
	| { ToolRequestStoredV1: ToolRequestStoredV1 }
	| { ToolResultV1: ToolResultV1 }
	| { WorkspaceReadV1: WorkspaceReadV1 }
	| { WorkspaceWriteV1: WorkspaceWriteV1 }
	| { TapeCheckpointV1: TapeCheckpointV1 }
	| { CapabilityDeniedV1: CapabilityDeniedV1 }
	| { AcceptanceRecordedV1: AcceptanceRecordedV1 };
