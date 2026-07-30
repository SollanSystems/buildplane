"""Single source of truth for every pinned value the harness must match.

Nothing here overrides Buildplane. The fixed paths, the fd number, the file
names, and the mode/owner constants are compiled into the Rust binaries; they
are reproduced here only so the out-of-band validators check the SAME values the
host and client enforce. If a value here disagrees with the crate, the harness
must be corrected -- never the crate.
"""

BROKER_UID = 4201
BROKER_GID = 4201
CLIENT_UID = 4202
CLIENT_GID = 4202
# A real non-root UID that is a member of the socket group but is deliberately
# NOT in promotion_decision_client_uids. Used by negative control N5 to observe
# the host's peer-UID gate rejecting a non-root peer.
OUTSIDER_UID = 4203
OUTSIDER_GID = 4203
SOCKET_GID = 4210

RUN_ID = "018f2e40-0000-7000-8000-000000000001"  # canonical UUIDv7
REALM_DIGEST = "sha256:" + ("a" * 64)
APPROVAL_EVENT_ID = "123e4567-e89b-12d3-a456-426614174001"  # canonical, absent

AUTHORITY_ROOT = "/var/lib/buildplane/authority"
LEDGER_DIR = AUTHORITY_ROOT + "/ledger"
LEDGER_DB = LEDGER_DIR + "/events.db"
LEDGER_SIDECARS = ("events.db-wal", "events.db-shm", "events.db-journal")
KEYS_DIR = AUTHORITY_ROOT + "/keys"
KERNEL_KEY = KEYS_DIR + "/kernel/kernel-main.ed25519"
OPERATOR_KEY = KEYS_DIR + "/operator/operator-main.ed25519"

CONFIG_DIR = "/etc/buildplane/authority-host"
HOST_CONFIG = CONFIG_DIR + "/promotion-decision-v1.json"
CLIENT_CONFIG = CONFIG_DIR + "/promotion-decision-client-v1.json"

RUN_DIR = "/run/buildplane/authority-host"
SOCKET_PATH = RUN_DIR + "/promotion-decision-v1.sock"
LISTENER_FD = 3

INSTALL_DIR = "/usr/libexec/buildplane"
CLIENT_BIN = INSTALL_DIR + "/buildplane-authority-client"
HOST_BIN = INSTALL_DIR + "/buildplane-authority-host"
NATIVE_BIN = INSTALL_DIR + "/buildplane-native"
COPIED_CLIENT_BIN = "/tmp/copied-client"

REPO_DEBUG = "/repo/native/target/debug"
OUT_DIR = "/out"
SEED_WORKSPACE = "/seed"

MAX_HOST_CONFIG_BYTES = 256 * 1024
MAX_CLIENT_CONFIG_BYTES = 4 * 1024

PKCS8_ED25519_PREFIX = bytes.fromhex("302e020100300506032b657004220420")
SPKI_ED25519_PREFIX = bytes.fromhex("302a300506032b6570032100")
SIGNATURE_DOMAIN = b"buildplane.protected-promotion-decision.response.v2\x00"
SQLITE_MAGIC = b"SQLite format 3\x00"

# promotion_decision_client.rs:43-44 -- the literal the real client prints, plus
# the trailing newline it writes separately at :1055-1058.
EXPECTED_CLIENT_STDOUT = (
    b'{"schema_version":2,"status":"reconciliation_required",'
    b'"promotion_decision_event_id":null}\n'
)

# The proof request, byte-exact, fed to the client on stdin with no newline.
PROOF_REQUEST = (
    b'{"schema_version":1,"promotion_approval_request_event_id":'
    b'"' + APPROVAL_EVENT_ID.encode() + b'","decision":"promote"}'
)

SEALED_BLOCKER = (
    "BrokerPromotionDecisionAuthority::record_from_approval_decision "
    "(lib.rs:402-499) returns ReconciliationRequired before any ledger write "
    "unless the tape already carries a cross-consistent workflow in phase "
    "PromotionApprovalPending (dispatch + CandidateCreated + "
    "CandidateCompletion + Acceptance(Passed) + >=1 Approve review + "
    "PromotionApprovalRequested). The modules that would produce that chain "
    "through production hosts are #[allow(dead_code)] (candidate_repository, "
    "candidate_workspace, governed_reviewer_authority) and the OCI path "
    "hard-pins /usr/bin/podman (rootless_oci.rs:38). Seeding the chain by hand "
    "would be manufacturing authority-bearing evidence, which is exactly what "
    "this harness exists to disprove -- so it is refused, not worked around."
)

TAPE_NA_REASON = (
    "scripts/verify-signed-tape.mjs is N/A for this proof: the reconciliation "
    "path appends zero tape events, so there is nothing to verify. The "
    "tape-side evidence is inverted instead -- events count must be 0 before "
    "AND after the round trip. The export command is run and its verbatim exit "
    "code recorded, but it is NOT a gate and its failure is expected (it wants "
    "<workspace>/.buildplane/ledger, a different layout from authority_root)."
)
