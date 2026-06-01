//! Azure Foundry (OpenAI-compatible) chat client. Shared by the AI prediction
//! endpoints and the chat loop. Mirrors `foundryApiUrl()` + the fetch calls in
//! `proxy/server.js`.

use serde_json::Value;

use crate::config::Config;

/// Builds the chat-completions URL, handling both the `/openai/v1` style and
/// the classic `deployments/...?api-version=` style.
pub fn foundry_url(cfg: &Config) -> (bool, String) {
    let endpoint = cfg.foundry_endpoint.trim_end_matches('/');
    let is_v1 = endpoint.ends_with("/openai/v1");
    let url = if is_v1 {
        format!("{endpoint}/chat/completions")
    } else {
        format!(
            "{}/openai/deployments/{}/chat/completions?api-version={}",
            endpoint, cfg.foundry_deployment, cfg.foundry_api_version
        )
    };
    (is_v1, url)
}

/// POST a chat-completions request body, returning the parsed response JSON.
/// `model` is injected automatically for the v1-style endpoint.
pub async fn chat_completion(client: &reqwest::Client, cfg: &Config, mut body: Value) -> anyhow::Result<Value> {
    let (is_v1, url) = foundry_url(cfg);
    if is_v1 {
        body["model"] = Value::String(cfg.foundry_deployment.clone());
    }

    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("api-key", &cfg.foundry_key)
        .header("Authorization", format!("Bearer {}", cfg.foundry_key))
        .json(&body)
        .send()
        .await?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        anyhow::bail!("Foundry {}: {}", status.as_u16(), snippet);
    }
    Ok(res.json().await?)
}
