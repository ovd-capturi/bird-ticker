//! Runtime configuration, read from the environment once at startup.
//! Mirrors the `process.env.*` reads scattered through `proxy/server.js`.

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: Option<String>,
    pub vapid_public: String,
    pub vapid_private: String,
    pub foundry_endpoint: String,
    pub foundry_key: String,
    pub foundry_deployment: String,
    pub foundry_api_version: String,
}

// Defaults preserved from server.js (dev-only VAPID keys; not production-safe).
const DEFAULT_VAPID_PUBLIC: &str =
    "BCSf4An6NXJ55JAhdKchlCSrftouKF6D3G4Uhi5idkfIgMgNqJeOksh-NOS-QT7yqq3Hh_4c1IRsi7Xreq_dLVM";
const DEFAULT_VAPID_PRIVATE: &str = "E99i35Z9VdS7HkqRPU2jCgpoju5K6lUWIbaVRaz0_Gg";

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());

        Config {
            port: env("PORT").and_then(|p| p.parse().ok()).unwrap_or(3000),
            database_url: env("DATABASE_URL"),
            vapid_public: env("VAPID_PUBLIC").unwrap_or_else(|| DEFAULT_VAPID_PUBLIC.to_string()),
            vapid_private: env("VAPID_PRIVATE").unwrap_or_else(|| DEFAULT_VAPID_PRIVATE.to_string()),
            foundry_endpoint: env("AZURE_FOUNDRY_ENDPOINT").unwrap_or_default(),
            foundry_key: env("AZURE_FOUNDRY_KEY").unwrap_or_default(),
            foundry_deployment: env("AZURE_FOUNDRY_DEPLOYMENT").unwrap_or_default(),
            foundry_api_version: env("AZURE_FOUNDRY_API_VERSION")
                .unwrap_or_else(|| "2024-08-01-preview".to_string()),
        }
    }

    /// AI endpoints return 503 unless all three Foundry settings are present
    /// (matches the guard in `/api/ai-predictions`).
    pub fn ai_configured(&self) -> bool {
        !self.foundry_endpoint.is_empty()
            && !self.foundry_key.is_empty()
            && !self.foundry_deployment.is_empty()
    }
}
