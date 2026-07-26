use std::io::Write;
use std::process::{Command, Stdio};

fn client() -> Command {
    Command::new(env!("CARGO_BIN_EXE_buildplane-governed-session-client"))
}

#[test]
fn uninstalled_client_fails_closed_with_one_redacted_error() {
    let mut child = client()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn governed session client");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            br#"{"schema_version":1,"protocol":"buildplane-governed-session","request_id":"01919000-0000-7000-8000-000000000081","operation":"open_reviewer_session","project_root":"/srv/buildplane/repositories/example","recovery_ref":"host-recovery/session-0001"}"#,
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"client_blocked\n");
}

#[test]
fn client_rejects_all_arguments_before_processing_stdin() {
    let output = client()
        .arg("--socket")
        .arg("/tmp/attacker.sock")
        .output()
        .expect("spawn governed session client");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"client_blocked\n");
}
