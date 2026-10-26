//! Request headers for Grok Build 1.0.70.
//!
//! Each call site follows what the official 1.0.70 client sends there:
//! inference (`grok -p`, `POST /v1/responses`), the model list and the credits
//! read (`GET /v1/models`, `GET /v1/billing?format=credits`). Device login uses
//! yet another call site and is not mixed in.
//!
//! Client mode: official inference from `grok -p` says `headless`; the model list
//! and billing are only read by the TUI, which says `interactive`. Each call site
//! reports the mode the official client uses for it, so no request carries a
//! combination the real client never sends.

use uuid::Uuid;

/// Matches the official build the headers were checked against.
pub const CLIENT_VERSION: &str = "1.0.70";
pub const CLIENT_IDENTIFIER: &str = "grok-shell";
pub const PRODUCT: &str = "grok-shell";
/// Billing is read by the TUI pager, whose User-Agent names itself first.
pub const PAGER_PRODUCT: &str = "grok-pager";
pub const TOKEN_AUTH: &str = "xai-grok-cli";
pub const AUTHENTICATE_RESPONSE: &str = "authenticate-response";
pub const DOOM_LOOP_CHECK: &str = "1024";
pub const EXACT_REPETITION_CHECK: &str = "64";

/// `grok -p` inference.
pub const INFERENCE_CLIENT_MODE: &str = "headless";
/// The model list and billing: TUI-only reads.
pub const TUI_CLIENT_MODE: &str = "interactive";
/// Kept for callers that still name the billing mode.
pub const BILLING_CLIENT_MODE: &str = TUI_CLIENT_MODE;

pub const INFERENCE_ALWAYS: &[&str] = &[
    "x-grok-conv-id",
    "x-grok-req-id",
    "x-grok-model-override",
    "x-grok-session-id",
    "x-grok-agent-id",
];

/// Present on other Grok Build call sites. Never attached to an inference POST.
pub const NOT_ON_INFERENCE: &[&str] = &[
    "x-grok-client-surface",
    "x-grok-experiments",
    "x-userid",
    "x-email",
];

/// Namespace for the stable v5 ids this gateway derives (agent, conversation group).
/// Node derives the same ids (`grok-client.mjs`); keep both in step.
pub const ID_NAMESPACE: Uuid = Uuid::from_bytes([
    0x5c, 0x0b, 0x7e, 0x2a, 0x41, 0x9d, 0x4f, 0x63, 0x8a, 0x1e, 0x6d, 0x27, 0xb3, 0x90, 0xc4, 0x58,
]);

/// A stable UUID for one slot install. A stored id that is already a UUID is kept;
/// an older random seed (hex) maps to the same v5 id every time.
pub fn agent_uuid(seed: &str) -> String {
    let trimmed = seed.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = Uuid::parse_str(trimmed) {
        if trimmed.len() == 36 {
            return parsed.hyphenated().to_string();
        }
    }
    Uuid::new_v5(&ID_NAMESPACE, format!("agent:{trimmed}").as_bytes()).to_string()
}

/// The conversation group: one v5 id per (agent, conversation), stable across turns.
pub fn conv_group_uuid(agent_id: &str, session_id: &str) -> String {
    Uuid::new_v5(
        &ID_NAMESPACE,
        format!("conv-group:{agent_id}:{session_id}").as_bytes(),
    )
    .to_string()
}

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

