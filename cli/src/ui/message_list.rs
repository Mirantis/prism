//! The conversation: the newest 50 entries, each with its author line, its body,
//! its files and its tool calls (expanded with Ctrl+O).

use std::rc::Rc;

use serde_json::Value;

use super::layout::{El, col, render, row, styled};
use super::render_cache::{ImageStore, MarkdownCache};
use crate::attachments::format_file_size;
use crate::images::bitmap::{MAX_IMAGE_ROWS, image_columns};
use crate::images::graphics::{Cell, TerminalGraphics};
use crate::markdown::{MessagePart, chat_column_width};
use crate::protocol::{AttachmentMeta, Role, TuiMessage, Viewer};
use crate::shell_command::{SHELL_PREFIX, parse_shell_record};
use crate::term::style::{Color, Style};
use crate::term::text::{Line, js_len, js_slice_to};
use crate::transcript::ChatEntry;
use crate::util::js_number;

/// A cell when the terminal did not report its size: twice as tall as wide.
pub const DEFAULT_CELL: Cell = Cell {
    width: 10,
    height: 20,
};

pub struct Screen<'a> {
    pub columns: usize,
    pub rows: usize,
    pub graphics: TerminalGraphics,
    pub images: &'a ImageStore,
    pub markdown: &'a MarkdownCache,
    pub rows_cache: &'a RowCache,
}

/// What a laid-out message row depends on.
#[derive(PartialEq)]
struct RowKey {
    entry: ChatEntry,
    expanded: bool,
    width: usize,
    label: String,
}

/// Laid-out message rows, kept while nothing they show changes, so a frame that only
/// moves the spinner lays out no message again.
#[derive(Default)]
pub struct RowCache {
    rows: std::cell::RefCell<std::collections::HashMap<String, (RowKey, Rc<Vec<Line>>)>>,
}

impl RowCache {
    fn get(&self, key: &RowKey) -> Option<Rc<Vec<Line>>> {
        let rows = self.rows.borrow();
        let (cached, lines) = rows.get(&key.entry.message.id)?;
        (cached == key).then(|| lines.clone())
    }

    fn put(&self, key: RowKey, lines: Rc<Vec<Line>>) {
        let mut rows = self.rows.borrow_mut();
        if rows.len() > 200 {
            rows.clear();
        }
        rows.insert(key.entry.message.id.clone(), (key, lines));
    }
}

/// `String(value)` as JavaScript prints it.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(js_number).unwrap_or_else(|| n.to_string()),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let len = js_len(s);
    if len <= max {
        return s.to_string();
    }
    format!(
        "{}\n… (truncated {} more chars)",
        js_slice_to(s, max),
        len - max
    )
}

fn is_tool_call_array(v: &Value) -> Option<&Vec<Value>> {
    let a = v.as_array()?;
    a.iter()
        .all(|c| {
            c.as_object().is_some_and(|o| {
                o.contains_key("tool") && o.contains_key("input") && o.contains_key("output")
            })
        })
        .then_some(a)
}

fn tool_call_summary(tool_calls: &Value) -> Option<String> {
    let calls = tool_calls.as_array().filter(|a| !a.is_empty())?;
    let names: Vec<String> = calls
        .iter()
        .filter_map(|c| c.as_object().and_then(|o| o.get("tool")).map(js_string))
        .filter(|n| !n.is_empty())
        .collect();
    if names.is_empty() {
        return Some(format!("· used {} tool(s)", calls.len()));
    }
    Some(format!("· used {}", names.join(", ")))
}

/// "You", unless someone else wrote it: another person, or another agent.
fn user_label(message: &TuiMessage, me: Option<&Viewer>) -> String {
    if message.triggered_by == "AGENT_MESSAGE" {
        let name = message
            .sender_name
            .clone()
            .or(message.sender_id.clone())
            .unwrap_or_else(|| "Agent".into());
        return if message.agent_message_kind.as_deref() == Some("notice") {
            name
        } else {
            format!("{name} · Agent")
        };
    }
    let Some(me) = me else { return "You".into() };
    let Some(sender) = &message.sender_id else {
        return "You".into();
    };
    if me.id.as_ref() == Some(sender) {
        return "You".into();
    }
    message
        .sender_name
        .clone()
        .unwrap_or_else(|| sender.clone())
}

fn agent_body(message: &TuiMessage, screen: &Screen<'_>) -> Vec<El> {
    let width = chat_column_width(screen.columns);
    if !screen.graphics.kitty {
        return vec![El::Text(
            screen
                .markdown
                .lines(&message.id, &message.content, width)
                .to_vec(),
        )];
    }
    let max_rows = MAX_IMAGE_ROWS.min(4.max((screen.rows / 2) as u32));
    screen
        .markdown
        .parts(&message.id, &message.content, width)
        .iter()
        .map(|part| match part {
            MessagePart::Text(lines) => {
                let blank = lines.iter().all(Line::is_empty) && lines.len() <= 1;
                El::Text(if blank {
                    vec![Line::plain(" ")]
                } else {
                    lines.clone()
                })
            }
            MessagePart::Image { href, alt } => {
                inline_image(href, alt, message.attachments.as_deref(), screen, max_rows)
            }
        })
        .collect()
}

