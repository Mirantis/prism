//! The runtime's HTTP route modules, one area per file.
//!
//! Each module exposes `pub fn router() -> axum::Router`. Its routes carry their
//! full paths (`/agents/cron-tasks`, not `/cron-tasks`), and `server.rs` combines
//! the routers with `Router::merge` in the order `src/server.ts` mounts them. The
//! routers hold no state: the services they call are statics. Two routers must not
//! register the same method and path, and a path parameter at one position has the
//! same name in every route that has a parameter there.

// @generated-modules-start
pub mod activity;
pub mod agent_guide;
pub mod agent_messages;
pub mod agent_state;
pub mod chatgpt_auth;
pub mod coding_agents;
pub mod computer;
pub mod computers;
pub mod cron_tasks;
pub mod document_revisions;
pub mod heartbeat_delivery;
pub mod llm_provider;
pub mod locked_in;
pub mod management;
pub mod messages;
pub mod model_selection;
pub mod question_cards;
pub mod slack;
pub mod slack_router;
pub mod spending;
pub mod teams;
pub mod threads;
pub mod update;
pub mod webhook;
// @generated-modules-end
