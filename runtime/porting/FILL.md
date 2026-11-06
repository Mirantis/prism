# Phase 2: port the behavior

Phase 1 wrote every module's public API (types complete, functions as `todo!()`).
Phase 2 replaces every `todo!()` in your files with a faithful port of the
TypeScript, and ports the TypeScript tests.

For each file in your assignment (`runtime/porting/fill/<group>.txt`):

1. Read the TypeScript file in full, and its test file(s).
2. Port every function body, private helper, private type and constant. Keep the
   control flow, the order of side effects, every string, every limit and timeout.
   The phase 1 signatures are a starting point: change a signature when the port
   needs it (sync → async, `&str` → `String`, a missing parameter, a `Result`), then
   fix every caller in the crate (`cargo check` lists them). Tell the owner of a
   caller's file in your report only if the fix was more than mechanical.
3. Port the tests into `#[cfg(test)] mod tests` (or `<file>/tests.rs`). Test names
   say what the behavior is. Tests that need the database use
   `crate::db::testing::test_db()` and `#[serial_test::serial]`.
4. No `todo!()`, `unimplemented!()` or `unreachable!()` placeholders may remain in
   your files when you finish, except an `unreachable!()` the logic proves.

## Exactness

The E2E suites compare what the runtime sends to models against recordings made by
the TypeScript runtime, and clients parse every HTTP and WebSocket payload. So:

- Prompt text, tool names, tool descriptions, message assembly and JSON key order
  are byte-identical to the TypeScript.
- Tool input schemas: `runtime/tests/fixtures/tool-schemas.json` holds every
  built-in tool as the TypeScript runtime sends it to a provider
  (`{type, name, inputSchema, description, providerOptions?}`), grouped by factory
  and mode. Build each Rust tool's `input_schema` with `serde_json::json!` in the
  same key order, and add a test per factory that asserts the Rust definitions
  equal the fixture entries exactly (compare `serde_json::Value`s, and compare
  `serde_json::to_string` output to catch key order). Where a schema or description
  depends on runtime state (available coding agents, computers), make the fixture
  case pass and port the variation faithfully.
- HTTP and WebSocket payloads: field names, `null` versus absent, number formatting
  (`3` not `3.0`), date format (`toISOString()`), status codes, error texts.
- Logs: same message text, same structured fields.

## Behaviors with no direct Rust library

- Express → axum (see PORTING.md). Keep Express's observable behavior where clients
  or tests depend on it: JSON body limits, the 400 for unparseable JSON, 404 for an
  unknown route, query string parsing (`req.query.x` as the first value).
- `ws` server → axum WebSocket. Keep close codes, the max frame size, ping/pong.
- Slack Bolt Socket Mode → `tokio-tungstenite` client: `apps.connections.open`,
  envelope acks, reconnect on `disconnect` messages; Web API over `reqwest`
  with `Authorization: Bearer`, no `token` in the body.
- Playwright → the Chrome DevTools Protocol. Add the `chromiumoxide` crate (with
  `tokio-runtime`) if it fits, or write a small CDP client over
  `tokio-tungstenite`; report which.
- node-cron → port the schedule semantics exactly (5- and 6-field expressions, time
  zones via `chrono-tz`); the `croner` or `cron` crate may help — check its field
  semantics against node-cron's before relying on it.
- OpenTelemetry (`lib/telemetry.ts`, `lib/langfuse.ts`) → the `opentelemetry`,
  `opentelemetry_sdk` and `opentelemetry-otlp` crates (HTTP exporter). The OTLP
  records must carry the same resource attributes, body and attributes.
- MCP clients → the `rmcp` crate, or a hand-written JSON-RPC client if `rmcp`
  cannot do what `@ai-sdk/mcp` does here; report which.

## Finish

`cargo check --lib` shows no errors in your files, your tests pass
(`CARGO_TARGET_DIR=target-<you> cargo test --lib <your module path>`), and
`grep -rn 'todo!\|unimplemented!' <your files>` is empty. Then write the report
the brief describes.
