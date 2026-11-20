//! The agent's questions to a person, as a card on one of its messages: posting
//! it, taking the first answer, and closing it when the person replies in words.
//!
//! The card is stored on the message. Every lookup reads the first block, so a
//! card is the only block on its message.

use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use chrono::Utc;
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::db::models::{ConversationMessage, MessageTrigger};
use crate::db::schema::{conversation_messages, conversation_threads};
use crate::db::sql_types::DbJson;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::log_error;
use crate::protocol::chat_protocol::{
    QuestionCardAnswer, QuestionCardBlock, QuestionCardPerson, QuestionCardQuestion,
    QuestionCardStatus,
};
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::inbound_message_service::{
    INBOUND_MESSAGE_SERVICE, InboundMessage, InboundMessageError, InboundSender,
};
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};
use crate::services::pending_work_service::{PENDING_WORK_SERVICE, PendingWorkKind};

use super::question_card_schema::{MAX_OTHER_CHARS, parse_question_card};
use super::question_card_text::{answer_message_text, one_line, question_card_text};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QuestionCardCaller {
    pub agent_id: String,
    pub user_id: String,
    pub thread_id: String,
    pub origin_channel: Option<ChannelName>,
    pub origin_channel_id: Option<String>,
}

/// The `ask_questions` input once the schema parsed it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AskQuestionsInput {
    #[serde(default)]
    pub intro: Option<String>,
    pub questions: Vec<QuestionCardQuestion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnswerOutcome {
    Answered(QuestionCardBlock),
    /// The answers are stored and the next boot starts the turn, since the message could not be accepted.
    ReplyPending(QuestionCardBlock),
    Closed(QuestionCardBlock),
    Invalid(String),
    NotFound,
}

/// A card that a typed reply closed, shown to clients once the reply is committed.
#[derive(Debug, Clone)]
pub struct ClosedInChat {
    row: ConversationMessage,
    card: QuestionCardBlock,
}

/// The agent asked again while a card waits, or twice in one step.
#[derive(Debug, Clone, thiserror::Error)]
#[error(
    "A question card already waits in this conversation, so nothing new was sent. End this turn; the answers arrive as the user's next message."
)]
pub struct QuestionCardWaitingError;

fn first_block(blocks: Option<&Value>) -> Option<&Value> {
    blocks?.get(0)
}

/// Whether a row's first block is a card, of any shape.
fn is_card(blocks: Option<&Value>) -> bool {
    first_block(blocks)
        .and_then(|block| block.get("type"))
        .and_then(Value::as_str)
        == Some("question_card")
}

/// Whether a row's first block is a card that waits.
fn is_waiting(blocks: Option<&Value>) -> bool {
    is_card(blocks)
        && first_block(blocks)
            .and_then(|block| block.get("status"))
            .and_then(Value::as_str)
            == Some("waiting")
}

/// The stored card of a row, or `None` when the block is not a well-formed card.
fn card_of(row: &ConversationMessage) -> Option<QuestionCardBlock> {
    parse_question_card(first_block(row.blocks.as_ref())?)
}

fn blocks_of(card: &QuestionCardBlock) -> Value {
    json!([serde_json::to_value(card).expect("a card serializes")])
}

/// The answers as the card stores them, or why they do not fit the card.
fn fit_answers(
    card: &QuestionCardBlock,
    answers: &[QuestionCardAnswer],
) -> Result<Vec<QuestionCardAnswer>, &'static str> {
    if answers.len() != card.questions.len() {
        return Err("Send one answer per question.");
    }
    let mut fitted = Vec::new();
    for (question, answer) in card.questions.iter().zip(answers) {
        let options: Vec<u64> = answer
            .options
            .iter()
            .copied()
            .collect::<BTreeSet<u64>>()
            .into_iter()
            .collect();
        let other = answer
            .other
            .as_deref()
            .map(one_line)
            .filter(|other| !other.is_empty());
        if options
            .iter()
            .any(|&option| option >= question.options.len() as u64)
        {
            return Err("That option does not exist.");
        }
        if other.is_some() && !question.allow_other {
            return Err("That question takes no answer of your own.");
        }
        if !question.multi_select && options.len() + usize::from(other.is_some()) > 1 {
            return Err("That question takes one answer.");
        }
        fitted.push(QuestionCardAnswer { options, other });
    }
    if fitted
        .iter()
        .all(|answer| answer.options.is_empty() && answer.other.is_none())
    {
        return Err("Answer at least one question.");
    }
    Ok(fitted)
}

fn props(pairs: &[(&str, String)]) -> IndexMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

