//! `show_ui` and `ui_reference`: the agent shows the person components from a
//! fixed catalog, as a message of its own. Chat only, since a person is there to
//! see it. Every string here is static, because the tools block has to stay
//! byte-identical.
//!
//! `show_ui` only checks the spec. The engine posts the UI once the step that
//! called it is recorded, so it shows after that step's text.

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, json_schema_with_validator, tool};
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::generated_ui::generated_ui_reference::UI_REFERENCE;
use crate::services::generated_ui::generated_ui_schema::{
    ParsedSpec, SHOW_UI_TOOL_NAME, UI_REFERENCE_TOOL_NAME, image_attachment_ids,
    show_ui_input_schema,
};
use crate::services::generated_ui::generated_ui_service::{
    GENERATED_UI_SERVICE, GeneratedUiCaller, GeneratedUiInvalid,
};

pub const SHOW_UI_DESCRIPTION: &str = "Show the user a UI built from fixed components: charts, tables, label and value fields, comparisons, checklists, images, notes and buttons. Use it when a component shows the answer better than prose: a comparison, numbers over time, a status summary, or a choice between a few options. Answer a simple question in plain text instead. Call ui_reference once before your first show_ui call to read the components, their props and their limits. Pass the elements as a flat map by id, and the id of the root element. The UI shows as its own message after the text you wrote before the call, so do not repeat its content in your reply. When the UI does not fit the rules, the call fails with the issues to fix; correct the spec and call again. The first press of a Button arrives as the user's next message, with the button's label as its text.";

pub const UI_REFERENCE_DESCRIPTION: &str = "Read the components show_ui accepts: each type, its props, its children and its limits, with an example. Call it once before your first show_ui call.";

/// What `show_ui` answers once the UI passed every check.
pub fn show_ui_result() -> Value {
    json!({
        "success": true,
        "message": "The UI is shown. Do not repeat its content in your reply."
    })
}

/// Takes the spec's images for its UI. An image belongs to the one message that
/// shows it, so a second UI of the turn that names it is refused.
fn claim_images(
    claimed: &Mutex<HashSet<String>>,
    spec: &ParsedSpec,
) -> Result<(), GeneratedUiInvalid> {
    let ids = image_attachment_ids(&spec.elements);
    let mut claimed = claimed.lock();
    let issues: Vec<String> = ids
        .iter()
        .filter(|id| claimed.contains(*id))
        .map(|id| {
            format!(
                "attachment:{id}: is already in another UI of this turn; share the file again with share_file to show it twice"
            )
        })
        .collect();
    if !issues.is_empty() {
        return Err(GeneratedUiInvalid { issues });
    }
    claimed.extend(ids);
    Ok(())
}

/// Empty without a conversation to show the UI in.
pub fn get_show_ui_tools(
    user_id: &str,
    agent_id: &str,
    thread_id: Option<&str>,
    origin_channel: ChannelName,
) -> ToolSet {
    let mut tools = ToolSet::new();
    let Some(thread_id) = thread_id else {
        return tools;
    };
    let caller = GeneratedUiCaller {
        agent_id: agent_id.to_string(),
        user_id: user_id.to_string(),
        thread_id: thread_id.to_string(),
        origin_channel,
    };
    tools.insert(
        UI_REFERENCE_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(UI_REFERENCE_DESCRIPTION.to_string()),
            input_schema: json_schema_with_validator(
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                std::sync::Arc::new(|value| Ok(value.clone())),
            ),
            execute: Some(execute_fn(|_, _| async {
                Ok(Value::String(UI_REFERENCE.to_string()))
            })),
            ..Default::default()
        }),
    );
    let claimed: Arc<Mutex<HashSet<String>>> = Arc::default();
    tools.insert(
        SHOW_UI_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(SHOW_UI_DESCRIPTION.to_string()),
            input_schema: show_ui_input_schema(),
            execute: Some(execute_fn(move |input, _| {
                let caller = caller.clone();
                let claimed = Arc::clone(&claimed);
                async move {
                    let spec = GENERATED_UI_SERVICE.check(&caller, &input).await?;
                    claim_images(&claimed, &spec)?;
                    Ok(show_ui_result())
                }
            })),
            ..Default::default()
        }),
    );
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools() -> ToolSet {
        get_show_ui_tools("user", "agent", Some("thread"), ChannelName::Websocket)
    }

    #[test]
    fn the_definitions_match_the_fixture() {
        crate::tools::schema_fixture::assert_matches_fixture("generated-ui", &tools());
    }

    #[test]
    fn is_not_offered_without_a_conversation() {
        assert!(get_show_ui_tools("user", "agent", None, ChannelName::Websocket).is_empty());
    }

    fn image_ui(attachment: &str) -> ParsedSpec {
        crate::services::generated_ui::generated_ui_schema::parse_spec(&json!({
            "root": "img",
            "elements": { "img": { "type": "Image", "props": { "attachment": format!("attachment:{attachment}"), "alt": "A graph" } } }
        }))
        .unwrap()
    }

    #[test]
    fn a_second_ui_of_the_turn_cannot_show_an_image_the_first_shows() {
        let claimed = Mutex::default();
        let first = "6b0d6a4e-2f1c-4d8e-9c55-1e2f3a4b5c6d";
        assert!(claim_images(&claimed, &image_ui(first)).is_ok());
        let refused = claim_images(&claimed, &image_ui(first)).unwrap_err();
        assert_eq!(refused.issues.len(), 1);
        assert!(refused.issues[0].starts_with(&format!("attachment:{first}: ")));
        assert!(claim_images(&claimed, &image_ui("0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f")).is_ok());
    }

    #[tokio::test]
    async fn the_reference_tool_returns_the_reference() {
        let execute = tools()[UI_REFERENCE_TOOL_NAME].execute.clone().unwrap();
        let reference = execute(json!({}), crate::ai::ToolExecutionOptions::default())
            .await
            .unwrap();
        assert_eq!(reference, Value::String(UI_REFERENCE.to_string()));
    }
}