fn inline_image(
    href: &str,
    alt: &str,
    attachments: Option<&[AttachmentMeta]>,
    screen: &Screen<'_>,
    max_rows: u32,
) -> El {
    let id = href.strip_prefix("attachment:");
    let attachment = id.and_then(|id| attachments?.iter().find(|a| a.id == id && a.inline));
    if let Some(a) = attachment.filter(|a| a.expired) {
        let _ = a;
        return styled(format!("[image: {alt} · expired]"), Style::new().dim());
    }
    let drawable = attachment.is_some();
    if let Some(a) = attachment {
        let cell = screen.graphics.cell.unwrap_or(DEFAULT_CELL);
        if let Some(lines) =
            screen
                .images
                .placeholder(a, cell, image_columns(screen.columns), max_rows)
        {
            return El::Raw(lines);
        }
    }
    let style = if drawable {
        Style::new().dim()
    } else {
        Style::default()
    };
    styled(format!("[image: {alt}]"), style)
}

fn message_row(
    agent_name: &str,
    me: Option<&Viewer>,
    entry: &ChatEntry,
    expanded: bool,
    screen: &Screen<'_>,
) -> El {
    let message = &entry.message;
    let is_user = message.role == Role::User;
    let is_agent = message.role == Role::Agent;
    let prefix_color = if is_user {
        Color::Cyan
    } else if is_agent {
        Color::Magenta
    } else {
        Color::Yellow
    };
    let label = if is_user {
        user_label(message, me)
    } else if is_agent {
        agent_name.to_string()
    } else {
        "SYSTEM".into()
    };
    let summary = if is_agent {
        tool_call_summary(&message.tool_calls)
    } else {
        None
    };
    let calls: Vec<Value> = if is_agent {
        is_tool_call_array(&message.tool_calls)
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let has_calls = !calls.is_empty();
    let shell_run = if is_user {
        parse_shell_record(&message.content)
    } else {
        None
    };

    let mut author = vec![styled(
        format!("▌ {label}"),
        Style::new().bold().fg(prefix_color),
    )];
    if message.triggered_by == "HEARTBEAT" {
        author.push(styled(" · heartbeat", Style::new().dim()));
    }
    if message.triggered_by == "CRON_TASK" {
        author.push(styled(" · cron", Style::new().dim()));
    }

    let mut body: Vec<El> = Vec::new();
    if let Some(run) = shell_run {
        body.push(styled(
            format!("{SHELL_PREFIX} {}", run.command),
            Style::new().bold(),
        ));
        if run.exit_code != 0 {
            body.push(styled(
                format!("exit code {}", run.exit_code),
                Style::new().fg(Color::Red),
            ));
        }
        if !run.output.is_empty() {
            body.push(styled(truncate(&run.output, 1600), Style::new().dim()));
        }
    } else if is_agent {
        body.extend(agent_body(message, screen));
    } else {
        body.push(styled(message.content.clone(), Style::default()));
    }
    if let Some(failed) = &entry.failed {
        body.push(styled(
            format!("✗ not sent: {failed}"),
            Style::new().fg(Color::Red),
        ));
    }
    if let Some(attachments) = message.attachments.as_ref().filter(|a| !a.is_empty()) {
        let files: Vec<String> = attachments
            .iter()
            .map(|a| {
                let size = if a.expired {
                    "expired".to_string()
                } else {
                    format_file_size(a.size_bytes)
                };
                format!("· 📎 {} ({size})", a.filename)
            })
            .collect();
        let suffix = if is_agent {
            "  · /save to download"
        } else {
            ""
        };
        body.push(styled(
            format!("{}{suffix}", files.join(" ")),
            Style::new().dim(),
        ));
    }
    if let Some(summary) = summary {
        let hint = match (has_calls, expanded) {
            (false, _) => "",
            (true, true) => "  · ctrl+o to collapse",
            (true, false) => "  · ctrl+o to expand",
        };
        body.push(styled(format!("{summary}{hint}"), Style::new().dim()));
    }
    if has_calls && expanded {
        let rows = calls
            .iter()
            .map(|c| {
                let success = c.get("success").is_some_and(|s| match s {
                    Value::Bool(b) => *b,
                    Value::Null => false,
                    Value::Number(n) => n.as_f64() != Some(0.0),
                    Value::String(s) => !s.is_empty(),
                    _ => true,
                });
                let tool = js_string(c.get("tool").unwrap_or(&Value::Null));
                let mark = if success { "✓" } else { "✗" };
                let color = if success { Color::Green } else { Color::Red };
                let cut = c.get("truncated").filter(|t| t.is_object()).map(|t| {
                    let kept = t.get("keptChars").map(js_string).unwrap_or_default();
                    let total = t.get("totalChars").map(js_string).unwrap_or_default();
                    format!(" (cut — {kept} of {total} chars)")
                });
                col(vec![
                    styled(format!("{mark} {tool}"), Style::new().bold().fg(color)),
                    styled("input", Style::new().dim()),
                    styled(
                        truncate(&js_string(c.get("input").unwrap_or(&Value::Null)), 1200),
                        Style::default(),
                    ),
                    styled(
                        format!("output{}", cut.unwrap_or_default()),
                        Style::new().dim(),
                    ),
                    styled(
                        truncate(&js_string(c.get("output").unwrap_or(&Value::Null)), 1600),
                        Style::default(),
                    ),
                ])
                .margin_bottom(1)
                .el()
            })
            .collect();
        body.push(col(rows).margin_top(1).pad_left(2).el());
    }

    col(vec![row(author).el(), col(body).pad_left(2).el()])
        .margin_bottom(1)
        .el()
}

pub struct MessageListProps<'a> {
    pub agent_name: &'a str,
    pub me: Option<&'a Viewer>,
    pub entries: &'a [ChatEntry],
    pub expanded_message_id: Option<&'a str>,
}

