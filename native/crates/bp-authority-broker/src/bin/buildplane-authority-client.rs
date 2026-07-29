use std::process::ExitCode;

fn main() -> ExitCode {
    if std::env::args_os().len() != 1 {
        eprintln!("invalid_arguments");
        return ExitCode::FAILURE;
    }
    bp_authority_broker::run_default_promotion_decision_client_v1()
}
