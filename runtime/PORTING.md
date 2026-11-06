# Porting the runtime from TypeScript to Rust

This file is the working agreement for everyone porting `src/` (TypeScript) to
`runtime/src/` (Rust). It is removed before the pull request. Read all of it before
you write code.

## Goal

The Rust runtime replaces the TypeScript runtime with **no change in behavior**. The
web SPA (`web/`), the TUI (`cli/`), the E2E suites (`e2e/`) and every deployment keep
working unchanged against the Rust binary. "Behavior" includes:

- Every HTTP route, status code, JSON field name and JSON shape.
- The WebSocket protocol (`src/protocol/chat-protocol.ts`, `docs/websocket-protocol.md`,
  the recorded session in `src/protocol/fixtures/v2-session.json`).
- Every prompt string, tool name, tool description, tool input schema and the order
  of tools and messages sent to a model. These must be **byte-identical**, because the
  provider prompt cache and the E2E LLM cache key on the exact bytes.
- Every log message text and level, telemetry event name and its props.
- Database layout: the Rust runtime reads and writes the same SQLite file the
  TypeScript runtime does, through the migrations in `prisma/sqlite/migrations/`.
- Timing constants, retry counts, limits, ordering of side effects.

Port faithfully. Do not add features, do not "improve" behavior, do not drop code paths.
If you find a bug in the TypeScript, port it as it is and name it in your final report.

## Where things go

`runtime/porting/mapping.json` maps each TypeScript file to its Rust file and module
path. The rules:

- Directory and file names: kebab-case and dots become snake_case
  (`services/heartbeat.service.ts` → `services/heartbeat_service.rs`).
- A directory's `index.ts` becomes that directory's `mod.rs`.
- `src/index.ts` (the entry point) is `crate::index`; `main.rs` calls `index::main()`.
- `src/lib/` is `crate::lib` (the crate root is `src/crate_root.rs`, so `lib` is free).
- Module declarations live between `// @generated-modules-start` and
  `// @generated-modules-end` in each `mod.rs` and in `crate_root.rs`. Add your own
  `pub mod x;` lines **outside** that block if you add a file.

Modules that have no TypeScript file of their own:

| Module | What it is |
|--------|-----------|
| `crate::support` | Node and JavaScript semantics: `now_ms`, `iso` (toISOString), `parse_iso`, `serde_iso`, `js::len16`/`slice16` (UTF-16 lengths), `js::number` (JSON number text), `js::parse_int`. |
| `crate::db` | The Prisma replacement: Diesel schema, model structs, enums, pool, the Prisma-compatible migrator. |
| `crate::ai` | The subset of the Vercel AI SDK the runtime uses: messages, tools, `generate_text`, `generate_object`, `embed`, the provider interface (LanguageModelV3) and the providers. |
| `crate::logger` | pino-compatible logging (already written). |

## Naming

- Types, structs, enums, traits keep their TypeScript names (`InvokeRequest`,
  `ChannelAdapter`, `ConversationThread`).
- Functions, methods, fields, locals: snake_case of the TypeScript name
  (`buildConversationHistory` → `build_conversation_history`).
- Constants keep SCREAMING_SNAKE_CASE (`STEP_LIMIT`). A camelCase exported `const`
  holding a fixed value becomes SCREAMING_SNAKE_CASE (`defaultModel` → `DEFAULT_MODEL`).
- A singleton instance (`export const fooService = new FooService()`) becomes
  `pub static FOO_SERVICE: LazyLock<FooService> = LazyLock::new(FooService::new);`
  and callers write `FOO_SERVICE.method()`. State inside it uses interior mutability.
- Enum variants: PascalCase, with `#[serde(rename = "...")]` (or `rename_all`) to
  keep the wire text (`'budget_exceeded'` → `BudgetExceeded` renamed `budget_exceeded`).
- JSON field names on the wire keep camelCase: `#[serde(rename_all = "camelCase")]`.

## Types