/// The props of `question card closed`, without the answers' counts.
fn closed_props(
    agent_id: &str,
    row: &ConversationMessage,
    card: &QuestionCardBlock,
) -> IndexMap<String, String> {
    props(&[
        ("agent.id", agent_id.to_string()),
        ("thread.id", row.thread_id.clone()),
        ("question_card.id", card.id.clone()),
        ("status", card.status.as_str().to_string()),
        ("questions", card.questions.len().to_string()),
        (
            "elapsed_ms",
            (Utc::now() - row.created_at).num_milliseconds().to_string(),
        ),
    ])
}

/// How many questions were answered, left blank and answered in the person's own words.
fn answer_counts(answers: &[QuestionCardAnswer]) -> IndexMap<String, String> {
    let answered = answers
        .iter()
        .filter(|answer| !answer.options.is_empty() || answer.other.is_some())
        .count();
    props(&[
        ("answered", answered.to_string()),
        ("blank", (answers.len() - answered).to_string()),
        (
            "other",
            answers
                .iter()
                .filter(|answer| answer.other.is_some())
                .count()
                .to_string(),
        ),
    ])
}

/// The rows of a thread whose card waits, oldest first.
fn waiting_rows(
    conn: &mut SqliteConnection,
    thread_id: &str,
) -> anyhow::Result<Vec<ConversationMessage>> {
    let rows: Vec<ConversationMessage> = conversation_messages::table
        .filter(conversation_messages::thread_id.eq(thread_id))
        .filter(conversation_messages::blocks.is_not_null())
        .order(conversation_messages::created_at.asc())
        .select(ConversationMessage::as_select())
        .load(conn)?;
    Ok(rows
        .into_iter()
        .filter(|row| is_waiting(row.blocks.as_ref()))
        .collect())
}

/// Replaces the row's card with `card` when the stored card still waits. Answers
/// whether it did.
fn replace_waiting(
    conn: &mut SqliteConnection,
    row_id: &str,
    card: &QuestionCardBlock,
) -> anyhow::Result<bool> {
    let current: Option<Option<Value>> = conversation_messages::table
        .find(row_id)
        .select(conversation_messages::blocks)
        .first(conn)
        .optional()?;
    if !is_waiting(current.flatten().as_ref()) {
        return Ok(false);
    }
    diesel::update(conversation_messages::table.find(row_id))
        .set(conversation_messages::blocks.eq(Some(DbJson(blocks_of(card)))))
        .execute(conn)?;
    Ok(true)
}

/// Releases a thread's post when the post ends, however it ends.
struct Posting<'a> {
    threads: &'a Mutex<HashSet<String>>,
    thread_id: String,
}

impl Drop for Posting<'_> {
    fn drop(&mut self) {
        self.threads.lock().remove(&self.thread_id);
    }
}

pub struct QuestionCardService {
    /// Threads with a post under way. Taken with the check, so two calls in one step cannot both pass it.
    posting: Mutex<HashSet<String>>,
}

impl QuestionCardService {
    pub fn new() -> Self {
        QuestionCardService {
            posting: Mutex::new(HashSet::new()),
        }
    }

    /// Posts the card. Fails with [`QuestionCardWaitingError`] while another waits in the thread.
    pub async fn post(
        &self,
        caller: &QuestionCardCaller,
        input: AskQuestionsInput,
    ) -> anyhow::Result<QuestionCardBlock> {
        let thread_id = caller.thread_id.clone();
        if !self.posting.lock().insert(thread_id.clone()) {
            return Err(self.post_refused(caller, "same_step").into());
        }
        let _posting = Posting {
            threads: &self.posting,
            thread_id: thread_id.clone(),
        };
        let thread = thread_id.clone();
        let waiting = crate::db::read(move |conn| waiting_rows(conn, &thread)).await?;
        if !waiting.is_empty() {
            return Err(self.post_refused(caller, "card_waiting").into());
        }
        let intro = input.intro.filter(|intro| !intro.is_empty());
        let card = QuestionCardBlock {
            id: uuid::Uuid::new_v4().to_string(),
            status: QuestionCardStatus::Waiting,
            intro: intro.clone(),
            questions: input.questions,
            other_max_length: MAX_OTHER_CHARS,
            answers: None,
            answered_by: None,
        };
        let channel_context = MESSAGE_DELIVERY_SERVICE
            .thread_context(
                &thread_id,
                caller.origin_channel.map(ChannelName::as_str),
                caller.origin_channel_id.as_deref(),
            )
            .await?
            .context;
        let channel = channel_context.channel;
        MESSAGE_DELIVERY_SERVICE
            .publish(
                &caller.user_id,
                &thread_id,
                &question_card_text(&card.questions, intro.as_deref()),
                MessageTrigger::UserInput,
                PublishOptions {
                    blocks: Some(vec![serde_json::to_value(&card)?]),
                    channel_context: Some(channel_context),
                    ..Default::default()
                },
            )
            .await?;
        track_event(
            "question card posted",
            Some(&caller.user_id),
            Some(posted_props(caller, &card, channel)),
        );
        Ok(card)
    }

