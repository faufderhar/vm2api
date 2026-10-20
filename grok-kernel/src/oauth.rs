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

pub async fn refresh_account(
    client: &reqwest::Client,
    config: &Config,
) -> Result<RefreshedToken, String> {
    let _lock = credentials::acquire_refresh_lock(&config.refresh_lock_path).await?;
    let account = credentials::read_account(&config.credentials_path)?;
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
    let expires_at_ms = payload
        .get("expires_in")
        .and_then(|value| value.as_i64())
        .filter(|secs| *secs > 0)
        .map(|secs| now_ms() + secs.saturating_mul(1000));
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
        return url.scheme() == "https" || url.scheme() == "http";
    }
    url.scheme() == "https" && (host == "x.ai" || host.ends_with(".x.ai"))
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