| TypeScript | Rust |
|-----------|------|
| `string` | `String` (owned in structs), `&str` in parameters |
| `number` (integer: counts, ms, ports, ids, token counts, DB Int) | `i64` (or `usize`/`u16`/`u32` where obviously right) |
| `number` (fractional) | `f64` |
| `boolean` | `bool` |
| `T \| undefined`, optional property | `Option<T>`; in a wire struct add `#[serde(skip_serializing_if = "Option::is_none")]` when TypeScript would omit the key |
| `T \| null` | `Option<T>` serialized as `null` (the default) |
| `Date` | `chrono::DateTime<Utc>`; on the wire as `toISOString()` text via `#[serde(with = "crate::support::serde_iso")]` |
| `unknown`, `any`, JSON | `serde_json::Value` |
| `Record<string, T>` | `IndexMap<String, T>` when order can matter (it often does), else `HashMap` |
| `Map<K, V>` | `HashMap`/`IndexMap`; `DashMap` when shared across tasks |
| union of string literals | `enum` with serde renames, plus `as_str()` |
| discriminated union | `enum` with `#[serde(tag = "type")]` (match the TS discriminant key) |
| interface of data | `struct` with `#[derive(Debug, Clone, Serialize, Deserialize)]` |
| interface implemented by classes or by objects with methods | `trait` (`#[async_trait]` when it has async methods), held as `Arc<dyn Trait>` |
| class | `struct` + `impl` |
| `Promise<T>` | `async fn` returning `T` / `anyhow::Result<T>` |
| callback | `Arc<dyn Fn(A) -> BoxFuture<'static, R> + Send + Sync>` (`futures::future::BoxFuture`) or a sync `Arc<dyn Fn(A) -> R + Send + Sync>` |
| `AbortSignal`/`AbortController` | `tokio_util::sync::CancellationToken` |
| `EventEmitter` | `tokio::sync::broadcast` or a listener list |
| `setTimeout`/`setInterval` | `tokio::spawn` + `tokio::time::sleep`/`interval`; keep the `JoinHandle`/`AbortHandle` to cancel |
| thrown `Error` | `anyhow::Error`; a typed `thiserror` enum where callers branch on the kind |
| zod schema validating input | serde struct + explicit checks that produce the same error text |

JavaScript details that change output:

- `JSON.stringify` writes `3`, not `3.0`. Never put an integral `f64` into JSON; use
  `i64` or `crate::support::js::number`.
- `string.length` and `slice` count UTF-16 code units. Use `crate::support::js::len16`
  and `slice16` wherever a limit or cut position comes from TypeScript.
- Object key order is insertion order. `serde_json` is built with `preserve_order`,
  and `json!` keeps the written order. Keep TypeScript's order when building JSON.
- `new Date().toISOString()` is `crate::support::now_iso()`.
- Template literals: `format!` with the identical text.
- `Array.prototype.sort` is stable; Rust's `sort_by` is stable too. Use it.
- Regular expressions: the `regex` crate has no lookaround or backreferences. Use
  `fancy_regex` for those. Compile once in a `LazyLock<Regex>`.

## Concurrency

- Async everywhere I/O happens (tokio). Pure functions stay sync.
- `parking_lot::Mutex`/`RwLock` for short critical sections. Never hold one across an
  `.await`. Use `tokio::sync::Mutex` when the lock must span an `.await`.
- A per-key async lock (the TypeScript "mutex per thread") is a
  `DashMap<String, Arc<tokio::sync::Mutex<()>>>`.
- Spawned background work that TypeScript fires and forgets (`void promise`) is
  `tokio::spawn`, with the same error logging the `.catch` had.

## Database

There is no Prisma. `crate::db` provides:

- `crate::db::schema` — Diesel `table!` definitions for every Prisma model, with the
  real column names (`#[sql_name = "threadId"] thread_id`).
- `crate::db::models` — one struct per model, named as the Prisma model
  (`ConversationMessage`, `AgentWorkspace`, …), field names snake_case, plus `New…`
  insert structs and enums (`MessageRole`, `MessageTrigger`, `ThreadSource`, …) with
  the stored text. They serialize to JSON exactly as Prisma's rows do (camelCase,
  dates as ISO text, `null` for empty columns).
