//! generate-model-limits: regenerate `src/lib/model_limits.generated.json`, the bundled
//! model catalog, from the models.dev registry (`MODELS_DEV_URL`, else
//! `https://models.dev/api.json`).
//!
//! The runtime needs each model's input-context window, and no provider it talks to
//! reports one, so models.dev is the source and this command vendors it: the committed
//! JSON is the floor that needs no network. Entries stay provider-scoped and keyed by
//! exact model ID, because regions diverge in the registry.
//!
//! The filter is the runtime's own `reshape_registry`, so it cannot drift between
//! build time and boot time. Only the error policy differs: this command fails on
//! shape drift and leaves the committed JSON untouched, where the runtime degrades
//! to the floor. The registry data is MIT licensed by models.dev and recorded in
//! `THIRD_PARTY_NOTICES`; a regeneration keeps that entry.
//!
//! Run `npm run generate:model-limits` from the repository root, then commit the diff.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::Value;

use crate::lib::model_catalog::{ModelCatalog, REGISTRY_PROVIDERS, reshape_registry};

const DEFAULT_SOURCE: &str = "https://models.dev/api.json";

/// Where the bundled catalog lives in the source tree this binary was built from.
fn output_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib/model_limits.generated.json")
}

/// The catalog for `registry`, sorted by model ID for a stable diff. Fails when a
/// configured provider is missing or yields no usable model.
pub fn snapshot(registry: &Value) -> anyhow::Result<ModelCatalog> {
    for (registry_id, _) in REGISTRY_PROVIDERS {
        if registry
            .get(registry_id)
            .and_then(|p| p.get("models"))
            .is_none()
        {
            bail!("models.dev has no \"{registry_id}\" provider — did the registry shape change?");
        }
    }
    let reshaped = reshape_registry(registry).unwrap_or_default();
    let mut out = ModelCatalog::new();
    for (registry_id, provider) in REGISTRY_PROVIDERS {
        let Some(models) = reshaped.get(provider) else {
            bail!("no usable models found under \"{registry_id}\"");
        };
        let mut models = models.clone();
        models.sort_keys();
        out.insert(provider.to_string(), models);
    }
    Ok(out)
}

pub async fn main() -> i32 {
    match run().await {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("{err:#}");
            1
        }
    }
}

async fn run() -> anyhow::Result<()> {
    let source = std::env::var("MODELS_DEV_URL")
        .ok()
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| DEFAULT_SOURCE.to_string());
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?
        .get(&source)
        .send()
        .await
        .with_context(|| format!("could not fetch {source}"))?;
    let status = response.status();
    if !status.is_success() {
        bail!("{source} returned {status}");
    }
    let registry: Value = response.json().await?;
    let snapshot = snapshot(&registry)?;

    let out = output_path();
    std::fs::write(
        &out,
        format!("{}\n", serde_json::to_string_pretty(&snapshot)?),
    )
    .with_context(|| format!("could not write {}", out.display()))?;
    let counts = snapshot
        .iter()
        .map(|(provider, models)| format!("{provider}={}", models.len()))
        .collect::<Vec<_>>()
        .join(" ");
    println!("wrote {} ({counts})", out.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::model_catalog::bundled_model_catalog;

    #[test]
    fn fails_when_a_provider_is_missing() {
        let err = snapshot(&serde_json::json!({})).unwrap_err();
        assert!(err.to_string().contains("models.dev has no"));
    }

    #[test]
    fn regenerates_the_bundled_catalog_from_itself() {
        // The bundle, written back in the registry's shape, regenerates to the bundle.
        let bundled = bundled_model_catalog();
        let mut registry = serde_json::Map::new();
        for (registry_id, provider) in REGISTRY_PROVIDERS {
            let models: serde_json::Map<String, Value> = bundled[provider]
                .iter()
                .map(|(id, entry)| {
                    (id.clone(), serde_json::json!({ "limit": { "context": entry.context, "output": entry.output } }))
                })
                .collect();
            registry.insert(
                registry_id.to_string(),
                serde_json::json!({ "models": models }),
            );
        }
        let regenerated = snapshot(&Value::Object(registry)).unwrap();
        for (_, provider) in REGISTRY_PROVIDERS {
            let mut expected = bundled[provider].clone();
            expected.sort_keys();
            assert_eq!(regenerated[provider], expected);
        }
    }
}
