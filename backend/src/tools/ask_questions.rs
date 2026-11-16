//! `ask_questions`: the agent asks the person one or more questions as a card
//! with answer options. Chat only, since a person is there to answer. Every
//! string here is static, because the tools block has to stay byte-identical.

use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool};
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::question_cards::question_card_schema::{
    ASK_QUESTIONS_TOOL_NAME, ask_questions_input_schema,
};
use crate::services::question_cards::question_card_service::{
    AskQuestionsInput, QUESTION_CARD_SERVICE, QuestionCardCaller,
};

pub const ASK_QUESTIONS_DESCRIPTION: &str = "Ask the user one or more questions as a card with answer options they can click. Use it when you need their decisions before you can go on, above all when there are several: put every question in one call, in the order they should answer them. Give each question 2 to 4 options, and name one as recommended when you have a view. The user can always leave a question blank or, unless allowOther is false, write their own answer. Do not write the questions in your reply as well. Put any lead-in in intro, and write no other text in this reply. For a single open question with no natural options, ask in plain text instead. Call it once, then end your turn and write nothing else. The answers arrive as the user's next message, one line per question; a blank question reads \"no answer\".";

/// What the tool answers once the card is posted.
pub fn ask_questions_result() -> Value {
    json!({
        "success": true,
        "message": "The questions are posted. End this turn now and write nothing else. The answers arrive as the user's next message."
    })
}

/// Empty without a conversation to post in.
pub fn get_ask_questions_tools(
    user_id: &str,
    agent_id: &str,
    thread_id: Option<&str>,
    origin_channel: ChannelName,
    origin_channel_id: Option<&str>,
) -> ToolSet {
    let mut tools = ToolSet::new();
    let Some(thread_id) = thread_id else {
        return tools;
    };
    let caller = QuestionCardCaller {
        agent_id: agent_id.to_string(),
        user_id: user_id.to_string(),
        thread_id: thread_id.to_string(),
        origin_channel: Some(origin_channel),
        origin_channel_id: origin_channel_id.map(str::to_string),
    };
    tools.insert(
        ASK_QUESTIONS_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(ASK_QUESTIONS_DESCRIPTION.to_string()),
            input_schema: ask_questions_input_schema(),
            execute: Some(execute_fn(move |input, _| {
                let caller = caller.clone();
                async move {
                    let input: AskQuestionsInput = serde_json::from_value(input)?;
                    QUESTION_CARD_SERVICE.post(&caller, input).await?;
                    Ok(ask_questions_result())
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
        get_ask_questions_tools(
            "user",
            "agent",
            Some("thread"),
            ChannelName::Websocket,
            None,
        )
    }

    #[test]
    fn the_definition_matches_the_typescript_runtime() {
        crate::tools::schema_fixture::assert_matches_fixture("ask-questions", &tools());
    }

    #[test]
    fn is_not_offered_without_a_conversation_to_post_in() {
        assert!(
            get_ask_questions_tools("user", "agent", None, ChannelName::Websocket, None).is_empty()
        );
    }

    #[test]
    fn names_a_declared_field_for_the_lead_in() {
        let description = tools()[ASK_QUESTIONS_TOOL_NAME]
            .description
            .clone()
            .unwrap();
        let field = description
            .split("Put any lead-in in ")
            .nth(1)
            .and_then(|rest| rest.split(|c: char| !c.is_alphanumeric()).next())
            .unwrap();
        let schema = tools()[ASK_QUESTIONS_TOOL_NAME]
            .input_schema
            .json_schema()
            .clone();
        assert!(schema["properties"].get(field).is_some());
        let parsed = tools()[ASK_QUESTIONS_TOOL_NAME]
            .input_schema
            .validate(&json!({ field: "  A few decisions.  ", "questions": [{ "text": "Which one?", "options": [{ "label": "A" }, { "label": "B" }] }] }))
            .unwrap();
        let input: AskQuestionsInput = serde_json::from_value(parsed).unwrap();
        assert_eq!(input.intro.as_deref(), Some("A few decisions."));
    }

    #[test]
    fn tells_the_agent_to_end_the_turn() {
        assert!(
            ask_questions_result()["message"]
                .as_str()
                .unwrap()
                .contains("End this turn")
        );
    }
}
