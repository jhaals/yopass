use std::process::ExitCode;
use yopass_server::config::Config;
use yopass_server::server;

/// Registers the handlers at once, not when first polled: a signal arriving
/// while the server starts would otherwise kill it without a graceful shutdown.
fn shutdown_signal() -> impl std::future::Future<Output = ()> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("signal handler");
    let mut interrupt = signal(SignalKind::interrupt()).expect("signal handler");
    async move {
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let config = Config::parse_env_and_args();
    let filter = match yopass_server::util::log_filter(&config.log_level) {
        Some(filter) => filter,
        None => {
            eprintln!("invalid log level {:?}", config.log_level);
            return ExitCode::FAILURE;
        }
    };
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .init();
    match server::run(config, shutdown_signal()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error, "fatal");
            ExitCode::FAILURE
        }
    }
}
