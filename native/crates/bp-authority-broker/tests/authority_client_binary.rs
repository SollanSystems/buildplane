use std::process::{Command, Stdio};

#[test]
fn unexpected_argument_fails_before_runner_with_only_redacted_category() {
    let output = Command::new(env!("CARGO_BIN_EXE_buildplane-authority-client"))
        .arg("unexpected")
        .output()
        .expect("run authority client binary");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"invalid_arguments\n");
}

#[test]
fn an_uninstalled_development_binary_fails_closed_without_a_result() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_buildplane-authority-client"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run authority client binary");
    {
        use std::io::Write;
        child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(
                br#"{"schema_version":1,"promotion_approval_request_event_id":"123e4567-e89b-12d3-a456-426614174001","decision":"promote"}"#,
            )
            .expect("request bytes");
    }
    let output = child.wait_with_output().expect("wait for authority client");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"client_blocked\n");
}
