use kin_grok_kernel::headers::PlatformInfo;
use kin_grok_kernel::server::{serve, App};
use std::path::Path;
use std::sync::Arc;
fn strip_proxy_env() {
    for key in [
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "no_proxy",
        "NO_PROXY",
    ] {
        std::env::remove_var(key);
    }
}
#[tokio::main]
async fn main() {
    strip_proxy_env();
    let config_path = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: kin-grok-kernel <config.json>");
        std::process::exit(2);
    });
    let app =
        App::watching(Path::new(&config_path), PlatformInfo::current()).unwrap_or_else(|err| {
            eprintln!("kin-grok-kernel: {err}");
            std::process::exit(1);
        });
    let socket_path = app.runtime().await.config.socket_path.clone();
    let app = Arc::new(app);
    tokio::select! {
        result = serve(app) => {
            if let Err(err) = result {
                eprintln!("kin-grok-kernel: {err}");
                let _ = std::fs::remove_file(&socket_path);
                std::process::exit(1);
            }
        }
        _ = shutdown() => {}
    }
    let _ = std::fs::remove_file(&socket_path);
}
async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(term) = terminate.as_mut() {
                    term.recv().await;
                }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
