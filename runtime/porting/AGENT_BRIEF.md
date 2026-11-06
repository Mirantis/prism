# Brief for porting engineers

You are one of several engineers porting the Prism Agent runtime from TypeScript
(`src/`) to Rust (`runtime/`) **at the same time, in the same working tree**:
`/Users/phorsmalahti/dev/prism-agent/.claude/worktrees/rust`. Other engineers are
editing other files right now.

## Setup

1. Read `runtime/PORTING.md` in full. It is binding.
2. Skim `AGENTS.md` (repo root): "Architecture rules" and "Writing style".
3. Use your own Cargo target directory so builds do not queue behind each other.
   Create it once by cloning the shared one (APFS clone, instant, no disk cost):
   `cp -Rc runtime/target runtime/target-<yourname>`
   Then always build with:
   `cd runtime && CARGO_TARGET_DIR=target-<yourname> cargo check --lib 2>&1 | grep -E '^(error|warning: unused)' -A 6 | head -200`
   (narrow the grep to your files with `grep -B2 -A12 'src/<your dir>'` when the
   output is long).
4. npm packages (to read library sources such as the AI SDK in
   `node_modules/ai/src`, `node_modules/@ai-sdk/*/src`) are in
   `/Users/phorsmalahti/dev/prism-agent/node_modules/`. This worktree's own
   `node_modules` is empty.
5. `runtime/porting/mapping.json` maps every TypeScript file to its Rust file and
   module path. Use it to find where an imported name lives.

## Rules of the shared tree

- Edit only the files assigned to you, plus the exceptions in PORTING.md.
- **No git commands that change state**: no commit, add, checkout, stash, reset,
  restore, merge. Read-only git (`git log`, `git show`, `git diff`) is fine. The
  coordinator commits.
- Never run `cargo fmt` (it formats everyone's files). Use
  `rustfmt --edition 2024 <your files>`.
- Never run `cargo clean`, never delete another engineer's target dir.
- Errors in files you do not own are other people's work in progress. Ignore them,
  unless your change caused them.
- A parse error in a file stops the whole crate from type-checking for everyone.
  Write each file whole (one Write), and make sure it parses
  (`rustfmt --edition 2024 --check <file>` parses without building) before moving on.
- Bash in this environment refuses complex shell: no `$(...)` chains, no heredocs
  inside `$(...)`, no `source`, no `git -C`. Write helper scripts to a file and run
  them with `python3 <file>` or `bash <file>`. Scratch files go under
  `runtime/porting/scratch-<yourname>/` (create it; it is removed later).

## Names of things being written in parallel

- Prisma models and enums: `crate::db::models::<PrismaName>` (`AgentWorkspace`,
  `ConversationThread`, `ConversationMessage`, `MessageAttachment`, `CronTask`, `Goal`,
  `LlmCall`, `MemoryEntry`, `SlackMapping`, `TeamsMapping`, `WebhookSubscription`,
  `WebhookRun`, `RemoteComputer`, `UpdateAttempt`, `RuntimeState`, `PendingWork`, …;
  enums `MessageRole`, `MessageTrigger`, `ThreadSource`, `AgentStatus`,
  `AgentHeartbeatStatus`, `AgentModelMode`, `AgentType`, `WebhookAuthType`, …).
  Fields are snake_case of the Prisma field. Insert structs are `New<Model>`.
  Database access: `crate::db::run(move |conn| { … diesel … }).await?` with tables in
  `crate::db::schema::<table_name>` (the `@@map` name, e.g. `conversation_messages`).
- AI SDK: `crate::ai::*` with the AI SDK's own names, snake_case for functions:
  `ModelMessage`, `SystemModelMessage`, `UserModelMessage`, `AssistantModelMessage`,
  `ToolModelMessage`, `TextPart`, `ImagePart`, `FilePart`, `ToolCallPart`,
  `ToolResultPart`, `Tool`, `ToolSet`, `ToolExecutionOptions`, `generate_text`,
  `GenerateTextOptions`, `GenerateTextResult`, `StepResult`, `generate_object`,
  `embed`, `embed_many`, `LanguageModel` (trait; held as `Arc<dyn LanguageModel>`),
  `EmbeddingModel`, `LanguageModelUsage`, `ProviderOptions`, `ProviderMetadata`,
  `FinishReason`, `step_count_is`, `ApiCallError`, `json_schema`, `tool`. Provider
  factories: `crate::ai::providers::anthropic`, `crate::ai::providers::amazon_bedrock`,
  `crate::ai::providers::openai`. MCP: `crate::ai::mcp`.
- Logging: `crate::{log_info, log_warn, log_error, log_debug}` macros (see PORTING.md).
- Error redaction for logs: `crate::lib::log_redaction::err_json(&e)`.
- JavaScript semantics helpers: `crate::support` (`now_ms`, `iso`, `now_iso`,
  `parse_iso`, `serde_iso`, `js::len16`, `js::slice16`, `js::number`, `js::parse_int`).

## Your final report

End with a short report: files written, anything you could not finish (by function),
every edit outside your assignment, dependencies you added, TypeScript bugs you ported
as-is, and open questions for the coordinator.
