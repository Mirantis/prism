//! Keeps the model catalog current when `MODELS_DEV_URL` names a registry: the
//! overlay the last refresh stored is installed at boot, the registry is fetched
//! then and once a day, and each overlay that lands is stored for the next boot.
//! Calls recorded without a price are priced again after every install, which also
//! prices the calls recorded before prices existed.

use std::time::Duration;

use serde_json::json;
use tokio::task::JoinHandle;

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::lib::model_catalog::{ModelCatalog, install_remote_catalog, refresh_model_catalog};
use crate::log_warn;
use crate::services::llm_call_service::LLM_CALL_SERVICE;
use crate::services::runtime_state_service::{MODEL_CATALOG_OVERLAY, RUNTIME_STATE_SERVICE};

const REFRESH_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

async fn install_stored_overlay() {
    // An install that turned the refresh off gets the bundled catalog only, not
    // what an earlier refresh stored.
    if CONFIG.models_dev_url.is_none() {
        return;
    }
    let stored = RUNTIME_STATE_SERVICE
        .get(MODEL_CATALOG_OVERLAY)
        .await
        .and_then(|stored| {
            stored
                .map(|text| serde_json::from_str::<ModelCatalog>(&text))
                .transpose()
                .map_err(anyhow::Error::from)
        });
    match stored {
        Ok(Some(overlay)) => {
            install_remote_catalog(&overlay);
        }
        Ok(None) => {}
        Err(err) => log_warn!(
            json!({ "err": err_json(&err) }),
            "[ModelCatalog] could not read the stored catalog; using the bundled one"
        ),
    }
}

async fn refresh() {
    let Some(remote) = refresh_model_catalog().await else {
        return;
    };
    let stored = match serde_json::to_string(&remote) {
        Ok(text) => {
            RUNTIME_STATE_SERVICE
                .set(MODEL_CATALOG_OVERLAY, &text)
                .await
        }
        Err(err) => Err(err.into()),
    };
    if let Err(err) = stored {
        log_warn!(
            json!({ "err": err_json(&err) }),
            "[ModelCatalog] could not store the refreshed catalog"
        );
    }
    LLM_CALL_SERVICE.price_unpriced_calls().await;
}

/// Install the stored overlay, then, in the background, price what it can and
/// refresh now and every day. Returns once the overlay is installed, so lookups
/// have it before the runtime serves; the pricing pass (one update per unpriced
/// row, many on the first boot after an upgrade) does not hold up startup.
/// Returns the daily task for the caller to abort on shutdown. Never fails.
pub async fn start_model_catalog_refresh() -> JoinHandle<()> {
    install_stored_overlay().await;
    // Chained, so the boot pass and the first refresh's pass never price the same rows at once.
    tokio::spawn(async {
        LLM_CALL_SERVICE.price_unpriced_calls().await;
        refresh().await;
    });
    tokio::spawn(async {
        loop {
            tokio::time::sleep(REFRESH_INTERVAL).await;
            tokio::spawn(refresh());
        }
    })
}
