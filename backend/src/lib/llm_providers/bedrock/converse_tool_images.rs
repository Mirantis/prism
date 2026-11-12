//! Moves each image in a tool result into a user message placed directly after it.
//!
//! Converse reads an image inside a `toolResult` from Claude and Nova models only,
//! and reads it from every model as a user content block. The SDK joins the `tool`
//! message and the `user` message after it into one Converse user turn, so the
//! image stays beside the result it belongs to. The rewrite depends on the message
//! alone, so the prompt prefix stays identical from turn to turn.

use async_trait::async_trait;

use crate::ai::{
    LanguageModelMiddleware, LanguageModelV3CallOptions, LanguageModelV3Message,
    LanguageModelV4Part, ToolResultContentPart, ToolResultOutput,
};

/// The text left in the tool result where an image was.
pub const MOVED_NOTE: &str = "The image from this result follows in the next message.";

/// The middleware: `transformParams` replaces the prompt with
/// `prompt.flatMap(move_tool_images)`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ConverseToolImages;

#[async_trait]
impl LanguageModelMiddleware for ConverseToolImages {
    async fn transform_params(
        &self,
        params: LanguageModelV3CallOptions,
    ) -> anyhow::Result<LanguageModelV3CallOptions> {
        let prompt = params
            .prompt
            .into_iter()
            .flat_map(move_tool_images)
            .collect();
        Ok(LanguageModelV3CallOptions { prompt, ..params })
    }
}

/// The middleware instance the Bedrock provider wraps every Converse model with.
pub const CONVERSE_TOOL_IMAGES: ConverseToolImages = ConverseToolImages;

/// One prompt message, with each image of its tool results moved out: the message
/// itself when it is not a `tool` message or holds no image, else the message with
/// each `image/*` file of a `content` result replaced by `MOVED_NOTE`, followed by
/// one user message that holds `Image from ${toolName}:` and the image for each
/// image moved.
pub fn move_tool_images(message: LanguageModelV3Message) -> Vec<LanguageModelV3Message> {
    let LanguageModelV3Message::Tool {
        content,
        provider_options,
    } = message
    else {
        return vec![message];
    };
    let mut images: Vec<LanguageModelV4Part> = Vec::new();
    let content: Vec<LanguageModelV4Part> = content
        .into_iter()
        .map(|part| {
            let LanguageModelV4Part::ToolResult {
                tool_call_id,
                tool_name,
                output: ToolResultOutput::Content { value },
                provider_options,
            } = part
            else {
                return part;
            };
            let value = value
                .into_iter()
                .map(|item| match item {
                    ToolResultContentPart::File {
                        data, media_type, ..
                    } if media_type.starts_with("image/") => {
                        images.push(LanguageModelV4Part::Text {
                            text: format!("Image from {tool_name}:"),
                            provider_options: None,
                        });
                        images.push(LanguageModelV4Part::File {
                            filename: None,
                            data,
                            media_type,
                            provider_options: None,
                        });
                        ToolResultContentPart::Text {
                            text: MOVED_NOTE.to_string(),
                            provider_options: None,
                        }
                    }
                    other => other,
                })
                .collect();
            LanguageModelV4Part::ToolResult {
                tool_call_id,
                tool_name,
                output: ToolResultOutput::Content { value },
                provider_options,
            }
        })
        .collect();
    let message = LanguageModelV3Message::Tool {
        content,
        provider_options,
    };
    if images.is_empty() {
        return vec![message];
    }
    vec![
        message,
        LanguageModelV3Message::User {
            content: images,
            provider_options: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn screen_result() -> LanguageModelV3Message {
        serde_json::from_value(json!({
            "role": "tool",
            "content": [{
                "type": "tool-result",
                "toolCallId": "call-1",
                "toolName": "computer_screen",
                "output": {
                    "type": "content",
                    "value": [
                        { "type": "text", "text": "{\"success\":true,\"title\":\"Example\"}" },
                        { "type": "file", "mediaType": "image/jpeg", "data": { "type": "data", "data": "ZmFrZSBqcGVnIGJ5dGVz" } }
                    ]
                }
            }]
        }))
        .unwrap()
    }

    #[test]
    fn moves_a_tool_result_image_into_the_user_message_after_it() {
        let moved = move_tool_images(screen_result());
        assert_eq!(
            serde_json::to_value(&moved).unwrap(),
            json!([
                {
                    "role": "tool",
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": "call-1",
                        "toolName": "computer_screen",
                        "output": {
                            "type": "content",
                            "value": [
                                { "type": "text", "text": "{\"success\":true,\"title\":\"Example\"}" },
                                { "type": "text", "text": "The image from this result follows in the next message." }
                            ]
                        }
                    }]
                },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "Image from computer_screen:" },
                        { "type": "file", "data": { "type": "data", "data": "ZmFrZSBqcGVnIGJ5dGVz" }, "mediaType": "image/jpeg" }
                    ]
                }
            ])
        );
    }

    #[test]
    fn leaves_a_message_without_images_alone() {
        let message: LanguageModelV3Message = serde_json::from_value(json!({
            "role": "tool",
            "content": [{
                "type": "tool-result",
                "toolCallId": "c",
                "toolName": "t",
                "output": { "type": "content", "value": [
                    { "type": "file", "mediaType": "application/pdf", "data": { "type": "data", "data": "AA==" } }
                ] }
            }]
        }))
        .unwrap();
        assert_eq!(move_tool_images(message.clone()), vec![message]);
        let user: LanguageModelV3Message = serde_json::from_value(json!({
            "role": "user", "content": [{ "type": "text", "text": "hi" }]
        }))
        .unwrap();
        assert_eq!(move_tool_images(user.clone()), vec![user]);
    }
}
