//! `CacheControlValidator`: reads a breakpoint from `providerOptions` and enforces
//! where one may stand and how many a request may have.

use serde_json::Value;

use crate::ai::{ProviderOptions, Warning};

/// Anthropic allows a maximum of 4 cache breakpoints per request.
const MAX_CACHE_BREAKPOINTS: usize = 4;

/// The `cacheControl` (or `cache_control`) a part's `anthropic` options name, as
/// given; the API validates it.
fn get_cache_control(provider_options: Option<&ProviderOptions>) -> Option<&Value> {
    let anthropic = provider_options?.get("anthropic")?;
    match anthropic.get("cacheControl") {
        Some(value) if !value.is_null() => Some(value),
        _ => anthropic.get("cache_control"),
    }
}

/// JavaScript truthiness of a JSON value.
pub(super) fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Where a breakpoint was found, for the warning that refuses it.
pub(super) struct CacheContext<'a> {
    pub kind: &'a str,
    pub can_cache: bool,
}

/// Tracks the breakpoints of one request across its messages and tools.
#[derive(Default)]
pub(super) struct CacheControlValidator {
    breakpoint_count: usize,
    warnings: Vec<Warning>,
}

impl CacheControlValidator {
    pub fn new() -> Self {
        Self::default()
    }

    /// The breakpoint to send for `provider_options` in `context`, or `None` when
    /// there is none, the context takes none, or the request already has four.
    pub fn get_cache_control(
        &mut self,
        provider_options: Option<&ProviderOptions>,
        context: CacheContext<'_>,
    ) -> Option<Value> {
        let value = get_cache_control(provider_options)?;
        if !is_truthy(value) {
            return None;
        }
        if !context.can_cache {
            self.warnings.push(Warning::Unsupported {
                feature: "cache_control on non-cacheable context".to_string(),
                details: Some(format!(
                    "cache_control cannot be set on {}. It will be ignored.",
                    context.kind
                )),
            });
            return None;
        }
        self.breakpoint_count += 1;
        if self.breakpoint_count > MAX_CACHE_BREAKPOINTS {
            self.warnings.push(Warning::Unsupported {
                feature: "cacheControl breakpoint limit".to_string(),
                details: Some(format!(
                    "Maximum {MAX_CACHE_BREAKPOINTS} cache breakpoints exceeded (found {}). This breakpoint will be ignored.",
                    self.breakpoint_count
                )),
            });
            return None;
        }
        Some(value.clone())
    }

    pub fn into_warnings(self) -> Vec<Warning> {
        self.warnings
    }
}

/// `{ type: 'user message', canCache: true }` and its kin.
pub(super) fn cacheable(kind: &str) -> CacheContext<'_> {
    CacheContext {
        kind,
        can_cache: true,
    }
}