    /// Stores the answers when the card still waits. One transaction updates the
    /// card and writes the `pending_work` row of the answer message, so a restart
    /// keeps the answers and only the first answer is stored.
    pub async fn answer(
        &self,
        agent_id: &str,
        user_id: &str,
        id: &str,
        answers: &[QuestionCardAnswer],
        sender: Option<QuestionCardPerson>,
    ) -> anyhow::Result<AnswerOutcome> {
        let Some((row, card)) = self.find(agent_id, user_id, id).await? else {
            return Ok(AnswerOutcome::NotFound);
        };
        if let Err(error) = INBOUND_MESSAGE_SERVICE
            .check_thread(&row.thread_id, agent_id)
            .await
        {
            if error.downcast_ref::<InboundMessageError>().is_some() {
                return Ok(AnswerOutcome::NotFound);
            }
            return Err(error);
        }
        if card.status != QuestionCardStatus::Waiting {
            return Ok(self.refuse(agent_id, user_id, &row.thread_id, card));
        }

        let fitted = match fit_answers(&card, answers) {
            Ok(fitted) => fitted,
            Err(error) => return Ok(AnswerOutcome::Invalid(error.to_string())),
        };

        let answered = QuestionCardBlock {
            status: QuestionCardStatus::Answered,
            answers: Some(fitted.clone()),
            answered_by: Some(sender.clone()),
            ..card.clone()
        };
        let message = InboundMessage {
            id: uuid::Uuid::new_v4().to_string(),
            thread_id: row.thread_id.clone(),
            content: answer_message_text(&card.questions, &fitted),
            attachment_ids: Vec::new(),
            sender: sender.map(|person| InboundSender {
                id: person.id,
                name: person.name,
            }),
            agent_message: None,
            // A later boot can store this message after the agent has posted a newer card.
            runtime_written: true,
            task_notification: None,
        };
        let payload = serde_json::to_value(INBOUND_MESSAGE_SERVICE.pending_work_for(&message))?;
        let (row_id, written) = (row.id.clone(), answered.clone());
        let won = PENDING_WORK_SERVICE
            .begin_with(PendingWorkKind::Chat, &message.id, payload, move |conn| {
                replace_waiting(conn, &row_id, &written)
            })
            .await?;
        if !won {
            let row_id = row.id.clone();
            let stored: Option<ConversationMessage> = crate::db::run(move |conn| {
                Ok(conversation_messages::table
                    .find(&row_id)
                    .select(ConversationMessage::as_select())
                    .first(conn)
                    .optional()?)
            })
            .await?;
            let current = stored.as_ref().and_then(card_of).unwrap_or(card);
            return Ok(self.refuse(agent_id, user_id, &row.thread_id, current));
        }

        let mut closed = closed_props(agent_id, &row, &answered);
        closed.extend(answer_counts(&fitted));
        track_event("question card closed", Some(user_id), Some(closed));
        self.show_card(agent_id, user_id, &row, &answered).await;
        // Boxed, since the accept future is large.
        if let Err(error) = Box::pin(INBOUND_MESSAGE_SERVICE.accept(message)).await {
            self.step_failed(
                "accept",
                &error,
                agent_id,
                user_id,
                &row.thread_id,
                &card.id,
            );
            return Ok(AnswerOutcome::ReplyPending(answered));
        }
        Ok(AnswerOutcome::Answered(answered))
    }

    /// A message the person typed closes the cards waiting in its conversation, in that message's transaction.
    pub fn close_waiting_in_chat(
        &self,
        conn: &mut SqliteConnection,
        thread_id: &str,
    ) -> anyhow::Result<Vec<ClosedInChat>> {
        let mut closed_cards = Vec::new();
        for row in waiting_rows(conn, thread_id)? {
            let Some(card) = card_of(&row) else {
                continue;
            };
            let closed = QuestionCardBlock {
                status: QuestionCardStatus::AnsweredInChat,
                ..card
            };
            if replace_waiting(conn, &row.id, &closed)? {
                closed_cards.push(ClosedInChat { row, card: closed });
            }
        }
        Ok(closed_cards)
    }

