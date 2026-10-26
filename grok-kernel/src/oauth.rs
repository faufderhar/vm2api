use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::Config;
use crate::credentials::{self, Account};
use crate::headers::{user_agent_string_for, PlatformInfo, CLIENT_VERSION, PRODUCT};

/// One OAuth call bounded on its own; the client only has a connect timeout.
const OAUTH_TIMEOUT: Duration = Duration::from_secs(30);

pub const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// Grants Node may ask for. Refreshing the slot's own token goes through `refresh_account`.
const TOKEN_GRANTS: &[&str] = &[DEVICE_CODE_GRANT, "authorization_code", "refresh_token"];
/// Form fields in the order they are sent. client_id is always last and always ours.
const TOKEN_FIELDS: &[&str] = &[
    "grant_type",
    "device_code",
    "code",
    "redirect_uri",
    "code_verifier",
    "refresh_token",
];

/// Raw status and JSON body of an auth.x.ai call, for Node to interpret.
#[derive(Clone, Debug)]
pub struct OauthReply {
    pub status: u16,
    pub body: Value,
}

#[derive(Clone, Debug)]
pub struct RefreshedToken {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub expires_at_ms: Option<i64>,
}

pub fn token_needs_refresh(account: &Account, skew_sec: u64, now_ms: i64) -> bool {
    if account.access_token.is_empty() {
        return true;
    }
    let Some(expires) = account.expires_at_ms else {
        return false;
    };
    expires.saturating_sub(now_ms) <= (skew_sec as i64).saturating_mul(1000)
}

/// Refresh the slot token. `seen` is the access token the caller read before it
/// waited for the lock (or the one upstream just rejected). When the file already
/// holds a different, fresh token, another request or Node refreshed it meanwhile:
/// use that one and leave the refresh token alone.
pub async fn refresh_account(
    client: &reqwest::Client,
    config: &Config,
    seen: &str,
) -> Result<RefreshedToken, String> {
    let _lock = credentials::acquire_refresh_lock(&config.refresh_lock_path).await?;
    let account = credentials::read_account(&config.credentials_path)?;
    if !account.access_token.is_empty()
        && account.access_token != seen
        && !token_needs_refresh(&account, config.oauth.refresh_skew_sec, now_ms())
    {
        return Ok(RefreshedToken {
            access_token: account.access_token,
            refresh_token: account.refresh_token,
            id_token: account.id_token,
            expires_at_ms: account.expires_at_ms,
        });
    }
    if account.refresh_token.is_empty() {
        return Err("grok_token_expired".to_string());
    }
    let token_url = resolve_token_url(client, config).await?;
    let principal = account.user_id.clone().unwrap_or_default();
    let fields = refresh_form(&account.refresh_token, &config.oauth.client_id, &principal);
    let mut reply = post_form(client, config, &token_url, &fields)
        .await
        // A stable code: transport detail must not reach logs or API clients.
        .map_err(|_| "refresh_failed".to_string())?;
    // A 400 that is not invalid_grant may be the principal fields themselves (an
    // account id that is not the principal xAI expects): try once without them, as
    // before. A rejected refresh token is never retried.
    if !principal.is_empty()
        && reply.status == 400
        && reply.body.get("error").and_then(|value| value.as_str()) != Some("invalid_grant")
    {
        let plain = refresh_form(&account.refresh_token, &config.oauth.client_id, "");
        reply = post_form(client, config, &token_url, &plain)
            .await
            .map_err(|_| "refresh_failed".to_string())?;
    }
    let payload = reply.body;
    let oauth_error = payload
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if reply.status == 401 || reply.status == 403 || oauth_error == "invalid_grant" {
        return Err("refresh_rejected".to_string());
    }
    if !(200..300).contains(&reply.status) {
        return Err("refresh_failed".to_string());
    }
    let access_token = text(&payload, "access_token");
    if access_token.is_empty() {
        return Err("refresh_empty".to_string());
    }
    let refresh_token = {
        let next = text(&payload, "refresh_token");
        if next.is_empty() {
            account.refresh_token
        } else {
            next
        }
    };
    let id_token = {
        let next = text(&payload, "id_token");
        if next.is_empty() {
            account.id_token
        } else {
            next
        }
    };
    let expires_at_ms = expires_at_from(&payload, now_ms());
    credentials::write_tokens(
        &config.credentials_path,
        &access_token,
        &refresh_token,
        &id_token,
        expires_at_ms,
    )?;
    Ok(RefreshedToken {
        access_token,
        refresh_token,
        id_token,
        expires_at_ms,
    })
}

/// The refresh form the official client posts: no scope, and the principal when the
/// account id is known.
pub fn refresh_form<'a>(
    refresh_token: &'a str,
    client_id: &'a str,
    principal_id: &'a str,
) -> Vec<(&'static str, &'a str)> {
    let mut fields = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    if !principal_id.is_empty() {
        fields.push(("principal_type", "User"));
        fields.push(("principal_id", principal_id));
    }
    fields
}

