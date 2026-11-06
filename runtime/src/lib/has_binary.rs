//! Whether a program is installed on this host.
//!
//! Each feature that shells out to a toolchain checks its own binaries before it offers
//! itself: voice meetings check the audio stack, the agent's computer checks the desktop
//! packages. Both ask here, so there is one definition of "on PATH".

use std::path::Path;

/// The first named program that is not on PATH, or `None` when all of them are.
pub async fn missing_binary(names: &[&str]) -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let dirs: Vec<&str> = path.split(':').filter(|dir| !dir.is_empty()).collect();
    for name in names {
        let mut found = false;
        for dir in &dirs {
            if tokio::fs::metadata(Path::new(dir).join(name)).await.is_ok() {
                found = true;
                break;
            }
        }
        if !found {
            return Some((*name).to_string());
        }
    }
    None
}

/// Whether every named program is on PATH.
pub async fn has_binaries(names: &[&str]) -> bool {
    missing_binary(names).await.is_none()
}
