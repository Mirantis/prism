//! The prompt a run gets when it reaches its step limit.

use std::sync::LazyLock;

use crate::constants::STEP_LIMIT;

pub static EARLY_STOPPING_PROMPT: LazyLock<String> = LazyLock::new(|| {
    format!(
        "You have used all {STEP_LIMIT} steps this turn allows. From what you have found so far, give the best answer you can to the original request, and say what is left undone."
    )
});
