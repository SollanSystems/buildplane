use std::process::Command;

#[test]
fn dedicated_binaries_reject_arguments_before_any_startup_work() {
    for binary in [
        env!("CARGO_BIN_EXE_buildplane-v5-dispatch-admission-host"),
        env!("CARGO_BIN_EXE_buildplane-v5-dispatch-admission-client"),
    ] {
        let output = Command::new(binary)
            .arg("--config=/tmp/attacker.json")
            .env("BUILDPLANE_AUTHORITY_CONFIG", "/tmp/attacker.json")
            .env("BUILDPLANE_LEDGER_DB", "/tmp/attacker.db")
            .env("BUILDPLANE_AUTHORITY_SOCKET", "/tmp/attacker.sock")
            .output()
            .expect("run dedicated binary");
        assert!(!output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stderr),
            "invalid_arguments\n"
        );
        assert!(output.stdout.is_empty());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn missing_fixed_deployment_blocks_even_when_override_environment_is_present() {
    let output = Command::new(env!("CARGO_BIN_EXE_buildplane-v5-dispatch-admission-host"))
        .env("BUILDPLANE_AUTHORITY_CONFIG", "/tmp/attacker.json")
        .env("BUILDPLANE_LEDGER_DB", "/tmp/attacker.db")
        .env("BUILDPLANE_AUTHORITY_SOCKET", "/tmp/attacker.sock")
        .output()
        .expect("run host without fixed deployment");
    assert!(!output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stderr), "startup_failed\n");
    assert!(output.stdout.is_empty());
}
