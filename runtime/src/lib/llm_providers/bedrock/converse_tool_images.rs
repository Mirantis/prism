//! Moves each image in a tool result into a user message placed directly after it.
//!
//! Converse reads an image inside a `toolResult` from Claude and Nova models only,
//! and reads it from every model as a user content block. The SDK joins the `tool`
//! message and the `user` message after it into one Converse user turn, so the
//! image stays beside the result it belongs to. The rewrite depends on the message
//! alone, so the prompt prefix stays identical from turn to turn.

use async_trait::async_trait;

use crate::ai::{LanguageModelMiddleware, LanguageModelV3CallOptions, LanguageModelV3Message};

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
        todo!()
    }
}

/// The middleware instance the Bedrock provider wraps every Converse model with.
pub const CONVERSE_TOOL_IMAGES: ConverseToolImages = ConverseToolImages;

/// One prompt message, with each image of its tool results moved out: the message
/// itself when it is not a `tool` message or holds no image, else the message with
/// each `image/*` file of a `content` result replaced by `MOVED_NOTE`, followed by
/// a user message holding `Image from ${toolName}:` and the image, per image.
pub fn move_tool_images(message: LanguageModelV3Message) -> Vec<LanguageModelV3Message> {
    todo!()
}
