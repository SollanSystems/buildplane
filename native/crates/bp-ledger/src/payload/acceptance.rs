//! M4 acceptance contract payloads: `acceptance_recorded` finalization verdict.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// One independent check result recorded at finalization (all fields are strings on the wire).
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptanceCheckResultV1 {
    pub command: String,
    pub exit_code: String,
    pub status: String,
}

/// `acceptance_recorded` payload — kernel verdict before merge/quarantine.
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptanceRecordedV1 {
    pub plan_id: String,
    /// Chains to `plan_admitted` (string event id on the wire).
    pub admission_event_id: String,
    /// Canonical digest of the evaluated contract, `sha256:<hex>`.
    pub contract_digest: String,
    /// `passed` | `rejected`
    pub outcome: String,
    /// `passed` | `blocked`
    pub diff_scope_status: String,
    pub out_of_scope_files: Vec<String>,
    pub checks: Vec<AcceptanceCheckResultV1>,
    /// RFC3339
    pub evaluated_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> AcceptanceRecordedV1 {
        AcceptanceRecordedV1 {
            plan_id: "pf-plan-fixture".into(),
            admission_event_id: "01919000-0000-7000-8000-000000000005".into(),
            contract_digest: "sha256:aa".into(),
            outcome: "passed".into(),
            diff_scope_status: "passed".into(),
            out_of_scope_files: vec![],
            checks: vec![AcceptanceCheckResultV1 {
                command: "pnpm lint".into(),
                exit_code: "0".into(),
                status: "passed".into(),
            }],
            evaluated_at: "2026-06-19T12:00:00Z".into(),
        }
    }

    #[test]
    fn acceptance_recorded_v1_round_trips() {
        let p = fixture();
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<AcceptanceRecordedV1>(&s).unwrap());
    }
}
