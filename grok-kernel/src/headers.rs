//! Request headers for Grok Build 1.0.62.
//!
//! Inference headers follow the official sampler client (`SamplingClient::new`,
//! `user_agent_string_for`, `GrokRequestHeaders::apply`). Billing and device
//! login use a different call site and must not be mixed into inference.

/// Pinned to the installed `grok 1.0.62` binary. Re-check that binary before changing this.
pub const CLIENT_VERSION: &str = "1.0.62";
pub const CLIENT_IDENTIFIER: &str = "grok-shell";
pub const PRODUCT: &str = "grok-shell";

/// Billing probes are non-interactive. The sampler does not send this header.
pub const BILLING_CLIENT_MODE: &str = "headless";

pub const INFERENCE_ALWAYS: &[&str] = &[
    "x-grok-conv-id",
    "x-grok-req-id",
    "x-grok-model-override",
    "x-grok-session-id",
    "x-grok-agent-id",
];

/// Present on other Grok Build call sites. Never attached to an inference POST.
pub const NOT_ON_INFERENCE: &[&str] = &[
    "x-xai-token-auth",
    "x-authenticateresponse",
    "x-grok-client-mode",
    "x-grok-client-surface",
    "x-grok-experiments",
];

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
}

impl PlatformInfo {
    /// Same buckets as `PlatformInfo::current()`: macos, windows, otherwise linux.
    pub fn current() -> Self {
        Self {
            os: normalize_os(std::env::consts::OS),
            arch: normalize_arch(std::env::consts::ARCH),
        }
    }

    /// The same buckets for a platform Node pinned for the slot.
    pub fn normalized(&self) -> Self {
        Self {
            os: normalize_os(&self.os),
            arch: normalize_arch(&self.arch),
        }
    }
}

pub fn normalize_os(raw: &str) -> String {
    match raw {
        "macos" | "darwin" => "macos".to_string(),
        "windows" => "windows".to_string(),
        _ => "linux".to_string(),
    }
}

pub fn normalize_arch(raw: &str) -> String {
    match raw {
        "arm64" | "aarch64" => "aarch64".to_string(),
        "x86_64" | "amd64" => "x86_64".to_string(),
        other => other.to_string(),
    }
}

/// Official `user_agent_string_for` for product `grok-shell` at the baked version.
pub fn user_agent_string_for(product: &str, version: &str, platform: &PlatformInfo) -> String {
    let ver = if product == PRODUCT && version == CLIENT_VERSION {
        version
    } else {
        CLIENT_VERSION
    };
    format!("{PRODUCT}/{ver} ({}; {})", platform.os, platform.arch)
}

