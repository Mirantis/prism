//! Converting between ACP content and Prism messages: a prompt as the text and
//! files of one message, and a stored message as the session updates that show it.

use base64::Engine;
use serde_json::{Value, json};

use crate::protocol::{Role, TuiMessage};

pub struct PromptImage {
    pub data: Vec<u8>,
    pub filename: String,
}

pub struct PromptContent {
    pub text: String,
    pub images: Vec<PromptImage>,
}

/// Base64 read as Node's `Buffer.from(data, 'base64')` reads it: the standard and
/// the URL-safe alphabet, with or without padding, line breaks and other
/// characters outside the alphabet skipped.
fn decode_base64(data: &str) -> Vec<u8> {
    let mut clean: String = data
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            '-' => Some('+'),
            '_' => Some('/'),
            c if c.is_ascii_alphanumeric() || c == '+' || c == '/' => Some(c),
            _ => None,
        })
        .collect();
    // A last group of one character holds no whole byte.
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(clean)
        .unwrap_or_default()
}

/// The blocks in order, as one text. A linked file becomes its path, which the
/// agent reads with its own tools, and an image becomes a file to upload.
pub fn prompt_content(blocks: &[Value]) -> PromptContent {
    let mut images = Vec::new();
    let mut text = String::new();
    let mut after_link = false;
    for block in blocks {
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if kind == "image" {
            let mime = block
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let subtype = &mime[mime.find('/').map(|i| i + 1).unwrap_or(0)..];
            let data = block
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            images.push(PromptImage {
                data: decode_base64(data),
                filename: format!("image.{subtype}"),
            });
        }
        if kind != "text" && kind != "resource_link" {
            continue;
        }
        let is_link = kind == "resource_link";
        let part = if is_link {
            link_text(block.get("uri").and_then(Value::as_str).unwrap_or_default())
        } else {
            block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        // A link is a word of its own: a client can send two in a row, or one right after a text.
        let touching = !text.is_empty()
            && !part.is_empty()
            && !text.ends_with(char::is_whitespace)
            && !part.starts_with(char::is_whitespace);
        if touching && (is_link || after_link) {
            text.push(' ');
        }
        text.push_str(&part);
        after_link = is_link;
    }
    PromptContent { text, images }
}

/// A file link as its path and fragment. Any other link as it is.
fn link_text(uri: &str) -> String {
    if !uri.starts_with("file:") {
        return uri.to_string();
    }
    let Ok(url) = url::Url::parse(uri) else {
        return uri.to_string();
    };
    let path = url
        .to_file_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| url.path().to_string());
    match url.fragment() {
        Some(f) => format!("{path}#{f}"),
        None => path,
    }
}

/// A message's tool calls, which ran before its text, then the text, then a link
/// to each file the message holds.
pub fn message_updates(
    message: &TuiMessage,
    attachment_url: impl Fn(&str) -> String,
) -> Vec<Value> {
    let mut updates = Vec::new();
    if let Some(calls) = message.tool_calls.as_array() {
        for (index, call) in calls.iter().enumerate() {
            let input = call
                .get("input")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let raw_input = serde_json::from_str::<Value>(input)
                .unwrap_or_else(|_| Value::String(input.into()));
            let success = call
                .get("success")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            updates.push(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": format!("{}:{index}", message.id),
                "title": call.get("tool").cloned().unwrap_or(Value::Null),
                "status": if success { "completed" } else { "failed" },
                "rawInput": raw_input,
                "content": [{ "type": "content", "content": { "type": "text", "text": call.get("output").cloned().unwrap_or(Value::Null) } }],
            }));
        }
    }
    let kind = if message.role == Role::User {
        "user_message_chunk"
    } else {
        "agent_message_chunk"
    };
    let mut contents = Vec::new();
    if !message.content.is_empty() {
        contents.push(json!({ "type": "text", "text": message.content }));
    }
    // The runtime deletes a file's bytes after its retention time, and its link would then fail.
    for file in message.attachments.iter().flatten().filter(|f| !f.expired) {
        contents.push(json!({
            "type": "resource_link",
            "uri": attachment_url(&file.id),
            "name": file.filename,
            "mimeType": file.media_type,
            "size": file.size_bytes,
        }));
    }
    for content in contents {
        updates.push(json!({ "sessionUpdate": kind, "messageId": message.id, "content": content }));
    }
    updates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_text_and_links() {
        let blocks = vec![
            json!({"type":"text","text":"look at"}),
            json!({"type":"resource_link","uri":"file:///tmp/a.rs#L3"}),
            json!({"type":"resource_link","uri":"https://x.example"}),
        ];
        assert_eq!(
            prompt_content(&blocks).text,
            "look at /tmp/a.rs#L3 https://x.example"
        );
    }

    #[test]
    fn decodes_base64_as_node_does() {
        let bytes = b"\xfb\xff\x00hi";
        for data in ["+/8AaGk=", "+/8AaGk", "-_8AaGk", "+/8A\naGk="] {
            assert_eq!(decode_base64(data), bytes, "{data}");
        }
    }

    #[test]
    fn an_image_becomes_a_file() {
        let blocks = vec![json!({"type":"image","mimeType":"image/png","data":"aGk="})];
        let content = prompt_content(&blocks);
        assert_eq!(content.images[0].filename, "image.png");
        assert_eq!(content.images[0].data, b"hi");
    }

    #[test]
    fn shows_tool_calls_before_the_text() {
        let m = crate::protocol::coerce_message(&json!({
            "id":"m","content":"done","role":"AGENT",
            "toolCalls":[{"tool":"shell_exec","input":"{\"command\":\"pwd\"}","output":"/tmp","success":true}]
        }))
        .unwrap();
        let updates = message_updates(&m, |id| format!("u/{id}"));
        assert_eq!(updates[0]["sessionUpdate"], "tool_call");
        assert_eq!(updates[0]["rawInput"]["command"], "pwd");
        assert_eq!(updates[1]["content"]["text"], "done");
    }
}