/// Device code start: POST client_id and scope to the discovered device endpoint.
pub async fn device_authorize(
    client: &reqwest::Client,
    config: &Config,
) -> Result<OauthReply, String> {
    let url = resolve_device_url(client, config).await?;
    let mut form = vec![("client_id", config.oauth.client_id.as_str())];
    if !config.oauth.scope.is_empty() {
        form.push(("scope", config.oauth.scope.as_str()));
    }
    post_form(client, config, &url, &form).await
}

/// A token grant Node started (device code poll, PKCE exchange, refresh-token import).
/// Only known grants and fields are forwarded; client_id comes from the kernel config.
pub async fn token_grant(
    client: &reqwest::Client,
    config: &Config,
    fields: &Map<String, Value>,
) -> Result<OauthReply, String> {
    let form = token_form(config, fields)?;
    let url = resolve_token_url(client, config).await?;
    post_form(client, config, &url, &form).await
}

/// The form for `token_grant`: known fields in a fixed order, then our client_id.
fn token_form(
    config: &Config,
    fields: &Map<String, Value>,
) -> Result<Vec<(&'static str, String)>, String> {
    let grant = fields
        .get("grant_type")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !TOKEN_GRANTS.contains(&grant) {
        return Err("bad_grant".to_string());
    }
    let mut form: Vec<(&'static str, String)> = TOKEN_FIELDS
        .iter()
        .filter_map(|key| {
            let value = fields.get(*key)?.as_str()?.trim();
            (!value.is_empty()).then(|| (*key, value.to_string()))
        })
        .collect();
    form.push(("client_id", config.oauth.client_id.clone()));
    Ok(form)
}

/// The official client names itself on auth.x.ai calls too.
fn oauth_user_agent(config: &Config) -> String {
    let platform = config
        .platform
        .as_ref()
        .map(PlatformInfo::normalized)
        .unwrap_or_else(PlatformInfo::current);
    user_agent_string_for(PRODUCT, CLIENT_VERSION, &platform)
}

async fn post_form<T: Serialize + ?Sized>(
    client: &reqwest::Client,
    config: &Config,
    url: &str,
    form: &T,
) -> Result<OauthReply, String> {
    let response = client
        .post(url)
        .header("accept", "*/*")
        .header("user-agent", oauth_user_agent(config))
        .timeout(OAUTH_TIMEOUT)
        .form(form)
        .send()
        .await
        .map_err(|_| "oauth_transport".to_string())?;
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok(OauthReply { status, body })
}

async fn discovery_document(client: &reqwest::Client, config: &Config) -> Result<Value, String> {
    let discovery = config.oauth.discovery_url.trim();
    if discovery.is_empty() || !allowed_oauth_url(discovery) {
        return Err("grok_oauth_discovery_failed".to_string());
    }
    let response = client
        .get(discovery)
        .timeout(OAUTH_TIMEOUT)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| "grok_oauth_discovery_failed".to_string())?;
    if !response.status().is_success() {
        return Err("grok_oauth_discovery_failed".to_string());
    }
    response
        .json()
        .await
        .map_err(|_| "grok_oauth_discovery_failed".to_string())
}

/// Discovered endpoints must be https on x.ai; see allowed_oauth_url.
fn discovered_endpoint(document: &Value, key: &str) -> Result<String, String> {
    let url = text(document, key);
    if !allowed_oauth_url(&url) {
        return Err("grok_oauth_discovery_failed".to_string());
    }
    Ok(url)
}

async fn resolve_token_url(client: &reqwest::Client, config: &Config) -> Result<String, String> {
    let configured = config.oauth.token_url.trim();
    if !configured.is_empty() {
        if !allowed_configured_token_url(configured) {
            return Err("grok_oauth_not_configured".to_string());
        }
        return Ok(configured.to_string());
    }
    let document = discovery_document(client, config).await?;
    discovered_endpoint(&document, "token_endpoint")
}

async fn resolve_device_url(client: &reqwest::Client, config: &Config) -> Result<String, String> {
    let document = discovery_document(client, config).await?;
    discovered_endpoint(&document, "device_authorization_endpoint")
}

fn is_loopback_host(url: &reqwest::Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
}

/// Same rule as Node's isGrokOauthEndpoint: an operator may point token_url at a
/// loopback mock IdP. Only discovery results are held to https on x.ai.
fn allowed_configured_token_url(value: &str) -> bool {
    if allowed_oauth_url(value) {
        return true;
    }
    reqwest::Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https") && is_loopback_host(&url))
        .unwrap_or(false)
}

fn allowed_oauth_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if is_loopback_host(&url) {
        // Discovery could otherwise point token_endpoint at this machine and
        // the refresh token would be posted there.
        return false;
    }
    url.scheme() == "https" && (host == "x.ai" || host.ends_with(".x.ai"))
}

