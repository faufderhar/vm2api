use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use crate::headers::PlatformInfo;

#[derive(Clone, Debug, Deserialize)]
pub struct OauthConfig {
    #[serde(default)]
    pub token_url: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub discovery_url: String,
    /// Device code scope. Node writes the public Grok CLI scope.
    #[serde(default)]
    pub scope: String,
    #[serde(default = "default_skew")]
    pub refresh_skew_sec: u64,
}

fn default_skew() -> u64 {
    300
}

#[derive(Clone, Debug, Deserialize)]
pub struct Config {
    pub socket_path: PathBuf,
    pub credentials_path: PathBuf,
    pub agent_id_path: PathBuf,
    pub refresh_lock_path: PathBuf,
    #[serde(default)]
    pub internal_token: String,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub proxy_required: bool,
    pub base_url: String,
    pub oauth: OauthConfig,
    /// The client platform this slot has always reported. Missing: this host's.
    #[serde(default)]
    pub platform: Option<PlatformInfo>,
}

impl Config {
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let text = fs::read_to_string(path).map_err(|err| format!("read config: {err}"))?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let config: Config =
            serde_json::from_str(text).map_err(|err| format!("parse config: {err}"))?;
        if config.internal_token.is_empty() {
            return Err("internal_token is required".to_string());
        }
        if !config.base_url.starts_with("https://") {
            return Err("base_url must be https".to_string());
        }
        Ok(config)
    }

    /// A configured proxy is the only non-local exit. An empty URL dials directly,
    /// which is allowed only for this slot's own route (`proxy_required: false`).
    pub fn dial_allowed(&self) -> bool {
        if !self.proxy_url.trim().is_empty() {
            return true;
        }
        !self.proxy_required
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(proxy_url: &str, proxy_required: bool) -> Config {
        Config {
            socket_path: PathBuf::from("/tmp/grok.sock"),
            credentials_path: PathBuf::from("/tmp/cred.json"),
            agent_id_path: PathBuf::from("/tmp/agent"),
            refresh_lock_path: PathBuf::from("/tmp/lock"),
            internal_token: "t".to_string(),
            proxy_url: proxy_url.to_string(),
            proxy_required,
            base_url: "https://cli-chat-proxy.grok.com".to_string(),
            platform: None,
            oauth: OauthConfig {
                token_url: String::new(),
                client_id: "client".to_string(),
                discovery_url: "https://auth.x.ai/.well-known/openid-configuration".to_string(),
                scope: String::new(),
                refresh_skew_sec: 300,
            },
        }
    }

    #[test]
    fn missing_proxy_does_not_dial_directly() {
        assert!(!sample("", true).dial_allowed());
        assert!(sample("", false).dial_allowed());
        assert!(sample("socks5://127.0.0.1:1", true).dial_allowed());
    }
}