- `crate::db::run(|conn| { … })` runs Diesel code on a pooled connection off the async
  threads and returns its result. `conn.transaction(|conn| …)` for `$transaction`.
- Dates are stored as integer epoch milliseconds (what Prisma writes); the model type
  is `DateTime<Utc>`.
- Prisma behavior to reproduce by hand: `@default(uuid())` → `Uuid::new_v4()`,
  `@default(now())` → `Utc::now()`, `@updatedAt` → set `updated_at = Utc::now()` on
  every update, `include:` → a second query, `onDelete: Cascade` → SQLite does it
  (foreign keys are on).
- No raw SQL strings outside `crate::db` and the named exceptions (the `sqlite-vec`
  search in `services/memory_store.rs`, the read-only `runtime_state` read in
  `lib/coding_agents/terminal.rs`).
- Tests that touch the database use `crate::db::testing::test_db()` which gives a fresh
  migrated database and serializes those tests (`#[serial_test::serial]`).

## Models (the AI SDK)

There is no `ai` npm package. `crate::ai` mirrors its API and names:
`ModelMessage` (system/user/assistant/tool), content parts, `Tool`, `ToolSet`
(`IndexMap<String, Tool>`, order matters), `generate_text`, `generate_object`, `embed`,
`StepResult`, `LanguageModelUsage`, `LanguageModel` (trait, `do_generate` with
`LanguageModelV3CallOptions`), `ProviderOptions`, `step_count_is`, errors such as
`ApiCallError`. Providers live in `crate::ai::providers::{anthropic, amazon_bedrock,
openai}`. MCP clients live in `crate::ai::mcp`. If you need something the module does
not have yet, use the AI SDK's name for it and report it.

## Logging

```rust
use crate::{log_info, log_warn, log_error, log_debug};
log_info!("[Startup] skills dir: {}", dir);
log_warn!(json!({ "err": crate::lib::log_redaction::err_json(&e) }), "[Cron] run failed");
log_info!(json!({ "agentId": id }), "[Startup] resolving agent workspace");
```

Pino's `%s`/`%d` placeholders become `{}`. Keep the message text identical. Field
objects keep their TypeScript keys. An error goes under `err`.

## HTTP

- One `axum::Router` per route file: `pub fn router() -> Router` (state-free; services
  are statics). `server.rs` mounts them in the same order as `src/server.ts`.
- `res.status(n).json(body)` → `(StatusCode::from_u16(n), Json(body))`.
- Express body parsing: JSON with the same size limits; a body that is not JSON is
  answered as Express answers it (400).
- Keep path parameter names and query parameter names.

## Tests

- Port the TypeScript unit tests of your files into `#[cfg(test)] mod tests` in the
  same file (or a `tests.rs` sibling for large suites). Keep the test names readable
  (`fn refuses_a_name_with_invisible_characters()`).
- Where a TypeScript test mocks a module (`vi.mock`), test the Rust logic directly, use
  a test database, or inject the dependency. Do not add production indirection only to
  make a mock possible unless the TypeScript already had the seam.
- Async tests: `#[tokio::test]`.

## Comments and prose

Keep the TypeScript doc comments that explain behavior, edited only where they name
TypeScript constructs. Follow the writing rules in `AGENTS.md` for new prose. No
"ported from" comments.

## Working rules

- `cargo check` from `runtime/` must pass before you finish. Run the tests of the
  modules you wrote: `cargo test --lib <module_path_fragment>`.
- Run `rustfmt --edition 2024` on the files you wrote. Do not reformat other files.
- Do not edit files you were not assigned, except: adding a `pub mod` line, adding a
  dependency to `Cargo.toml` (report it), or a one-line fix to a signature you call.
  Report every such edit.
- `#![allow(dead_code, unused_imports, unused_variables)]` stays at the crate root
  until the port is complete; do not add other crate-wide allows.
- Use `anyhow::Context` to keep error text TypeScript callers relied on.
- Commit your work in your worktree with a clear message when done (`git add -A &&
  git commit -s -m "..."`). Never push.
