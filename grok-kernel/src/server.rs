use crate::config::Config;
use crate::credentials;
use crate::headers::{
    billing_headers, inference_headers, models_headers, HeaderList, InferenceHeaderInput,
    PlatformInfo,
};
use crate::oauth::{self, token_needs_refresh};
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;
const HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
];
/// One loaded config and the HTTP client built for its proxy. A request keeps the
/// runtime it started with, so a reload never changes the exit under a live stream.
pub struct Runtime {
    pub config: Config,
    pub client: reqwest::Client,
}
struct Current {
    runtime: Arc<Runtime>,
    text: String,
}
pub struct App {
    socket_path: PathBuf,
    config_path: Option<PathBuf>,
    current: Mutex<Current>,
    pub refresh: tokio::sync::Mutex<()>,
    pub platform: PlatformInfo,
}
impl App {
    /// A fixed config. The kernel binary uses `watching` instead.
    pub fn new(config: Config, client: reqwest::Client, platform: PlatformInfo) -> Self {
        Self {
            socket_path: config.socket_path.clone(),
            config_path: None,
            current: Mutex::new(Current {
                runtime: Arc::new(Runtime { config, client }),
                text: String::new(),
            }),
            refresh: tokio::sync::Mutex::new(()),
            platform,
        }
    }
    /// Load `path` and pick up later edits to it. Node rewrites the file when the
    /// slot's proxy, base URL or OAuth settings change; no restart is needed.
    pub fn watching(path: &Path, platform: PlatformInfo) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|err| format!("read config: {err}"))?;
        let config = Config::parse(&text)?;
        let client = build_client(&config)?;
        Ok(Self {
            socket_path: config.socket_path.clone(),
            config_path: Some(path.to_path_buf()),
            current: Mutex::new(Current {
                runtime: Arc::new(Runtime { config, client }),
                text,
            }),
            refresh: tokio::sync::Mutex::new(()),
            platform,
        })
    }
    /// The current runtime, reloaded first when the config file changed. The file is
    /// small and read on every call: an mtime check misses a same-size rewrite within
    /// one timestamp tick. A file that does not parse or names a bad proxy keeps the
    /// previous runtime.
    pub fn runtime(&self) -> Arc<Runtime> {
        let mut current = self
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(text) = self
            .config_path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
        {
            if text != current.text {
                let loaded = Config::parse(&text)
                    .and_then(|config| build_client(&config).map(|client| (config, client)));
                match loaded {
                    Ok((config, client)) => {
                        current.runtime = Arc::new(Runtime { config, client });
                    }
                    Err(err) => eprintln!("kin-grok-kernel: kept the previous config: {err}"),
                }
                // A bad file is reported once, not on every request.
                current.text = text;
            }
        }
        current.runtime.clone()
    }
}
#[derive(Debug)]
struct KernelFailure {
    status: StatusCode,
    code: String,
    message: String,
}
impl KernelFailure {
    fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}
