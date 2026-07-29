//! Fail-closed startup composition for the protected governed-session host.
//!
//! This proof retains both the broker's kernel-observed model-action identity
//! and the fresh rootless OCI attestation. It grants no listener, action,
//! provider, credential, mount, or promotion authority by itself.

use crate::confinement::{
    BrokerAuthorityRoleV1, BrokerHostConfinementAttestationV1, BrokerHostConfinementErrorV1,
    BrokerHostConfinementPolicyV1,
};
use crate::provider_preflight::{
    ProviderTokenPreflightAuthorityErrorV1, ProviderTokenPreflightAuthorityV1,
    ProviderTokenPreflightBackendV1, ProviderTokenPreflightGatewayV1,
    ProviderTokenPreflightStatusV1,
};
use crate::rootless_oci::RootlessOciAttestationV1;
#[cfg(target_os = "linux")]
use std::os::unix::net::UnixStream;
use thiserror::Error;

#[derive(Debug)]
pub(crate) struct GovernedSessionHostStartupV1 {
    confinement_policy: BrokerHostConfinementPolicyV1,
    confinement_attestation: BrokerHostConfinementAttestationV1,
    oci_attestation: RootlessOciAttestationV1,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub(crate) enum GovernedSessionHostStartupErrorV1 {
    #[error("governed session host requires the model-action authority role")]
    WrongAuthorityRole,
    #[error("governed session broker confinement attestation is invalid")]
    InvalidConfinement,
    #[error("governed session rootless OCI attestation is invalid")]
    InvalidOciAttestation,
}

impl GovernedSessionHostStartupV1 {
    pub(crate) fn new(
        confinement_policy: BrokerHostConfinementPolicyV1,
        confinement_attestation: BrokerHostConfinementAttestationV1,
        oci_attestation: RootlessOciAttestationV1,
    ) -> Result<Self, GovernedSessionHostStartupErrorV1> {
        confinement_policy
            .verify_startup_attestation_for_role(
                BrokerAuthorityRoleV1::ModelAction,
                &confinement_attestation,
            )
            .map_err(map_confinement_error)?;
        if oci_attestation.runtime != "rootless-oci"
            || !oci_attestation.rootless
            || !oci_attestation.read_only_base
            || !oci_attestation.writable_overlay
            || oci_attestation.network != "none"
            || oci_attestation.host_fallback
            || oci_attestation.profile_digest.is_empty()
            || oci_attestation.image.is_empty()
        {
            return Err(GovernedSessionHostStartupErrorV1::InvalidOciAttestation);
        }
        Ok(Self {
            confinement_policy,
            confinement_attestation,
            oci_attestation,
        })
    }

    pub(crate) fn sandbox_profile_digest(&self) -> &str {
        &self.oci_attestation.profile_digest
    }

    pub(crate) fn oci_attestation(&self) -> &RootlessOciAttestationV1 {
        &self.oci_attestation
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn verified_connected_worker_uid(
        &self,
        stream: &UnixStream,
    ) -> Result<u32, GovernedSessionHostStartupErrorV1> {
        self.confinement_policy
            .verified_linux_connected_worker_uid_for_role(
                BrokerAuthorityRoleV1::ModelAction,
                &self.confinement_attestation,
                stream,
            )
            .map_err(map_confinement_error)
    }
}

/// Runtime composition proving that the provider-preflight authority was
/// created only after the protected host confinement and rootless OCI startup
/// checks succeeded. It exposes no underlying signer, credential, CAS, lease,
/// transport, or sandbox handle.
pub(crate) struct GovernedSessionProviderLaneV1<B, G> {
    sandbox_profile_digest: String,
    preflight: ProviderTokenPreflightAuthorityV1<B, G>,
}

impl<B, G> GovernedSessionProviderLaneV1<B, G>
where
    B: ProviderTokenPreflightBackendV1,
    G: ProviderTokenPreflightGatewayV1,
{
    pub(crate) fn from_prevalidated_startup(
        startup: &GovernedSessionHostStartupV1,
        preflight: ProviderTokenPreflightAuthorityV1<B, G>,
    ) -> Self {
        Self {
            sandbox_profile_digest: startup.sandbox_profile_digest().into(),
            preflight,
        }
    }

    pub(crate) fn sandbox_profile_digest(&self) -> &str {
        &self.sandbox_profile_digest
    }

    pub(crate) async fn prepare_provider(
        &mut self,
    ) -> Result<ProviderTokenPreflightStatusV1, ProviderTokenPreflightAuthorityErrorV1> {
        self.preflight.authorize_and_execute().await
    }
}

fn map_confinement_error(error: BrokerHostConfinementErrorV1) -> GovernedSessionHostStartupErrorV1 {
    match error {
        BrokerHostConfinementErrorV1::RolePolicyMismatch { .. } => {
            GovernedSessionHostStartupErrorV1::WrongAuthorityRole
        }
        _ => GovernedSessionHostStartupErrorV1::InvalidConfinement,
    }
}
