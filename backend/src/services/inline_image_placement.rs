//! The images a reply places in its text become attachments of the message that
//! shows them. A reply names an image by a path in its workspace or by
//! `attachment:<id>`, and the stored message names each image it placed by the
//! attachment that holds it.
//!
//! A path is held to `share_file`'s bound: it must resolve inside the run's
//! workspace, and it is read through the filesystem that holds it. Placement runs
//! once the step's tool calls have finished, so no write of that step is still
//! pending. A file this turn already shared is placed as that attachment, not
//! stored a second time.

use std::collections::HashMap;

use serde_json::json;

use crate::lib::execution_environments::workspace::resolve_workspace;
use crate::lib::inline_images::{
    attachment_image, attachment_ref_id, find_image_refs, is_local_path, replace_image_refs,
};
use crate::lib::log_redaction::err_json;
use crate::lib::read_settled_file::read_settled_file;
use crate::services::attachment_service::{
    ATTACHMENT_SERVICE, AttachmentCategory, AttachmentSource, CreateAttachmentInput,
    classify_media_type, detect_media_type,
};
use crate::tools::shell::workspace::{basename, is_inside_workspace, resolve_path};
use crate::{log_error, log_info};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlacedImages {
    /// The text, with each image it places named by its attachment.
    pub content: String,
    /// The attachments the text places, in order of first reference.
    pub attachment_ids: Vec<String>,
    /// References that show no image.
    pub missed: usize,
}

pub struct PlacementContext<'a> {
    pub thread_id: &'a str,
    /// The run's workspace, which a relative path is read from.
    pub workspace_root: Option<&'a str>,
    /// Files this turn shared that no message holds yet.
    pub shared: &'a [String],
}

pub async fn place_inline_images(text: &str, context: &PlacementContext<'_>) -> PlacedImages {
    let refs = find_image_refs(text);
    if refs.is_empty() {
        return PlacedImages {
            content: text.to_string(),
            ..PlacedImages::default()
        };
    }

    let mut placed: HashMap<String, Option<String>> = HashMap::new();
    let mut attachment_ids: Vec<String> = Vec::new();
    for image in &refs {
        if placed.contains_key(&image.target) {
            continue;
        }
        let id = attachment_for(&image.target, context).await;
        if let Some(id) = &id
            && !attachment_ids.contains(id)
        {
            attachment_ids.push(id.clone());
        }
        placed.insert(image.target.clone(), id);
    }
    let shown = |target: &str| placed.get(target).cloned().flatten();
    PlacedImages {
        content: replace_image_refs(text, &refs, |image| {
            shown(&image.target).map(|id| attachment_image(&image.alt, &id))
        }),
        attachment_ids,
        missed: refs
            .iter()
            .filter(|image| shown(&image.target).is_none())
            .count(),
    }
}

/// A reply delivered outside a chat turn (a goal turn, a bound scheduled run):
/// its text with the images it places, and its attachments, the placed images
/// first. `workspace_root` is the one the run gave `invoke`, so a path means what
/// it meant to the run's shell. An image that cannot be stored keeps its reference
/// as written.
pub async fn place_reply_images(
    thread_id: &str,
    text: &str,
    attachment_ids: &[String],
    workspace_root: Option<&str>,
) -> (String, Vec<String>) {
    let placed = place_inline_images(
        text,
        &PlacementContext {
            thread_id,
            workspace_root,
            shared: attachment_ids,
        },
    )
    .await;
    let mut ids = placed.attachment_ids.clone();
    ids.extend(
        attachment_ids
            .iter()
            .filter(|id| !placed.attachment_ids.contains(id))
            .cloned(),
    );
    (placed.content, ids)
}