/// The conversation laid out at `width` columns.
pub fn message_list(p: MessageListProps<'_>, screen: &Screen<'_>, width: usize) -> El {
    let start = p.entries.len().saturating_sub(50);
    let rows = p.entries[start..]
        .iter()
        .map(|e| {
            let expanded = Some(e.message.id.as_str()) == p.expanded_message_id;
            // A row that places a picture changes when the picture arrives, so it is laid out every frame.
            let draws_images =
                screen.graphics.kitty && e.message.attachments.iter().flatten().any(|a| a.inline);
            if draws_images {
                return message_row(p.agent_name, p.me, e, expanded, screen);
            }
            let label = if e.message.role == Role::User {
                user_label(&e.message, p.me)
            } else {
                p.agent_name.to_string()
            };
            let key = RowKey {
                entry: e.clone(),
                expanded,
                width,
                label,
            };
            if let Some(lines) = screen.rows_cache.get(&key) {
                return El::Raw(lines.to_vec());
            }
            // Inside a column of its own, so the row's bottom margin is laid out with it.
            let lines = Rc::new(render(
                &col(vec![message_row(p.agent_name, p.me, e, expanded, screen)]).el(),
                width,
            ));
            screen.rows_cache.put(key, lines.clone());
            El::Raw(lines.to_vec())
        })
        .collect();
    col(rows).el()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summarises_tool_calls() {
        assert_eq!(
            tool_call_summary(&json!([{"tool":"shell_exec"},{"tool":"read"}])).as_deref(),
            Some("· used shell_exec, read")
        );
        assert_eq!(
            tool_call_summary(&json!([{}])).as_deref(),
            Some("· used 1 tool(s)")
        );
        assert_eq!(tool_call_summary(&json!([])), None);
    }

    #[test]
    fn truncates_long_output() {
        assert_eq!(truncate("abcdef", 4), "abcd\n… (truncated 2 more chars)");
    }

    #[test]
    fn agent_replies_reach_the_terminal_without_escape_sequences() {
        let (images, markdown, rows_cache) = (
            ImageStore::new(),
            MarkdownCache::default(),
            RowCache::default(),
        );
        let screen = Screen {
            columns: 80,
            rows: 24,
            graphics: TerminalGraphics::TEXT,
            images: &images,
            markdown: &markdown,
            rows_cache: &rows_cache,
        };
        let m = crate::protocol::coerce_message(&json!({
            "id": "1",
            "role": "AGENT",
            "content": "copied \x1b]52;c;aGk=\x07 and \x1b]0;title\x1b\\ here\x07\x1bc",
        }))
        .unwrap();
        let out: String = render(&col(agent_body(&m, &screen)).el(), 80)
            .iter()
            .map(Line::encoded)
            .collect();
        assert!(out.contains("copied") && out.contains("here"), "{out:?}");
        assert!(!out.contains("52;") && !out.contains("]0;") && !out.contains('\x07'));
        assert!(!out.contains("\x1bc"));
    }

    #[test]
    fn labels_other_authors() {
        let mut m = crate::protocol::coerce_message(
            &json!({"id":"1","content":"x","role":"USER","senderId":"u2","senderName":"Ada"}),
        )
        .unwrap();
        let me = Viewer {
            id: Some("u1".into()),
            name: None,
        };
        assert_eq!(user_label(&m, Some(&me)), "Ada");
        assert_eq!(user_label(&m, None), "You");
        m.triggered_by = "AGENT_MESSAGE".into();
        assert_eq!(user_label(&m, Some(&me)), "Ada · Agent");
    }
}