/// `expires_in` as an integer, a float, or a numeric string. None when it is
/// missing: the stored expiry is then cleared, as Node does, instead of keeping the
/// old one and refreshing again on every request.
fn expires_at_from(payload: &Value, now: i64) -> Option<i64> {
    let value = payload.get("expires_in")?;
    let secs = value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.trim().parse::<f64>().ok())
    })?;
    if !secs.is_finite() || secs <= 0.0 {
        return None;
    }
    Some(now.saturating_add((secs * 1000.0) as i64))
}

fn text(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refresh_form_names_the_principal_when_known() {
        let fields = refresh_form("rt", "client", "user-1");
        assert_eq!(
            fields,
            vec![
                ("grant_type", "refresh_token"),
                ("refresh_token", "rt"),
                ("client_id", "client"),
                ("principal_type", "User"),
                ("principal_id", "user-1"),
            ]
        );
        assert!(!fields.iter().any(|(name, _)| *name == "scope"));
        let plain = refresh_form("rt", "client", "");
        assert_eq!(plain.len(), 3);
    }

    #[test]
    fn expires_in_accepts_numbers_and_strings() {
        assert_eq!(
            expires_at_from(&json!({"expires_in": 3600}), 1_000),
            Some(3_601_000)
        );
        assert_eq!(expires_at_from(&json!({"expires_in": 1.5}), 0), Some(1_500));
        assert_eq!(
            expires_at_from(&json!({"expires_in": "60"}), 0),
            Some(60_000)
        );
        assert_eq!(expires_at_from(&json!({}), 0), None);
        assert_eq!(expires_at_from(&json!({"expires_in": 0}), 0), None);
        assert_eq!(expires_at_from(&json!({"expires_in": "soon"}), 0), None);
    }

    fn sample_config(dir: &std::path::Path) -> Config {
        serde_json::from_value(json!({
            "socket_path": dir.join("grok.sock"),
            "credentials_path": dir.join("cred.json"),
            "agent_id_path": dir.join("agent"),
            "refresh_lock_path": dir.join("lock"),
            "internal_token": "t",
            "base_url": "https://cli-chat-proxy.grok.com",
            // Never reached: a refresh in these tests would fail on this URL.
            "oauth": { "token_url": "https://invalid.example/token", "client_id": "c" }
        }))
        .unwrap()
    }

    #[test]
    fn token_form_keeps_known_fields_in_order_and_our_client_id() {
        let dir = std::env::temp_dir();
        let config = sample_config(&dir);
        let fields = json!({
            "client_id": "someone-else",
            "device_code": "dc",
            "grant_type": DEVICE_CODE_GRANT,
            "scope": "admin",
            "extra": "x"
        });
        let form = token_form(&config, fields.as_object().unwrap()).unwrap();
        assert_eq!(
            form,
            vec![
                ("grant_type", DEVICE_CODE_GRANT.to_string()),
                ("device_code", "dc".to_string()),
                ("client_id", "c".to_string()),
            ]
        );
        let bad = json!({ "grant_type": "client_credentials" });
        assert_eq!(
            token_form(&config, bad.as_object().unwrap()).unwrap_err(),
            "bad_grant"
        );
    }

    #[tokio::test]
    async fn a_token_refreshed_while_waiting_is_reused() {
        let dir = std::env::temp_dir().join(format!("grok-oauth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = sample_config(&dir);
        let fresh = now_ms() + 3_600_000;
        credentials::write_tokens(
            &config.credentials_path,
            "new-at",
            "new-rt",
            "",
            Some(fresh),
        )
        .unwrap();
        let client = reqwest::Client::new();
        let got = refresh_account(&client, &config, "old-at").await.unwrap();
        assert_eq!(got.access_token, "new-at");
        assert_eq!(got.refresh_token, "new-rt");
        // The token the caller already holds is not reused: it goes to the token endpoint.
        let err = refresh_account(&client, &config, "new-at")
            .await
            .unwrap_err();
        assert_eq!(err, "grok_oauth_not_configured");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oauth_token_url_rejects_loopback() {
        assert!(allowed_oauth_url("https://auth.x.ai/oauth2/token"));
        assert!(!allowed_oauth_url("http://127.0.0.1/token"));
        assert!(!allowed_oauth_url("https://localhost/token"));
        assert!(!allowed_oauth_url("https://evil.example/token"));
        assert!(!allowed_oauth_url("http://auth.x.ai/oauth2/token"));
    }

    #[test]
    fn configured_token_url_may_be_a_loopback_mock() {
        assert!(allowed_configured_token_url("http://127.0.0.1:9/token"));
        assert!(allowed_configured_token_url("http://localhost:9/token"));
        assert!(allowed_configured_token_url(
            "https://auth.x.ai/oauth2/token"
        ));
        assert!(!allowed_configured_token_url("https://evil.example/token"));
        assert!(!allowed_configured_token_url(
            "http://auth.x.ai/oauth2/token"
        ));
        assert!(!allowed_configured_token_url("file:///tmp/token"));
    }
}
