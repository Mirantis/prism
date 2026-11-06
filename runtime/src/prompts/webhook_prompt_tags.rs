//! The tags of the message an agent-mode webhook run receives: the operator's
//! prompt, and the event's data inside it.

pub const WEBHOOK_PROMPT_TAG: &str = "subscription_prompt";
pub const WEBHOOK_EVENT_DATA_TAG: &str = "event_data";