    pub async fn show_closed_in_chat(
        &self,
        agent_id: &str,
        user_id: &str,
        closed_cards: Vec<ClosedInChat>,
    ) {
        for ClosedInChat { row, card } in closed_cards {
            track_event(
                "question card closed",
                Some(user_id),
                Some(closed_props(agent_id, &row, &card)),
            );
            self.show_card(agent_id, user_id, &row, &card).await;
        }
    }

    /// The row whose card has this id, in the agent's conversations with the user, and its card.
    async fn find(
        &self,
        agent_id: &str,
        user_id: &str,
        id: &str,
    ) -> anyhow::Result<Option<(ConversationMessage, QuestionCardBlock)>> {
        let (agent_id, user_id) = (agent_id.to_string(), user_id.to_string());
        let rows: Vec<ConversationMessage> = crate::db::read(move |conn| {
            Ok(conversation_messages::table
                .inner_join(conversation_threads::table)
                .filter(conversation_threads::agent_id.eq(agent_id))
                .filter(conversation_threads::user_id.eq(user_id))
                .filter(conversation_messages::blocks.is_not_null())
                .select(ConversationMessage::as_select())
                .load(conn)?)
        })
        .await?;
        let Some(row) = rows.into_iter().find(|row| {
            is_card(row.blocks.as_ref())
                && first_block(row.blocks.as_ref())
                    .and_then(|block| block.get("id"))
                    .and_then(Value::as_str)
                    == Some(id)
        }) else {
            return Ok(None);
        };
        Ok(card_of(&row).map(|card| (row, card)))
    }

    /// Every open client shows the changed card. The stored card is already right, so a failure here stops nothing.
    async fn show_card(
        &self,
        agent_id: &str,
        user_id: &str,
        row: &ConversationMessage,
        card: &QuestionCardBlock,
    ) {
        let shown = ConversationMessage {
            blocks: Some(blocks_of(card)),
            ..row.clone()
        };
        if let Err(error) = MESSAGE_DELIVERY_SERVICE
            .show_in_conversation(user_id, &shown)
            .await
        {
            self.step_failed("show", &error, agent_id, user_id, &row.thread_id, &card.id);
        }
    }

    fn step_failed(
        &self,
        step: &str,
        error: &anyhow::Error,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        card_id: &str,
    ) {
        log_error!(
            json!({ "err": err_json(error), "cardId": card_id, "step": step }),
            "[QuestionCards] A step after the card closed failed"
        );
        track_event(
            "question card step failed",
            Some(user_id),
            Some(props(&[
                ("agent.id", agent_id.to_string()),
                ("thread.id", thread_id.to_string()),
                ("question_card.id", card_id.to_string()),
                ("step", step.to_string()),
            ])),
        );
    }

    fn post_refused(&self, caller: &QuestionCardCaller, reason: &str) -> QuestionCardWaitingError {
        track_event(
            "question card post refused",
            Some(&caller.user_id),
            Some(props(&[
                ("agent.id", caller.agent_id.clone()),
                ("thread.id", caller.thread_id.clone()),
                ("reason", reason.to_string()),
            ])),
        );
        QuestionCardWaitingError
    }

    fn refuse(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        card: QuestionCardBlock,
    ) -> AnswerOutcome {
        track_event(
            "question card answer refused",
            Some(user_id),
            Some(props(&[
                ("agent.id", agent_id.to_string()),
                ("thread.id", thread_id.to_string()),
                ("question_card.id", card.id.clone()),
                ("status", card.status.as_str().to_string()),
            ])),
        );
        AnswerOutcome::Closed(card)
    }
}

/// The props of `question card posted`.
fn posted_props(
    caller: &QuestionCardCaller,
    card: &QuestionCardBlock,
    channel: ChannelName,
) -> IndexMap<String, String> {
    let count = |keep: fn(&QuestionCardQuestion) -> bool| {
        card.questions
            .iter()
            .filter(|q| keep(q))
            .count()
            .to_string()
    };
    props(&[
        ("agent.id", caller.agent_id.clone()),
        ("thread.id", caller.thread_id.clone()),
        ("question_card.id", card.id.clone()),
        ("questions", card.questions.len().to_string()),
        ("multi_select", count(|q| q.multi_select)),
        ("with_recommended", count(|q| q.recommended.is_some())),
        ("channel", channel.as_str().to_string()),
    ])
}

impl Default for QuestionCardService {
    fn default() -> Self {
        Self::new()
    }
}

pub static QUESTION_CARD_SERVICE: LazyLock<QuestionCardService> =
    LazyLock::new(QuestionCardService::new);

#[cfg(test)]
#[path = "question_card_service_tests.rs"]
pub(crate) mod tests;
