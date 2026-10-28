use crate::config::Config;
use crate::credentials;
use crate::headers::{
    agent_uuid, billing_headers, conv_group_uuid, inference_headers, models_headers, HeaderList,
    InferenceHeaderInput, PlatformInfo,
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
    /// 1-based user turn in this conversation. Empty: 1.
    #[serde(default)]
    pub turn_idx: String,
    /// Node's stable conversation-group id. Empty: derived from agent and session.
    #[serde(default)]
    pub conv_group_id: String,
}
/// `POST /internal/oauth`. Every auth.x.ai call for a slot leaves through this
/// kernel, so login, polling and refresh share its client and exit.
#[derive(Debug, Deserialize)]
pub struct OauthEnvelope {
    pub action: String,
    #[serde(default)]
    pub form: serde_json::Map<String, Value>,
    #[serde(default)]
    pub force: bool,
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
        .route("/internal/oauth", post(oauth_route))
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
    // `api` 2: /internal/oauth. Node replaces a running kernel that reports less.
    Json(json!({
        "ok": true,
        "hot_reload": true,
        "api": 2,
        "client_version": crate::headers::CLIENT_VERSION,
    }))
    .into_response()
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
async fn oauth_route(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(envelope): Json<OauthEnvelope>,
) -> Response {
    if !token_ok(&app, &headers) {
        return kernel_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "internal token rejected",
        );
    }
    match oauth_dispatch(&app, envelope).await {
        Ok(body) => Json(body).into_response(),
        Err(failure) => kernel_error(failure.status, &failure.code, &failure.message),
    }
}
async fn oauth_dispatch(app: &App, envelope: OauthEnvelope) -> Result<Value, KernelFailure> {
    let rt = app.runtime();
    if !rt.config.dial_allowed() {
        return Err(failure_from_code("proxy_required".to_string()));
    }
    let reply = |result: Result<oauth::OauthReply, String>| {
        result
            .map(|reply| json!({ "status": reply.status, "body": reply.body }))
            .map_err(failure_from_code)
    };
    match envelope.action.as_str() {
        "device_authorize" => reply(oauth::device_authorize(&rt.client, &rt.config).await),
        "token" => reply(oauth::token_grant(&rt.client, &rt.config, &envelope.form).await),
        "refresh" => refresh_slot(app, &rt, envelope.force).await,
        _ => Err(failure_from_code("bad_action".to_string())),
    }
}
/// The slot's own token, refreshed when stale or when `force` is set. The token
/// itself is not returned; Node reads the credential file for the new state.
async fn refresh_slot(app: &App, rt: &Runtime, force: bool) -> Result<Value, KernelFailure> {
    let before = credentials::read_account(&rt.config.credentials_path)
        .map_err(failure_from_code)?
        .access_token;
    let token = prepare_token(app, rt, force, None).await?;
    let after =
        credentials::read_account(&rt.config.credentials_path).map_err(failure_from_code)?;
    Ok(json!({
        "ok": true,
        "refreshed": token != before,
        "expires_at": after.expires_at_ms,
    }))
}
/// Stable error codes and statuses. 401 means the slot needs a new login; 503 is
/// worth a retry later; anything unexpected is reported as one internal code.
fn failure_from_code(code: String) -> KernelFailure {
    let (status, code, message) = match code.as_str() {
        "refresh_rejected" => (
            StatusCode::UNAUTHORIZED,
            "refresh_rejected",
            "xAI rejected the refresh token",
        ),
        "grok_no_credential" => (
            StatusCode::UNAUTHORIZED,
            "grok_no_credential",
            "Grok slot has no credential",
        ),
        "grok_token_expired" => (
            StatusCode::UNAUTHORIZED,
            "grok_token_expired",
            "Grok access token expired",
        ),
        "proxy_required" => (
            StatusCode::BAD_REQUEST,
            "proxy_required",
            "Grok slot has no exit",
        ),
        "bad_grant" => (
            StatusCode::BAD_REQUEST,
            "bad_grant",
            "grant type not allowed",
        ),
        "bad_action" => (
            StatusCode::BAD_REQUEST,
            "bad_action",
            "oauth action not allowed",
        ),
        "grok_oauth_not_configured" => (
            StatusCode::SERVICE_UNAVAILABLE,
            "grok_oauth_not_configured",
            "xAI OAuth endpoint is not allowed",
        ),
        "grok_oauth_discovery_failed" => (
            StatusCode::SERVICE_UNAVAILABLE,
            "grok_oauth_discovery_failed",
            "xAI OAuth discovery failed",
        ),
        "refresh_failed" | "refresh_empty" | "grok_refresh_busy" | "oauth_transport" => (
            StatusCode::SERVICE_UNAVAILABLE,
            code.as_str(),
            "xAI OAuth is not reachable right now",
        ),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "kernel_internal",
            "Grok kernel internal error",
        ),
    };
    KernelFailure::new(status, code.to_string(), message)
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
    let token = prepare_token(app, &rt, false, None).await?;
    let headers = headers_for(app, &rt, &envelope, &token);
    let url = upstream_url(&rt.config.base_url, &envelope.path, &envelope.query);
    let mut response = send(&rt, &method, &url, &headers, envelope.body.clone()).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        let _ = response.bytes().await;
        // Name the token upstream rejected: a newer one in the file is used as is.
        match prepare_token(app, &rt, true, Some(&token)).await {
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
    let stream = response.bytes_stream().map_err(std::io::Error::other);
    Ok((status, headers, Body::from_stream(stream)).into_response())
}
/// The slot's pinned client platform, or this host's when Node did not pin one.
fn platform_of(app: &App, rt: &Runtime) -> PlatformInfo {
    rt.config
        .platform
        .as_ref()
        .map(PlatformInfo::normalized)
        .unwrap_or_else(|| app.platform.clone())
}
fn headers_for(app: &App, rt: &Runtime, envelope: &Envelope, token: &str) -> HeaderList {
    let user_id = credentials::read_user_id(&rt.config.credentials_path);
    match envelope.purpose.as_str() {
        "models" => models_headers(token, &user_id, &platform_of(app, rt)),
        "billing" => billing_headers(token, &user_id, &platform_of(app, rt)),
        _ => {
            let request_id = if envelope.request_id.is_empty() {
                Uuid::new_v4().to_string()
            } else {
                envelope.request_id.clone()
            };
            let seed = if envelope.agent_id.is_empty() {
                credentials::load_agent_id(&rt.config.agent_id_path)
            } else {
                envelope.agent_id.clone()
            };
            let agent_id = agent_uuid(&seed);
            let conv_group_id = if envelope.conv_group_id.trim().is_empty() {
                conv_group_uuid(&agent_id, &envelope.session_id)
            } else {
                envelope.conv_group_id.trim().to_string()
            };
            let turn_idx = envelope.turn_idx.trim();
            inference_headers(
                &InferenceHeaderInput {
                    access_token: token.to_string(),
                    session_id: envelope.session_id.clone(),
                    request_id,
                    model_id: envelope.model_id.clone(),
                    agent_id,
                    turn_idx: Some(if turn_idx.is_empty() { "1" } else { turn_idx }.to_string()),
                    user_id,
                    conv_group_id: Some(conv_group_id),
                    ..InferenceHeaderInput::default()
                },
                &platform_of(app, rt),
            )
        }
    }
}
/// A bearer for one upstream call. `rejected` is the token upstream just answered
/// 401 for; when the file already holds a different fresh one, that one is used.
async fn prepare_token(
    app: &App,
    rt: &Runtime,
    force: bool,
    rejected: Option<&str>,
) -> Result<String, KernelFailure> {
    let account =
        credentials::read_account(&rt.config.credentials_path).map_err(failure_from_code)?;
    let stale =
        force || token_needs_refresh(&account, rt.config.oauth.refresh_skew_sec, oauth::now_ms());
    if !stale {
        return Ok(account.access_token);
    }
    if account.refresh_token.is_empty() {
        if !account.access_token.is_empty() && !force {
            return Ok(account.access_token);
        }
        return Err(failure_from_code("grok_token_expired".to_string()));
    }
    // Requests that queue here re-read the file inside refresh_account, so one
    // refresh serves all of them.
    let _guard = app.refresh.lock().await;
    let seen = rejected.unwrap_or(&account.access_token);
    match oauth::refresh_account(&rt.client, &rt.config, seen).await {
        Ok(refreshed) => Ok(refreshed.access_token),
        Err(_) if !force && !account.access_token.is_empty() => Ok(account.access_token),
        Err(code) => Err(failure_from_code(code)),
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
    #[tokio::test]
    async fn a_401_uses_a_newer_token_already_in_the_file() {
        let dir = std::env::temp_dir().join(format!("grok-kernel-401-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("grok-kernel.json");
        // token_url is not allowed: any refresh attempt would fail with grok_oauth_not_configured.
        let mut text: Value =
            serde_json::from_str(&config_text(&dir, "socks5h://10.0.0.1:1080")).unwrap();
        text["oauth"]["token_url"] = json!("https://invalid.example/token");
        std::fs::write(&path, text.to_string()).unwrap();
        let app = App::watching(&path, PlatformInfo::current()).unwrap();
        let rt = app.runtime();
        let fresh = oauth::now_ms() + 3_600_000;
        credentials::write_tokens(&rt.config.credentials_path, "t2", "rt", "", Some(fresh))
            .unwrap();
        let token = prepare_token(&app, &rt, true, Some("t1")).await.unwrap();
        assert_eq!(token, "t2");
        // The token upstream rejected is the one in the file: that one must be refreshed.
        let failure = prepare_token(&app, &rt, true, Some("t2"))
            .await
            .unwrap_err();
        assert_eq!(failure.code, "grok_oauth_not_configured");
        assert_eq!(failure.status, StatusCode::SERVICE_UNAVAILABLE);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn a_pinned_platform_is_the_user_agent() {
        let dir = std::env::temp_dir().join(format!("grok-kernel-ua-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("grok-kernel.json");
        let mut text: Value =
            serde_json::from_str(&config_text(&dir, "socks5h://10.0.0.1:1080")).unwrap();
        text["platform"] = json!({ "os": "darwin", "arch": "arm64" });
        std::fs::write(&path, text.to_string()).unwrap();
        let host = PlatformInfo {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
        };
        let app = App::watching(&path, host).unwrap();
        let envelope: Envelope =
            serde_json::from_str(r#"{"purpose":"inference","path":"/v1/responses"}"#).unwrap();
        let headers = headers_for(&app, &app.runtime(), &envelope, "t");
        assert_eq!(
            headers.get("user-agent"),
            Some("grok-shell/1.0.70 (macos; aarch64)")
        );
        // Without a pin the kernel reports its own host.
        text.as_object_mut().unwrap().remove("platform");
        std::fs::write(&path, text.to_string()).unwrap();
        let headers = headers_for(&app, &app.runtime(), &envelope, "t");
        assert_eq!(
            headers.get("user-agent"),
            Some("grok-shell/1.0.70 (linux; x86_64)")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn failure_codes_are_stable() {
        assert_eq!(
            failure_from_code("refresh_rejected".into()).status,
            StatusCode::UNAUTHORIZED
        );
        let transient = failure_from_code("refresh_failed".into());
        assert_eq!(transient.status, StatusCode::SERVICE_UNAVAILABLE);
        let odd = failure_from_code("Permission denied (os error 13)".into());
        assert_eq!(odd.code, "kernel_internal");
        assert_eq!(odd.status, StatusCode::SERVICE_UNAVAILABLE);
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
    #[test]
    fn envelope_body_keeps_reasoning_effort_and_continuation_fields() {
        let body = r#"{"model":"grok-4.7","input":[{"role":"user","content":"hi"}],"previous_response_id":"resp_1","reasoning":{"effort":"xhigh","summary":"concise"},"include":["reasoning.encrypted_content"],"store":false,"max_output_tokens":64000,"text":{"verbosity":"high"},"stream":true,"prompt_cache_key":"00000000-0000-5000-8000-000000000000"}"#;
        let envelope: Envelope = serde_json::from_str(&format!(
            r#"{{"purpose":"inference","path":"/v1/responses","model_id":"grok-4.7","body":{body}}}"#
        ))
        .unwrap();
        assert_eq!(envelope.model_id, "grok-4.7");
        assert_eq!(
            serde_json::to_string(&envelope.body.unwrap()).unwrap(),
            body
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
            platform: None,
            oauth: crate::config::OauthConfig {
                token_url: String::new(),
                client_id: "client".to_string(),
                discovery_url: "https://auth.x.ai/.well-known/openid-configuration".to_string(),
                scope: String::new(),
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
            turn_idx: String::new(),
            conv_group_id: String::new(),
        };
        let failure = dispatch(&app, envelope)
            .await
            .expect_err("direct dial must be refused");
        assert_eq!(failure.code, "proxy_required");
    }
}
