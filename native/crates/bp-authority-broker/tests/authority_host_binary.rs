use std::process::Command;

#[test]
fn unexpected_argument_fails_before_runner_with_only_redacted_category() {
    let output = Command::new(env!("CARGO_BIN_EXE_buildplane-authority-host"))
        .arg("unexpected")
        .output()
        .expect("run authority host binary");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(output.stderr, b"invalid_arguments\n");
}