#[derive(Clone, Debug, Default)]
pub struct InferenceHeaderInput {
    pub access_token: String,
    pub session_id: String,
    pub request_id: String,
    pub model_id: String,
    pub agent_id: String,
    pub turn_idx: Option<String>,
    pub transient_retry: Option<String>,
    pub deployment_id: Option<String>,
    pub user_id: Option<String>,
    pub conv_group_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct HeaderList {
    pub pairs: Vec<(String, String)>,
}

impl HeaderList {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn contains(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    fn push(&mut self, name: &str, value: impl Into<String>) {
        self.pairs.push((name.to_string(), value.into()));
    }

    fn push_if_some(&mut self, name: &str, value: &Option<String>) {
        if let Some(text) = value {
            if !text.is_empty() {
                self.push(name, text.clone());
            }
        }
    }
}

fn client_base(token: &str, platform: &PlatformInfo) -> HeaderList {
    let mut headers = HeaderList { pairs: Vec::new() };
    headers.push("content-type", "application/json");
    headers.push("authorization", format!("Bearer {token}"));
    headers.push(
        "user-agent",
        user_agent_string_for(PRODUCT, CLIENT_VERSION, platform),
    );
    headers.push("x-grok-client-version", CLIENT_VERSION);
    headers
}

/// Sampler inference headers. The five `x-grok-*` ids are always sent, even when empty.
pub fn inference_headers(input: &InferenceHeaderInput, platform: &PlatformInfo) -> HeaderList {
    let mut headers = client_base(&input.access_token, platform);
    headers.push("x-grok-client-identifier", CLIENT_IDENTIFIER);
    headers.push("x-grok-conv-id", input.session_id.clone());
    headers.push("x-grok-req-id", input.request_id.clone());
    headers.push("x-grok-model-override", input.model_id.clone());
    headers.push("x-grok-session-id", input.session_id.clone());
    headers.push("x-grok-agent-id", input.agent_id.clone());
    headers.push_if_some("x-grok-turn-idx", &input.turn_idx);
    headers.push_if_some("x-grok-transient-retry", &input.transient_retry);
    headers.push_if_some("x-grok-deployment-id", &input.deployment_id);
    headers.push_if_some("x-grok-user-id", &input.user_id);
    headers.push_if_some("x-grok-conv-group-id", &input.conv_group_id);
    headers
}

/// `GET /v1/models`. No conversation ids and no billing/login headers.
pub fn models_headers(access_token: &str, platform: &PlatformInfo) -> HeaderList {
    let mut headers = client_base(access_token, platform);
    headers.push("x-grok-client-identifier", CLIENT_IDENTIFIER);
    headers
}

/// `GET /v1/billing`. `x-grok-client-mode` belongs here, not on inference.
pub fn billing_headers(access_token: &str, platform: &PlatformInfo) -> HeaderList {
    let mut headers = client_base(access_token, platform);
    headers.push("x-grok-client-mode", BILLING_CLIENT_MODE);
    headers
}

/// Device login. `x-grok-client-surface` is only sent when the caller has a value.
pub fn login_headers(access_token: &str, surface: &str, platform: &PlatformInfo) -> HeaderList {
    let mut headers = client_base(access_token, platform);
    if !surface.is_empty() {
        headers.push("x-grok-client-surface", surface.to_string());
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux() -> PlatformInfo {
        PlatformInfo {
            os: "linux".to_string(),
            arch: "x86_64".to_string(),
        }
    }

    #[test]
    fn user_agent_matches_sampler_format() {
        let ua = user_agent_string_for(PRODUCT, CLIENT_VERSION, &linux());
        assert_eq!(ua, "grok-shell/1.0.62 (linux; x86_64)");
        assert_eq!(normalize_os("darwin"), "macos");
        assert_eq!(normalize_arch("arm64"), "aarch64");
        let mac = PlatformInfo {
            os: normalize_os("darwin"),
            arch: normalize_arch("arm64"),
        };
        assert_eq!(
            user_agent_string_for("grok-shell", "1.0.62", &mac),
            "grok-shell/1.0.62 (macos; aarch64)"
        );
    }

    #[test]
    fn inference_always_sends_empty_ids_and_skips_other_call_sites() {
        let headers = inference_headers(
            &InferenceHeaderInput {
                access_token: "tok".to_string(),
                session_id: String::new(),
                request_id: String::new(),
                model_id: String::new(),
                agent_id: String::new(),
                ..InferenceHeaderInput::default()
            },
            &linux(),
        );
        assert_eq!(headers.get("content-type"), Some("application/json"));
        assert_eq!(headers.get("authorization"), Some("Bearer tok"));
        assert_eq!(headers.get("x-grok-client-version"), Some("1.0.62"));
        assert_eq!(headers.get("x-grok-client-identifier"), Some("grok-shell"));
        for name in INFERENCE_ALWAYS {
            assert_eq!(
                headers.get(name),
                Some(""),
                "{name} must be sent even when empty"
            );
        }
        assert!(!headers.contains("x-grok-turn-idx"));
        assert!(!headers.contains("x-grok-transient-retry"));
        assert!(!headers.contains("x-grok-deployment-id"));
        assert!(!headers.contains("x-grok-user-id"));
        assert!(!headers.contains("x-grok-conv-group-id"));
        for name in NOT_ON_INFERENCE {
            assert!(!headers.contains(name), "{name} is not an inference header");
        }
    }

    #[test]
    fn optional_inference_headers_are_sent_only_when_set() {
        let headers = inference_headers(
            &InferenceHeaderInput {
                access_token: "tok".to_string(),
                session_id: "sess".to_string(),
                request_id: "req".to_string(),
                model_id: "grok-4".to_string(),
                agent_id: "agent".to_string(),
                turn_idx: Some("2".to_string()),
                deployment_id: Some("dep".to_string()),
                ..InferenceHeaderInput::default()
            },
            &linux(),
        );
        assert_eq!(headers.get("x-grok-conv-id"), Some("sess"));
        assert_eq!(headers.get("x-grok-session-id"), Some("sess"));
        assert_eq!(headers.get("x-grok-turn-idx"), Some("2"));
        assert_eq!(headers.get("x-grok-deployment-id"), Some("dep"));
        assert!(!headers.contains("x-grok-user-id"));
    }

    #[test]
    fn models_and_billing_do_not_reuse_inference_ids() {
        let models = models_headers("tok", &linux());
        assert_eq!(models.get("x-grok-client-identifier"), Some("grok-shell"));
        assert!(!models.contains("x-grok-conv-id"));
        assert!(!models.contains("x-grok-client-mode"));
        assert!(!models.contains("x-grok-client-surface"));

        let billing = billing_headers("tok", &linux());
        assert_eq!(billing.get("x-grok-client-mode"), Some("headless"));
        assert!(!billing.contains("x-grok-conv-id"));
        assert!(!billing.contains("x-grok-client-identifier"));
        assert!(!billing.contains("x-grok-client-surface"));

        let login = login_headers("tok", "cli", &linux());
        assert_eq!(login.get("x-grok-client-surface"), Some("cli"));
        assert!(!login.contains("x-grok-client-mode"));
        assert!(!login.contains("x-grok-conv-id"));
    }
}
