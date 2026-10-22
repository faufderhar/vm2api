use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::config::Config;
use crate::credentials::{self, Account};

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
    let response = client
        .post(&token_url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", account.refresh_token.as_str()),
            ("client_id", config.oauth.client_id.as_str()),
        ])
        .send()
        .await
        .map_err(|err| format!("refresh_failed:{err}"))?;
    let status = response.status();
    let payload: Value = response.json().await.unwrap_or(Value::Null);
    let oauth_error = payload
        .get("error")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if status.as_u16() == 401 || status.as_u16() == 403 || oauth_error == "invalid_grant" {
        return Err("refresh_rejected".to_string());
    }
    if !status.is_success() {
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

async fn resolve_token_url(client: &reqwest::Client, config: &Config) -> Result<String, String> {
    let configured = config.oauth.token_url.trim();
    if !configured.is_empty() {
        if !allowed_oauth_url(configured) {
            return Err("grok_oauth_not_configured".to_string());
        }
        return Ok(configured.to_string());
    }
    let discovery = config.oauth.discovery_url.trim();
    if discovery.is_empty() || !allowed_oauth_url(discovery) {
        return Err("grok_oauth_discovery_failed".to_string());
    }
    let response = client
        .get(discovery)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| "grok_oauth_discovery_failed".to_string())?;
    if !response.status().is_success() {
        return Err("grok_oauth_discovery_failed".to_string());
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "grok_oauth_discovery_failed".to_string())?;
    let token_url = text(&payload, "token_endpoint");
    if !allowed_oauth_url(&token_url) {
        return Err("grok_oauth_discovery_failed".to_string());
    }
    Ok(token_url)
}

fn allowed_oauth_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "localhost" || host == "127.0.0.1" || host == "::1" {
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
}
