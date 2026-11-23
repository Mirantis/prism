//! The tags of the memory blocks a chat turn sends after the user's message, and
//! stores as hidden USER rows so a replayed thread rebuilds the same prompt.

pub const RECALLED_TAG: &str = "recalled-memories";
pub const RECENT_TAG: &str = "recent-memories";

pub fn memory_block_opening(tag: &str) -> String {
    format!("\n\nContext:\n<{tag}>\n")
}

/// Whether `text` is one of those blocks rather than something a person wrote.
pub fn is_memory_block_content(text: &str) -> bool {
    text.starts_with(&memory_block_opening(RECALLED_TAG))
        || text.starts_with(&memory_block_opening(RECENT_TAG))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompts::context_builder::recalled_memory_content;

    #[test]
    fn tells_a_memory_block_from_a_persons_message() {
        assert!(is_memory_block_content(&recalled_memory_content(
            "- The repo uses vitest."
        )));
        assert!(!is_memory_block_content(
            "Context: <recalled-memories> is what I typed"
        ));
    }
}
