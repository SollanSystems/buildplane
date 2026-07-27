fn main() -> std::process::ExitCode {
    if std::env::args_os().len() != 1 {
        eprintln!("arguments_rejected");
        return std::process::ExitCode::FAILURE;
    }
    bp_authority_broker::run_default_promotion_execution_host_v1()
}