#[derive(Debug, Deserialize)]
pub struct Envelope {
    #[serde(default)]
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub stream: bool,
    pub purpose: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub agent_id: String,
}
pub fn build_client(config: &Config) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .no_proxy()
        .pool_max_idle_per_host(8);
    let proxy_url = config.proxy_url.trim();
    if !proxy_url.is_empty() {
        let proxy = reqwest::Proxy::all(proxy_url).map_err(|err| format!("bad proxy: {err}"))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|err| err.to_string())
}
pub async fn serve(app: Arc<App>) -> Result<(), String> {
    let socket_path = app.socket_path.clone();
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let _ = std::fs::remove_file(&socket_path);
    let listener = tokio::net::UnixListener::bind(&socket_path).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
    }
    let router = Router::new()
        .route("/internal/health", get(health))
        .route("/internal/forward", post(forward))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(app);
    axum::serve(listener, router)
        .await
        .map_err(|err| err.to_string())
}
async fn health(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !token_ok(&app, &headers) {
        return kernel_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "internal token rejected",
        );
    }
    Json(json!({ "ok": true, "hot_reload": true })).into_response()
}
async fn forward(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(envelope): Json<Envelope>,
) -> Response {
    if !token_ok(&app, &headers) {
        return kernel_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "internal token rejected",
        );
    }
    match dispatch(&app, envelope).await {
        Ok(response) => response,
        Err(failure) => kernel_error(failure.status, &failure.code, &failure.message),
    }
}
async fn dispatch(app: &App, envelope: Envelope) -> Result<Response, KernelFailure> {
    let _ = envelope.stream;
    let rt = app.runtime();
    // No proxy and no local-route exception: refuse before building an upstream request.
    if !rt.config.dial_allowed() {
        return Err(KernelFailure::new(
            StatusCode::BAD_REQUEST,
            "proxy_required",
            "Grok slot has no exit",
        ));
    }
    let method = normalize_method(&envelope)?;
    validate_target(&envelope, &method)?;
    let token = prepare_token(app, &rt, false).await?;
    let headers = headers_for(app, &rt, &envelope, &token);
    let url = upstream_url(&rt.config.base_url, &envelope.path, &envelope.query);
    let mut response = send(&rt, &method, &url, &headers, envelope.body.clone()).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        let _ = response.bytes().await;
        match prepare_token(app, &rt, true).await {
            Ok(fresh) => {
                let headers = headers_for(app, &rt, &envelope, &fresh);
                response = send(&rt, &method, &url, &headers, envelope.body.clone()).await?;
            }
            Err(failure) => return Err(failure),
        }
    }
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = copy_headers(response.headers());
    let stream = response
        .bytes_stream()
        .map_err(|err| std::io::Error::other(err));
    Ok((status, headers, Body::from_stream(stream)).into_response())
}
fn headers_for(app: &App, rt: &Runtime, envelope: &Envelope, token: &str) -> HeaderList {
    match envelope.purpose.as_str() {
        "models" => models_headers(token, &app.platform),
        "billing" => billing_headers(token, &app.platform),
        _ => {
            let request_id = if envelope.request_id.is_empty() {
                Uuid::new_v4().to_string()
            } else {
                envelope.request_id.clone()
            };
            let agent_id = if envelope.agent_id.is_empty() {
                credentials::load_agent_id(&rt.config.agent_id_path)
            } else {
                envelope.agent_id.clone()
            };
            inference_headers(
                &InferenceHeaderInput {
                    access_token: token.to_string(),
                    session_id: envelope.session_id.clone(),
                    request_id,
                    model_id: envelope.model_id.clone(),
                    agent_id,
                    ..InferenceHeaderInput::default()
                },
                &app.platform,
            )
        }
    }
}
async fn prepare_token(app: &App, rt: &Runtime, force: bool) -> Result<String, KernelFailure> {
    let account = credentials::read_account(&rt.config.credentials_path).map_err(|code| {
        KernelFailure::new(
            StatusCode::UNAUTHORIZED,
            code,
            "Grok slot has no credential",
        )
    })?;
    let stale =
        force || token_needs_refresh(&account, rt.config.oauth.refresh_skew_sec, oauth::now_ms());
    if !stale {
        return Ok(account.access_token);
    }
    if account.refresh_token.is_empty() {
        if !account.access_token.is_empty() && !force {
            return Ok(account.access_token);
        }
        return Err(KernelFailure::new(
            StatusCode::UNAUTHORIZED,
            "grok_token_expired",
            "Grok access token expired",
        ));
    }
    let _guard = app.refresh.lock().await;
    match oauth::refresh_account(&rt.client, &rt.config).await {
        Ok(refreshed) => Ok(refreshed.access_token),
        Err(_) if !force && !account.access_token.is_empty() => Ok(account.access_token),
        Err(code) => Err(KernelFailure::new(
            StatusCode::UNAUTHORIZED,
            code,
            "Grok token refresh failed",
        )),
    }
}
async fn send(
    rt: &Runtime,
    method: &str,
    url: &str,
    headers: &HeaderList,
    body: Option<Value>,
) -> Result<reqwest::Response, KernelFailure> {
    let mut builder = match method {
        "GET" => rt.client.get(url),
        "POST" => rt.client.post(url),
        _ => {
            return Err(KernelFailure::new(
                StatusCode::BAD_REQUEST,
                "bad_method",
                "method not allowed",
            ));
        }
    };
    for (name, value) in &headers.pairs {
        builder = builder.header(name, value);
    }
    if method == "POST" {
        builder = builder.json(&body.unwrap_or_else(|| json!({})));
    }
    builder.send().await.map_err(|err| {
        KernelFailure::new(
            StatusCode::BAD_GATEWAY,
            "upstream_transport",
            err.to_string(),
        )
    })
}
fn normalize_method(envelope: &Envelope) -> Result<String, KernelFailure> {
    let expected = match envelope.purpose.as_str() {
        "inference" => "POST",
        "models" | "billing" => "GET",
        _ => {
            return Err(KernelFailure::new(
                StatusCode::BAD_REQUEST,
                "bad_purpose",
                "purpose not allowed",
            ));
        }
    };
    let given = envelope.method.trim().to_ascii_uppercase();
    if !given.is_empty() && given != expected {
        return Err(KernelFailure::new(
            StatusCode::BAD_REQUEST,
            "bad_method",
            "method does not match purpose",
        ));
    }
    Ok(expected.to_string())
}
fn validate_target(envelope: &Envelope, method: &str) -> Result<(), KernelFailure> {
    let path = envelope.path.as_str();
    let query = envelope.query.trim();
    let ok = match (envelope.purpose.as_str(), method) {
        ("inference", "POST") => {
            query.is_empty()
                && matches!(
                    path,
                    "/v1/responses" | "/v1/chat/completions" | "/v1/messages"
                )
        }
        ("models", "GET") => query.is_empty() && path == "/v1/models",
        ("billing", "GET") => {
            path == "/v1/billing" && (query.is_empty() || query == "format=credits")
        }
        _ => false,
    };
    if ok {
        return Ok(());
    }
    Err(KernelFailure::new(
        StatusCode::BAD_REQUEST,
        "bad_path",
        "upstream path is not allowed",
    ))
}
fn upstream_url(base: &str, path: &str, query: &str) -> String {
    let root = base.trim_end_matches('/');
    if query.trim().is_empty() {
        format!("{root}{path}")
    } else {
        format!("{root}{path}?{}", query.trim())
    }
}
fn copy_headers(source: &reqwest::header::HeaderMap) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in source.iter() {
        if HOP_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let Ok(text) = value.to_str() else { continue };
        let (Ok(name), Ok(value)) = (
            HeaderName::try_from(name.as_str()),
            HeaderValue::from_str(text),
        ) else {
            continue;
        };
        out.append(name, value);
    }
    out
}
fn token_ok(app: &App, headers: &HeaderMap) -> bool {
    let rt = app.runtime();
    let presented = headers
        .get("x-kin-internal-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    !rt.config.internal_token.is_empty()
        && same_secret(presented, rt.config.internal_token.as_str())
}

/// Hash both sides first so a different length does not return early.
fn same_secret(left: &str, right: &str) -> bool {
    let left_hash = Sha256::digest(left.as_bytes());
    let right_hash = Sha256::digest(right.as_bytes());
    let mut diff = 0u8;
    for (left_byte, right_byte) in left_hash.iter().zip(right_hash.iter()) {
        diff |= left_byte ^ right_byte;
    }
    diff == 0
}
fn kernel_error(status: StatusCode, code: &str, message: &str) -> Response {
    let mut response =
        Json(json!({ "error": { "code": code, "message": message } })).into_response();
    *response.status_mut() = status;
    response.headers_mut().insert(
        HeaderName::from_static("x-kin-kernel-error"),
        HeaderValue::from_static("1"),
    );
    response
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn envelope_token_is_ignored() {
        let envelope: Envelope = serde_json::from_str(
            r#"{"purpose":"inference","path":"/v1/responses","access_token":"from-node","session_id":"sess","model_id":"grok-4","request_id":"req","agent_id":"agent"}"#,
        )
        .unwrap();
        assert!(!format!("{envelope:?}").contains("from-node"));
        let headers = inference_headers(
            &InferenceHeaderInput {
                access_token: "from-file".to_string(),
                session_id: envelope.session_id,
                request_id: envelope.request_id,
                model_id: envelope.model_id,
                agent_id: envelope.agent_id,
                ..InferenceHeaderInput::default()
            },
            &PlatformInfo {
                os: "linux".to_string(),
                arch: "x86_64".to_string(),
            },
        );
        assert_eq!(headers.get("authorization"), Some("Bearer from-file"));
        assert!(!headers
            .pairs
            .iter()
            .any(|(_, value)| value.contains("from-node")));
    }
    fn config_text(dir: &Path, proxy_url: &str) -> String {
        json!({
            "socket_path": dir.join("grok.sock"),
            "credentials_path": dir.join("cred.json"),
            "agent_id_path": dir.join("agent"),
            "refresh_lock_path": dir.join("lock"),
            "internal_token": "secret",
            "proxy_url": proxy_url,
            "proxy_required": true,
            "base_url": "https://cli-chat-proxy.grok.com",
            "oauth": { "client_id": "client" }
        })
        .to_string()
    }
    #[test]
    fn config_edits_reach_the_next_request() {
        let dir = std::env::temp_dir().join(format!("grok-kernel-reload-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("grok-kernel.json");
        std::fs::write(&path, config_text(&dir, "socks5h://10.0.0.1:1080")).unwrap();
        let app = App::watching(&path, PlatformInfo::current()).unwrap();
        let first = app.runtime();
        assert_eq!(first.config.proxy_url, "socks5h://10.0.0.1:1080");
        // Same bytes written again: keep the client and its pooled connections.
        std::fs::write(&path, config_text(&dir, "socks5h://10.0.0.1:1080")).unwrap();
        assert!(Arc::ptr_eq(&first, &app.runtime()));
        std::fs::write(&path, config_text(&dir, "socks5h://10.0.0.2:1080")).unwrap();
        let second = app.runtime();
        assert_eq!(second.config.proxy_url, "socks5h://10.0.0.2:1080");
        // A request that started earlier still holds its own runtime.
        assert_eq!(first.config.proxy_url, "socks5h://10.0.0.1:1080");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(app.runtime().config.proxy_url, "socks5h://10.0.0.2:1080");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn envelope_body_keeps_client_key_order() {
        let envelope: Envelope = serde_json::from_str(
            r#"{"purpose":"inference","path":"/v1/responses","body":{"model":"grok-4","stream":true,"input":[{"role":"user","content":"hi"}],"instructions":"x","tools":[]}}"#,
        )
        .unwrap();
        // send() serializes the body with reqwest's .json(), which is serde_json::to_vec.
        let sent = serde_json::to_string(&envelope.body.unwrap()).unwrap();
        assert_eq!(
            sent,
            r#"{"model":"grok-4","stream":true,"input":[{"role":"user","content":"hi"}],"instructions":"x","tools":[]}"#
        );
    }
    #[tokio::test]
    async fn missing_proxy_fails_before_dial() {
        let config = Config {
            socket_path: std::path::PathBuf::from("/tmp/grok-kernel-test.sock"),
            credentials_path: std::path::PathBuf::from("/tmp/grok-credentials.json"),
            agent_id_path: std::path::PathBuf::from("/tmp/grok-agent"),
            refresh_lock_path: std::path::PathBuf::from("/tmp/grok-refresh.lock"),
            internal_token: "secret".to_string(),
            proxy_url: String::new(),
            proxy_required: true,
            base_url: "https://cli-chat-proxy.grok.com".to_string(),
            client_version: "1.0.62".to_string(),
            oauth: crate::config::OauthConfig {
                token_url: String::new(),
                client_id: "client".to_string(),
                discovery_url: "https://auth.x.ai/.well-known/openid-configuration".to_string(),
                refresh_skew_sec: 300,
            },
        };
        let client = build_client(&config).unwrap();
        let app = App::new(config, client, PlatformInfo::current());
        let envelope = Envelope {
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            query: String::new(),
            body: Some(json!({"model":"grok-4"})),
            stream: true,
            purpose: "inference".to_string(),
            session_id: "sess".to_string(),
            model_id: "grok-4".to_string(),
            request_id: "req".to_string(),
            agent_id: "agent".to_string(),
        };
        let failure = dispatch(&app, envelope)
            .await
            .expect_err("direct dial must be refused");
        assert_eq!(failure.code, "proxy_required");
    }
}
