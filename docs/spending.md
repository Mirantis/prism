# Spending

The runtime estimates what the agent spends on models: its own model, the coding
agent's model and the voice models. Read the estimate per day, week or month, per
conversation, and per message you sent. It works with nothing configured.

The estimate is token counts times the model's list price from
[models.dev](https://models.dev). Your bill can differ: it can include discounts,
a gateway's markup or tax. A coding agent that runs on a Claude, ChatGPT, or
Google account subscription costs nothing here, since the subscription is not
billed per token.

## Read it

Open **Spending** in the [Web UI](web-ui.md#spending). The runtime also serves the
estimate over HTTP, on the same address and with the same sign-in as the Web UI.
All amounts are in US dollars.

| Request | Answers |
|---------|---------|
| `GET /agents/spending?from=&to=` | Totals for a time range, the last 30 days by default, split by model kind (`main`, `coding-agent`, `voice`), by category, by model and by purpose. |
| `GET /agents/spending/periods?period=day&count=30&timezone=` | One total per `day`, `week` (from Monday) or `month`, the current one last. Periods follow the agent's time zone unless `timezone` names another. |
| `GET /agents/spending/threads?from=&to=&limit=&offset=` | Conversations ranked by spend. |
| `GET /agents/spending/threads/:threadId` | One conversation, with one entry per message you sent in it. |
| `GET /agents/spending/requests/:requestId` | One message's spend. The id is the message id. |
| `GET /agents/spending/sources?category=&from=&to=` | One category (`scheduled-tasks`, `webhooks` or `goals`) per task, webhook or goal. |

A heartbeat run, a scheduled task, a webhook run, a goal and a voice call each
count as a request of their own.

## When a total is incomplete

`unpricedCalls` counts the model calls that have no price. Those calls add nothing
to `costUsd`, so the total is a lower bound. A call has no price when:

- its model is a name only your setup knows, such as a LiteLLM alias or an Azure
  deployment name;
- it is a transcription billed by the minute;
- its model is newer than the price list the runtime has.

The prices shipped with the release apply by default. Set `MODELS_DEV_URL` (see
[Context-window size](configuration.md#context-window-size)) to fetch models.dev at
startup and once a day; the runtime then prices the earlier calls of a model as
soon as a price for it arrives.
