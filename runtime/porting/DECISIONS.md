# Decisions for phase 2

Cross-cutting answers to questions phase 1 raised. They bind every engineer.

## HTTP clients

- Node's global `fetch` (which the AI SDK providers, MCP clients and most code use)
  ignores proxy environment variables. Build every `reqwest::Client` with
  `.no_proxy()`, except the clients whose TypeScript passes `getProxyDispatcher()`
  (model catalog, Slack, Teams, the Realtime socket), which use `HTTPS_PROXY` /
  `https_proxy` exactly as `lib/proxy_dispatcher.rs` does.
- Share clients: one `reqwest::Client` per purpose in a `LazyLock`, not one per call.

## HTTP server (Express compatibility)

Engineer `routes` writes `crate::support::http` first and publishes it early; every
route and listener (Teams, webhooks, agent messages) uses it:

- `json(status, value)`: `Content-Type: application/json; charset=utf-8`, as
  `res.json` sends.
- An Express-5-style JSON body: parsed when the content type is JSON (with the
  route's limit); `None` (TypeScript `undefined`) when there is no JSON content
  type; an unparseable body answers Express's 400 page (`Bad Request`, HTML), an
  over-limit body Express's 413 page.
- Query parsing as Express 5's `simple` parser (`node:querystring`): a repeated key
  is an array, so handlers that check `typeof x === 'string'` keep their logic.
- An error escaping a handler answers Express's 500 page (`Internal Server Error`).
- An unmatched route answers Express's 404 page (`Cannot GET /path`).
- Non-strict routing: a trailing slash matches the route without it (wrap the
  router in `tower_http::normalize_path::NormalizePathLayer::trim_trailing_slash`).
  Express's case-insensitive matching is not reproduced.
- Routes register full paths (`/agents/...`), and `server.rs` merges routers in
  `server.ts` order. Where Express falls through from a literal route to a
  parameter route on a method mismatch, keep that behavior.

## Config

- `CONFIG` is the one name for the configuration (`crate::config::CONFIG`);
  `config()` stays as an alias. Fields set after boot use their getters/setters
  (`agent_id()`, `owner_user_id()`, `coding_agent()`, `available_coding_agents()`).
- `crate::config::ModelSelectionMode` is the one mode enum; `lib::model_selection`
  re-exports it, and `agent_workspace_service::ModelModeName` is replaced by it.
- `is_sea()` is true for a release build with `PRISM_VERSION` set at compile time.

## Errors the model reads

A tool error's text uses the error's `name` from the `log_redaction` field registry.
Every runtime error type whose TypeScript class sets `name` (e.g. `ToolRiskGateError`)
registers it with `crate::lib::log_redaction::register_error_fields`, or the model
reads `Error: …` instead of `ToolRiskGateError: …`.

## Tool schemas

Tools whose TypeScript schema is zod use `crate::ai::zod_schema(json)`: it validates,
strips unknown keys, fills defaults and orders keys as zod does, which the stored
and replayed tool inputs depend on. Plain `jsonSchema()` tools use
`crate::ai::json_schema(json)`. The JSON itself comes from
`runtime/tests/fixtures/tool-schemas.json` (see FILL.md).

## Object identity

Tool outputs are `serde_json::Value`, so TypeScript that keys on an output object's
identity (the `WeakMap` in `tools/computer.ts`, `isSpilledToolOutput` in `invoke.ts`)
keeps that state another way: a marker the runtime controls (for example a side
table keyed by tool call id). Keep what the model sees identical.

## Smaller points

- `types::SteeringSource` returns `anyhow::Result`; a failed read is logged as the
  TypeScript does and treated as no steering messages.
- `subscription::subscription_forced_in` takes `&ProcessEnv`.
- `INBOUND_MESSAGE_SERVICE` subscribes to the event stream in `new()`; boot forces it
  (`LazyLock::force`) where TypeScript imported it.
- The database migrator turns foreign keys off around each migration, as the Prisma
  CLI does. This is a deliberate fix: the TypeScript SEA migrator ran rebuilds with
  foreign keys on, which cascade-deleted rows.
- Boot calls `crate::db::run_sync(|c| crate::db::migrate(c))` before anything reads
  the database (the Docker image's `prisma migrate deploy` step is replaced by it).
- JavaScript `trim` is `crate::support::js::trim` wherever the trimmed text is output
  or compared.
- Rename the mechanical config fields `nexus_open_ai_base_url`,
  `nexus_open_router_base_url`, `nexus_lite_llm_base_url` to `nexus_openai_base_url`,
  `nexus_openrouter_base_url`, `nexus_litellm_base_url` (engineer `prov-openai` and
  `prov-anthropic` fix their callers; `config.rs` owner: `prov-anthropic`).
