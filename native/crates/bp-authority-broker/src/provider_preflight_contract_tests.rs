use crate::provider_preflight::{
    PrivateProviderTokenPreflightCapabilityV1, ProviderTokenPreflightAuthorityErrorV1,
    ProviderTokenPreflightAuthorityV1, ProviderTokenPreflightBackendV1,
    ProviderTokenPreflightGatewayCompletionV1, ProviderTokenPreflightGatewayV1,
    ProviderTokenPreflightGrantV1, ProviderTokenPreflightStatusV1,
};
use async_trait::async_trait;
use bp_ledger::payload::activity_claim::ActivityResultOutcomeV1;
use bp_ledger::payload::model_evidence::ModelProviderV1;
use bp_provider_sdk::{
    provider_response_contract_v1, ProviderExecutionRoleV1, ProviderTokenCountRequestV1,
};
use futures::executor::block_on;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct BackendState {
    grants: Arc<Mutex<Vec<ProviderTokenPreflightGrantV1>>>,
    recorded: Arc<Mutex<Vec<(String, String, ActivityResultOutcomeV1, Option<u32>)>>>,
    fail_record: bool,
}

impl ProviderTokenPreflightBackendV1 for BackendState {
    fn issue_and_claim(
        &mut self,
        _run_id: &str,
    ) -> Result<ProviderTokenPreflightGrantV1, ProviderTokenPreflightAuthorityErrorV1> {
        Ok(self.grants.lock().expect("grants").remove(0))
    }

    fn record(
        &mut self,
        run_id: &str,
        lease_id: String,
        completion: ProviderTokenPreflightGatewayCompletionV1,
    ) -> Result<ActivityResultOutcomeV1, ProviderTokenPreflightAuthorityErrorV1> {
        if self.fail_record {
            return Err(ProviderTokenPreflightAuthorityErrorV1::DurableAuthority);
        }
        self.recorded.lock().expect("recorded").push((
            run_id.into(),
            lease_id,
            completion.outcome,
            completion.input_tokens,
        ));
        Ok(completion.outcome)
    }
}

struct Gateway {
    calls: Arc<Mutex<usize>>,
    outcome: ActivityResultOutcomeV1,
}

#[async_trait]
impl ProviderTokenPreflightGatewayV1 for Gateway {
    async fn count(
        &mut self,
        capability: PrivateProviderTokenPreflightCapabilityV1,
    ) -> crate::provider_preflight::PairedProviderTokenPreflightResultV1 {
        *self.calls.lock().expect("calls") += 1;
        assert_eq!(capability.provider(), ModelProviderV1::Anthropic);
        assert_eq!(capability.request().request_id, "anthropic:preflight");
        let completion = match self.outcome {
            ActivityResultOutcomeV1::Succeeded => {
                ProviderTokenPreflightGatewayCompletionV1::succeeded(
                    321,
                    "sha256:evidence".into(),
                    "cas:evidence".into(),
                )
            }
            ActivityResultOutcomeV1::Unknown => ProviderTokenPreflightGatewayCompletionV1::unknown(
                "sha256:evidence".into(),
                "cas:evidence".into(),
            ),
            ActivityResultOutcomeV1::Failed => ProviderTokenPreflightGatewayCompletionV1 {
                outcome: ActivityResultOutcomeV1::Failed,
                input_tokens: None,
                evidence_digest: "sha256:evidence".into(),
                evidence_ref: "cas:evidence".into(),
            },
        };
        capability.complete(completion)
    }
}

fn request() -> ProviderTokenCountRequestV1 {
    let contract = provider_response_contract_v1(ProviderExecutionRoleV1::Implementer)
        .expect("response contract");
    ProviderTokenCountRequestV1 {
        schema_version: 1,
        request_id: "anthropic:preflight".into(),
        model: "claude-sonnet-4-6".into(),
        execution_role: ProviderExecutionRoleV1::Implementer,
        system_prompt: Some("system".into()),
        prompt: "prompt".into(),
        response_schema_name: contract.name.into(),
        response_contract_digest: contract.contract_digest,
        response_schema_digest: contract.schema_digest,
        response_schema: contract.schema,
        candidate_digest: None,
        worker_manifest_digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        max_total_tokens: 1_024,
        deadline_unix_ms: i64::MAX,
        tools: vec![],
    }
}

fn granted(run_id: &str) -> ProviderTokenPreflightGrantV1 {
    ProviderTokenPreflightGrantV1::Granted {
        run_id: run_id.into(),
        lease_id: "lease-1".into(),
        provider: ModelProviderV1::Anthropic,
        request: request(),
    }
}

#[test]
fn provider_count_runs_once_only_after_a_durable_grant_and_records_success() {
    let run_id = "run-1";
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(Mutex::new(0));
    let backend = BackendState {
        grants: Arc::new(Mutex::new(vec![granted(run_id)])),
        recorded: Arc::clone(&recorded),
        fail_record: false,
    };
    let gateway = Gateway {
        calls: Arc::clone(&calls),
        outcome: ActivityResultOutcomeV1::Succeeded,
    };
    let mut authority = ProviderTokenPreflightAuthorityV1::new(run_id.into(), backend, gateway);
    assert_eq!(
        block_on(authority.authorize_and_execute()).expect("preflight"),
        ProviderTokenPreflightStatusV1::Recorded
    );
    assert_eq!(*calls.lock().expect("calls"), 1);
    assert_eq!(
        recorded.lock().expect("recorded").as_slice(),
        &[(
            run_id.into(),
            "lease-1".into(),
            ActivityResultOutcomeV1::Succeeded,
            Some(321)
        )]
    );
}

#[test]
fn recorded_preflight_is_reused_without_a_second_remote_call() {
    let run_id = "run-2";
    let calls = Arc::new(Mutex::new(0));
    let backend = BackendState {
        grants: Arc::new(Mutex::new(vec![ProviderTokenPreflightGrantV1::Recorded {
            run_id: run_id.into(),
            outcome: ActivityResultOutcomeV1::Succeeded,
        }])),
        recorded: Arc::new(Mutex::new(Vec::new())),
        fail_record: false,
    };
    let gateway = Gateway {
        calls: Arc::clone(&calls),
        outcome: ActivityResultOutcomeV1::Succeeded,
    };
    let mut authority = ProviderTokenPreflightAuthorityV1::new(run_id.into(), backend, gateway);
    assert_eq!(
        block_on(authority.authorize_and_execute()).expect("preflight replay"),
        ProviderTokenPreflightStatusV1::Recorded
    );
    assert_eq!(*calls.lock().expect("calls"), 0);
}

#[test]
fn post_call_write_failure_and_unknown_effect_never_authorize_a_retry() {
    for (fail_record, outcome) in [
        (true, ActivityResultOutcomeV1::Succeeded),
        (false, ActivityResultOutcomeV1::Unknown),
    ] {
        let run_id = "run-3";
        let calls = Arc::new(Mutex::new(0));
        let backend = BackendState {
            grants: Arc::new(Mutex::new(vec![granted(run_id)])),
            recorded: Arc::new(Mutex::new(Vec::new())),
            fail_record,
        };
        let gateway = Gateway {
            calls: Arc::clone(&calls),
            outcome,
        };
        let mut authority = ProviderTokenPreflightAuthorityV1::new(run_id.into(), backend, gateway);
        assert_eq!(
            block_on(authority.authorize_and_execute()).expect("ambiguous preflight"),
            ProviderTokenPreflightStatusV1::ReconciliationRequired
        );
        assert_eq!(*calls.lock().expect("calls"), 1);
    }
}
