//! The status bar: the model, the share of its context window in use, an
//! available update and a connection error, on one left-aligned row.

use std::sync::LazyLock;

use regex::Regex;

use super::layout::{El, row, styled};
use crate::term::style::{Color, Style};
use crate::util::js_number;

/// A Claude model id as a short name: `claude-opus-4-7` reads "Opus 4.7". Any
/// other id shows as it is.
pub fn prettify_model_id(id: &str) -> String {
    static MODEL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(-|$))?").unwrap()
    });
    let Some(caps) = MODEL.captures(id) else {
        return id.to_string();
    };
    let family = &caps[1];
    let titled = format!("{}{}", family[..1].to_uppercase(), &family[1..]);
    match caps.get(3) {
        Some(minor) => format!("{titled} {}.{}", &caps[2], minor.as_str()),
        None => format!("{titled} {}", &caps[2]),
    }
}

/// A mid-luminance green that reads on light and dark themes alike.
const CONTEXT_GREEN: Color = Color::hex(0x3fb950);

/// Green while there is room, yellow past 80% used, red past 90%.
pub fn context_color(used_percent: f64) -> Color {
    if used_percent > 90.0 {
        return Color::Red;
    }
    if used_percent > 80.0 {
        return Color::Yellow;
    }
    CONTEXT_GREEN
}

pub struct StatusBarProps<'a> {
    pub model_id: &'a str,
    pub error: Option<Option<&'a str>>,
    pub context_used_percent: Option<f64>,
    pub update_available_version: Option<&'a str>,
}

pub fn status_bar(p: StatusBarProps<'_>) -> El {
    let mut children = vec![styled(
        prettify_model_id(p.model_id),
        Style::new().fg(Color::hex(0x7c3aed)),
    )];
    if let Some(percent) = p.context_used_percent {
        children.push(styled(
            format!(" | context {}%", js_number(percent)),
            Style::new().fg(context_color(percent)),
        ));
    }
    if let Some(version) = p.update_available_version {
        children.push(styled(
            format!(" | update available: {version} (/update)"),
            Style::new().fg(Color::Yellow),
        ));
    }
    if let Some(detail) = p.error {
        let text = match detail {
            Some(d) => format!(" ● error: {d}"),
            None => " ● error".into(),
        };
        children.push(styled(text, Style::new().fg(Color::Red)));
    }
    row(children).margin_top(1).el()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortens_claude_ids() {
        assert_eq!(
            prettify_model_id("us.anthropic.claude-opus-4-7"),
            "Opus 4.7"
        );
        assert_eq!(prettify_model_id("us.anthropic.claude-opus-5"), "Opus 5");
        assert_eq!(
            prettify_model_id("us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
            "Sonnet 4.5"
        );
        assert_eq!(prettify_model_id("claude-opus-5-20251001-v1:0"), "Opus 5");
        assert_eq!(prettify_model_id("gpt-5"), "gpt-5");
    }

    #[test]
    fn colours_the_context_reading() {
        assert_eq!(context_color(50.0), CONTEXT_GREEN);
        assert_eq!(context_color(85.0), Color::Yellow);
        assert_eq!(context_color(95.0), Color::Red);
    }
}
