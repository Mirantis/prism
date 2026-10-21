/**
 * The tags of the message an agent-mode webhook run receives: the operator's
 * prompt, and the event's data inside it. The renderer writes them and the
 * Webhook Mode section names them, so both read them from here.
 */
export const WEBHOOK_PROMPT_TAG = 'subscription_prompt';
export const WEBHOOK_EVENT_DATA_TAG = 'event_data';
