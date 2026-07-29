use std::process::Command;

#[test]
fn governed_session_binaries_reject_arguments_before_startup() {
    for (binary, expected_error) in [
        (
            env!("CARGO_BIN_EXE_buildplane-governed-session-host"),
            "invalid_arguments\n",
        ),
        (
            env!("CARGO_BIN_EXE_buildplane-governed-session-client"),
            "client_blocked\n",
        ),
    ] {
        let output = Command::new(binary)
            .arg("--socket=/tmp/attacker.sock")
            .env("BUILDPLANE_AUTHORITY_CONFIG", "/tmp/attacker.json")
            .env("BUILDPLANE_LEDGER_DB", "/tmp/attacker.db")
            .env("BUILDPLANE_AUTHORITY_SOCKET", "/tmp/attacker.sock")
            .env("ANTHROPIC_API_KEY", "ambient-secret-must-be-ignored")
            .output()
            .expect("run governed-session binary");
        assert!(!output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stderr), expected_error);
        assert!(output.stdout.is_empty());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn governed_session_host_never_falls_back_when_supervised_socket_is_missing() {
    let output = Command::new(env!("CARGO_BIN_EXE_buildplane-governed-session-host"))
        .env("BUILDPLANE_AUTHORITY_CONFIG", "/tmp/attacker.json")
        .env("BUILDPLANE_LEDGER_DB", "/tmp/attacker.db")
        .env("BUILDPLANE_AUTHORITY_SOCKET", "/tmp/attacker.sock")
        .env("ANTHROPIC_API_KEY", "ambient-secret-must-be-ignored")
        .output()
        .expect("run host without supervised listener");
    assert!(!output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stderr), "startup_failed\n");
    assert!(output.stdout.is_empty());
}
