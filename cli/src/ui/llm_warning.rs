//! Shown under the header while the LLM provider lacks a setting, because the
//! agent cannot answer until it has one. Asked once, when the session starts.

use super::layout::{BorderKind, El, col, styled, text};
use crate::api::LlmProviderStatus;
use crate::term::style::{Color, Style};
use crate::term::text::Span;

pub fn llm_provider_warning(status: &LlmProviderStatus) -> Option<El> {
    if status.missing_settings.is_empty() {
        return None;
    }
    let mut required = vec![text(vec![
        Span::plain("Required for "),
        Span::new(status.provider.clone(), Style::new().bold()),
    ])];
    required.extend(
        status
            .missing_settings
            .iter()
            .map(|s| styled(s.clone(), Style::new().bold())),
    );
    Some(
        col(vec![
            styled("Connect a model provider", Style::new().fg(Color::Yellow).bold()),
            styled("Your agent needs a provider connection to reply.", Style::default()),
            col(required).margin_y(1).el(),
            styled(
                "Switch providers with LLM_PROVIDER. Restart Prism after editing environment variables.",
                Style::new().dim(),
            ),
        ])
        .border_left_only(BorderKind::Single, Color::Yellow)
        .pad_left(2)
        .margin_bottom(1)
        .el(),
    )
}
