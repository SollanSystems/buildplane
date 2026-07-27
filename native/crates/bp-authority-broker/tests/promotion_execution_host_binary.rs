use std::process::Command;

#[test]
fn unexpected_argument_fails_before_runner_with_only_redacted_category() {
    let output = Command::new(env!("CARGO_BIN_EXE_buildplane-promotion-execution-host"))
        .arg("--repository")
        .arg("/tmp/attacker-selected")
        .output()
        .expect("run promotion-execution host");

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "arguments_rejected\n"
    );
}
