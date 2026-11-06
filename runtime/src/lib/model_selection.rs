//! The model selection an agent runs under: Fixed or Auto, and the three Auto
//! tiers, with the deployment defaults (`CONFIG.model_selection`) applied.

use serde::{Deserialize, Serialize};

use crate::config::CONFIG;
use crate::db::models::{AgentModelMode, AgentWorkspace};

/// A tier of Auto model selection, smallest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    Small,
    Medium,
    Large,
}

impl ModelTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
        }
    }
}

pub const MODEL_TIERS: [ModelTier; 3] = [ModelTier::Small, ModelTier::Medium, ModelTier::Large];

/// Fixed or Auto; the deployment default has the same type.
pub use crate::config::ModelSelectionMode;

/// The model of each tier (`Record<ModelTier, string | null>`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelTiers {
    pub small: Option<String>,
    pub medium: Option<String>,
    pub large: Option<String>,
}

impl ModelTiers {
    /// `tiers[tier]`.
    pub fn get(&self, tier: ModelTier) -> Option<&str> {
        match tier {
            ModelTier::Small => self.small.as_deref(),
            ModelTier::Medium => self.medium.as_deref(),
            ModelTier::Large => self.large.as_deref(),
        }
    }
}

/// The model selection a turn runs under, after the deployment defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSelection {
    pub mode: ModelSelectionMode,
    pub tiers: ModelTiers,
}

/// The four columns of an agent row a model selection is read from.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredModelSelection {
    pub model_mode: Option<AgentModelMode>,
    pub small_model: Option<String>,
    pub medium_model: Option<String>,
    pub large_model: Option<String>,
}

impl From<&AgentWorkspace> for StoredModelSelection {
    fn from(agent: &AgentWorkspace) -> Self {
        Self {
            model_mode: agent.model_mode.clone(),
            small_model: agent.small_model.clone(),
            medium_model: agent.medium_model.clone(),
            large_model: agent.large_model.clone(),
        }
    }
}

/// Merge an agent's stored model selection with the deployment defaults
/// (`CONFIG.model_selection`). The one place a null column meets its env fallback,
/// as `resolve_effective_model` is for the fixed model.
pub fn resolve_model_selection(stored: &StoredModelSelection) -> ModelSelection {
    let mode = match &stored.model_mode {
        Some(AgentModelMode::Auto) => ModelSelectionMode::Auto,
        Some(_) => ModelSelectionMode::Fixed,
        None => CONFIG.model_selection.mode,
    };
    ModelSelection {
        mode,
        tiers: ModelTiers {
            small: stored
                .small_model
                .clone()
                .or_else(|| CONFIG.model_selection.tiers.small.clone()),
            medium: stored
                .medium_model
                .clone()
                .or_else(|| CONFIG.model_selection.tiers.medium.clone()),
            large: stored
                .large_model
                .clone()
                .or_else(|| CONFIG.model_selection.tiers.large.clone()),
        },
    }
}

/// The tiers Auto needs and lacks: small and large are required, medium is
/// optional. An empty model id counts as missing.
pub fn missing_auto_tiers(tiers: &ModelTiers) -> Vec<ModelTier> {
    [ModelTier::Small, ModelTier::Large]
        .into_iter()
        .filter(|tier| tiers.get(*tier).is_none_or(str::is_empty))
        .collect()
}
