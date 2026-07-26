fn main() -> std::process::ExitCode {
    if std::env::args_os().len() != 1 {
        eprintln!("invalid_arguments");
        return std::process::ExitCode::FAILURE;
    }
    bp_authority_broker::run_default_governed_session_host_v1()
}