/// The TUI pager's User-Agent: `grok-pager/{v} grok-shell/{v} ({os}; {arch})`.
pub fn pager_user_agent(platform: &PlatformInfo) -> String {
    format!(
        "{PAGER_PRODUCT}/{CLIENT_VERSION} {}",
        user_agent_string_for(PRODUCT, CLIENT_VERSION, platform)
    )
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

/// Inference headers in the official order. The five `x-grok-*` ids are always
/// sent, even when empty; user and conversation-group ids only when known.
pub fn inference_headers(input: &InferenceHeaderInput, platform: &PlatformInfo) -> HeaderList {
    let mut headers = HeaderList { pairs: Vec::new() };
    headers.push("content-type", "application/json");
    headers.push(
        "user-agent",
        user_agent_string_for(PRODUCT, CLIENT_VERSION, platform),
    );
    headers.push("x-grok-client-mode", INFERENCE_CLIENT_MODE);
    headers.push("x-xai-token-auth", TOKEN_AUTH);
    headers.push("x-authenticateresponse", AUTHENTICATE_RESPONSE);
    headers.push("x-grok-client-version", CLIENT_VERSION);
    headers.push("x-grok-client-identifier", CLIENT_IDENTIFIER);
    headers.push_if_some("x-grok-user-id", &input.user_id);
    headers.push_if_some("x-grok-conv-group-id", &input.conv_group_id);
    headers.push("authorization", format!("Bearer {}", input.access_token));
    headers.push("x-grok-conv-id", input.session_id.clone());
    headers.push("x-grok-req-id", input.request_id.clone());
    headers.push("x-grok-model-override", input.model_id.clone());
    headers.push("x-grok-session-id", input.session_id.clone());
    headers.push("x-grok-agent-id", input.agent_id.clone());
    let turn = input
        .turn_idx
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("1");
    headers.push("x-grok-turn-idx", turn.to_string());
    headers.push_if_some("x-grok-transient-retry", &input.transient_retry);
    headers.push_if_some("x-grok-deployment-id", &input.deployment_id);
    headers.push("accept", "text/event-stream");
    headers.push("x-grok-doom-loop-check", DOOM_LOOP_CHECK);
    headers.push("x-grok-exact-repetition-check", EXACT_REPETITION_CHECK);
    headers
}

/// The TUI's GET reads: no content-type (there is no body) and no client identifier.
fn tui_get_headers(access_token: &str, user_id: &Option<String>, user_agent: String) -> HeaderList {
    let mut headers = HeaderList { pairs: Vec::new() };
    headers.push("authorization", format!("Bearer {access_token}"));
    headers.push("x-xai-token-auth", TOKEN_AUTH);
    headers.push_if_some("x-userid", user_id);
    headers.push("x-grok-client-version", CLIENT_VERSION);
    headers.push("x-grok-client-mode", TUI_CLIENT_MODE);
    headers.push("accept", "*/*");
    headers.push("user-agent", user_agent);
    headers
}

/// `GET /v1/models`. No conversation ids.
pub fn models_headers(
    access_token: &str,
    user_id: &Option<String>,
    platform: &PlatformInfo,
) -> HeaderList {
    tui_get_headers(
        access_token,
        user_id,
        user_agent_string_for(PRODUCT, CLIENT_VERSION, platform),
    )
}

/// `GET /v1/billing`, as the TUI pager reads it.
pub fn billing_headers(
    access_token: &str,
    user_id: &Option<String>,
    platform: &PlatformInfo,
) -> HeaderList {
    tui_get_headers(access_token, user_id, pager_user_agent(platform))
}

/// Device login. `x-grok-client-surface` is only sent when the caller has a value.
pub fn login_headers(access_token: &str, surface: &str, platform: &PlatformInfo) -> HeaderList {
    let mut headers = HeaderList { pairs: Vec::new() };
    headers.push("content-type", "application/json");
    headers.push("authorization", format!("Bearer {access_token}"));
    headers.push(
        "user-agent",
        user_agent_string_for(PRODUCT, CLIENT_VERSION, platform),
    );
    headers.push("x-grok-client-version", CLIENT_VERSION);
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
    fn user_agent_matches_official_format() {
        let ua = user_agent_string_for(PRODUCT, CLIENT_VERSION, &linux());
        assert_eq!(ua, "grok-shell/1.0.70 (linux; x86_64)");
        assert_eq!(normalize_os("darwin"), "macos");
        assert_eq!(normalize_arch("arm64"), "aarch64");
        let mac = PlatformInfo {
            os: normalize_os("darwin"),
            arch: normalize_arch("arm64"),
        };
        assert_eq!(
            user_agent_string_for("grok-shell", "1.0.70", &mac),
            "grok-shell/1.0.70 (macos; aarch64)"
        );
        assert_eq!(
            pager_user_agent(&mac),
            "grok-pager/1.0.70 grok-shell/1.0.70 (macos; aarch64)"
        );
    }

    #[test]
    fn inference_always_sends_empty_ids_and_the_official_extras() {
        let headers = inference_headers(
            &InferenceHeaderInput {
                access_token: "tok".to_string(),
                ..InferenceHeaderInput::default()
            },
            &linux(),
        );
        assert_eq!(headers.get("content-type"), Some("application/json"));
        assert_eq!(headers.get("authorization"), Some("Bearer tok"));
        assert_eq!(headers.get("x-grok-client-version"), Some("1.0.70"));
        assert_eq!(headers.get("x-grok-client-identifier"), Some("grok-shell"));
        assert_eq!(headers.get("x-grok-client-mode"), Some("headless"));
        assert_eq!(headers.get("x-xai-token-auth"), Some("xai-grok-cli"));
        assert_eq!(
            headers.get("x-authenticateresponse"),
            Some("authenticate-response")
        );
        assert_eq!(headers.get("accept"), Some("text/event-stream"));
        assert_eq!(headers.get("x-grok-doom-loop-check"), Some("1024"));
        assert_eq!(headers.get("x-grok-exact-repetition-check"), Some("64"));
        assert_eq!(headers.get("x-grok-turn-idx"), Some("1"));
        for name in INFERENCE_ALWAYS {
            assert_eq!(
                headers.get(name),
                Some(""),
                "{name} must be sent even when empty"
            );
        }
        assert!(!headers.contains("x-grok-transient-retry"));
        assert!(!headers.contains("x-grok-deployment-id"));
        assert!(!headers.contains("x-grok-user-id"));
        assert!(!headers.contains("x-grok-conv-group-id"));
        for name in NOT_ON_INFERENCE {
            assert!(!headers.contains(name), "{name} is not an inference header");
        }
    }

    #[test]
    fn inference_header_order_follows_the_official_client() {
        let headers = inference_headers(
            &InferenceHeaderInput {
                access_token: "tok".to_string(),
                session_id: "sess".to_string(),
                request_id: "req".to_string(),
                model_id: "grok-4".to_string(),
                agent_id: "agent".to_string(),
                turn_idx: Some("3".to_string()),
                user_id: Some("user".to_string()),
                conv_group_id: Some("group".to_string()),
                ..InferenceHeaderInput::default()
            },
            &linux(),
        );
        let names: Vec<&str> = headers
            .pairs
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "content-type",
                "user-agent",
                "x-grok-client-mode",
                "x-xai-token-auth",
                "x-authenticateresponse",
                "x-grok-client-version",
                "x-grok-client-identifier",
                "x-grok-user-id",
                "x-grok-conv-group-id",
                "authorization",
                "x-grok-conv-id",
                "x-grok-req-id",
                "x-grok-model-override",
                "x-grok-session-id",
                "x-grok-agent-id",
                "x-grok-turn-idx",
                "accept",
                "x-grok-doom-loop-check",
                "x-grok-exact-repetition-check",
            ]
        );
        assert_eq!(headers.get("x-grok-conv-id"), Some("sess"));
        assert_eq!(headers.get("x-grok-session-id"), Some("sess"));
        assert_eq!(headers.get("x-grok-turn-idx"), Some("3"));
        assert_eq!(headers.get("x-grok-user-id"), Some("user"));
    }

    #[test]
    fn models_and_billing_are_tui_reads() {
        let user = Some("user".to_string());
        let models = models_headers("tok", &user, &linux());
        assert_eq!(models.get("x-xai-token-auth"), Some("xai-grok-cli"));
        assert_eq!(models.get("x-userid"), Some("user"));
        assert_eq!(models.get("x-grok-client-mode"), Some("interactive"));
        assert_eq!(models.get("accept"), Some("*/*"));
        assert_eq!(
            models.get("user-agent"),
            Some("grok-shell/1.0.70 (linux; x86_64)")
        );
        assert!(!models.contains("content-type"));
        assert!(!models.contains("x-grok-client-identifier"));
        assert!(!models.contains("x-grok-conv-id"));
        assert!(!models.contains("x-grok-client-surface"));

        let billing = billing_headers("tok", &None, &linux());
        assert_eq!(billing.get("x-grok-client-mode"), Some("interactive"));
        assert_eq!(
            billing.get("user-agent"),
            Some("grok-pager/1.0.70 grok-shell/1.0.70 (linux; x86_64)")
        );
        assert!(!billing.contains("x-userid"));
        assert!(!billing.contains("content-type"));
        assert!(!billing.contains("x-grok-conv-id"));
        assert!(!billing.contains("x-grok-client-identifier"));

        let login = login_headers("tok", "cli", &linux());
        assert_eq!(login.get("x-grok-client-surface"), Some("cli"));
        assert!(!login.contains("x-grok-client-mode"));
        assert!(!login.contains("x-grok-conv-id"));
    }

    #[test]
    fn derived_ids_are_stable_v5_uuids() {
        let seed = "ab".repeat(32);
        let agent = agent_uuid(&seed);
        assert_eq!(agent, agent_uuid(&seed));
        let parsed = Uuid::parse_str(&agent).unwrap();
        assert_eq!(parsed.get_version_num(), 5);
        // Shared vector with the Node mirror (test/unit/grok-client.test.mjs).
        assert_eq!(agent, "5910fd6e-751e-5ea7-a95d-73f41dd45224");
        let existing = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(agent_uuid(existing), existing);
        assert_eq!(agent_uuid(""), "");
        let group = conv_group_uuid(&agent, "sess");
        assert_eq!(group, conv_group_uuid(&agent, "sess"));
        assert_ne!(group, conv_group_uuid(&agent, "other"));
        assert_eq!(Uuid::parse_str(&group).unwrap().get_version_num(), 5);
    }
}