/// A failure to store one image leaves its reference as written, so the reply
/// still goes out.
async fn attachment_for(target: &str, context: &PlacementContext<'_>) -> Option<String> {
    let result = if let Some(id) = attachment_ref_id(target) {
        stored_image(id, context).await
    } else if is_local_path(target) {
        capture_image(target, context).await
    } else {
        Ok(None)
    };
    result.unwrap_or_else(|err| {
        log_error!(
            json!({ "err": err_json(&err) }),
            "[InlineImages] {} shows no image: storing it failed",
            target
        );
        None
    })
}

/// A stored image: one this turn shared, or one another message of this thread
/// holds, copied for this message. The thread bound keeps a reply from showing a
/// file from a conversation its readers are not in.
async fn stored_image(id: &str, context: &PlacementContext<'_>) -> anyhow::Result<Option<String>> {
    let Some(row) = ATTACHMENT_SERVICE.get_by_id(id).await? else {
        return Ok(None);
    };
    if classify_media_type(&row.media_type) != AttachmentCategory::Image {
        return Ok(None);
    }
    // A shared row a message already holds (a resumed turn's list can name one)
    // is copied like any other of this thread, so this message gets its own.
    if context.shared.iter().any(|shared| shared == id) && row.message_id.is_none() {
        return Ok(Some(id.to_string()));
    }
    if row.thread_id.as_deref() != Some(context.thread_id) {
        return Ok(None);
    }
    let Some(data) = ATTACHMENT_SERVICE.load_bytes(&row).await? else {
        return Ok(None);
    };
    let copy = ATTACHMENT_SERVICE
        .create(agent_image(
            row.filename.clone(),
            row.media_type.clone(),
            data,
        ))
        .await?;
    Ok(Some(copy.id))
}

/// Read an image in the workspace through the filesystem that holds its path, as
/// `share_file` does, so a path means what it means to the agent's shell.
async fn capture_image(
    target: &str,
    context: &PlacementContext<'_>,
) -> anyhow::Result<Option<String>> {
    let workspace = resolve_workspace(context.workspace_root);
    let full_path = resolve_path(&workspace, target);
    if !is_inside_workspace(&full_path, &workspace) {
        log_info!(
            "[InlineImages] {} shows no image: it is outside the workspace",
            target
        );
        return Ok(None);
    }
    let data = match read_settled_file(&full_path, target).await {
        Ok(data) => data,
        Err(error) => {
            log_info!("[InlineImages] {} shows no image: {}", target, error);
            return Ok(None);
        }
    };
    let filename = basename(&full_path).to_string();
    let media_type = detect_media_type(&data, &filename, None);
    if classify_media_type(&media_type) != AttachmentCategory::Image {
        log_info!(
            "[InlineImages] {} shows no image: it is {}",
            target,
            media_type
        );
        return Ok(None);
    }
    if let Some(shared) = shared_copy(&data, context.shared).await? {
        return Ok(Some(shared));
    }
    let row = ATTACHMENT_SERVICE
        .create(agent_image(filename, media_type, data))
        .await?;
    Ok(Some(row.id))
}

/// The file this turn shared, still unlinked, that holds these same bytes.
async fn shared_copy(data: &[u8], shared: &[String]) -> anyhow::Result<Option<String>> {
    for id in shared {
        let Some(row) = ATTACHMENT_SERVICE.get_by_id(id).await? else {
            continue;
        };
        if row.message_id.is_some() || row.size_bytes != data.len() as i64 {
            continue;
        }
        if classify_media_type(&row.media_type) != AttachmentCategory::Image {
            continue;
        }
        if ATTACHMENT_SERVICE.load_bytes(&row).await?.as_deref() == Some(data) {
            return Ok(Some(id.clone()));
        }
    }
    Ok(None)
}

/// An unlinked image the agent's reply places.
fn agent_image(filename: String, media_type: String, data: Vec<u8>) -> CreateAttachmentInput {
    CreateAttachmentInput {
        filename,
        media_type,
        size_bytes: data.len() as i64,
        data,
        category: AttachmentCategory::Image,
        source: AttachmentSource::Agent,
        thread_id: None,
        message_id: None,
        external_file_id: None,
        external_ts: None,
    }
}
