//! M3 capability broker payloads: `capability_denied` quarantine evidence.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// `capability_denied` payload — broker rejected a tool invocation (fail closed).
#[typeshare]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityDeniedV1 {
    /// Run id for export/quarantine correlation (duplicates envelope for verifiers).
    pub run_id: String,
    /// Canonical digest of the admitted capability bundle, `sha256:<hex>`.
    pub bundle_digest: String,
    /// Tool surface: `write_file` or `run_command`.
    pub tool: String,
    /// Human-readable broker denial reason.
    pub reason: String,
    /// Path or command target that was denied.
    pub target: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_denied_v1_round_trips() {
        let p = CapabilityDeniedV1 {
            run_id: "run-fixture".into(),
            bundle_digest: "sha256:aa".into(),
            tool: "write_file".into(),
            reason: "no fsWrite globs".into(),
            target: "docs/readme.md".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert_eq!(p, serde_json::from_str::<CapabilityDeniedV1>(&s).unwrap());
    }
}
