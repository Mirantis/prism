# Prism Agent GUI

Desktop GUI for Prism Agent, built with [Tauri](https://tauri.app/)
(Rust shell) + React + TypeScript + Vite.

It provides a chat window that talks to the agent-runtime over WebSocket,
exactly like the `cli/` TUI and `web/` SPA: no auth, the runtime substitutes
the agent/user/thread server-side, recent history loads from
`/single-agent/messages`, and replies stream in as `chat` events. It lives
alongside the existing clients and is a standalone app with its own toolchain;
it is **not** part of the root npm workspaces.

## Prerequisites

- [Rust toolchain](https://www.rust-lang.org/tools/install) (stable)
- Node.js 22+
- Platform dependencies for Tauri — see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.
  On macOS this is just the Xcode Command Line Tools.

## Develop

Run the agent-runtime first (from the repo root) so the GUI has something to
talk to:

```bash
npm run dev          # agent-runtime on :3003 (needs Bedrock creds in .env for replies)
```

Then, in another terminal:

```bash
cd gui
npm install
npm run tauri dev    # or: npm run dev:gui  from the repo root
```

`tauri dev` starts Vite (frontend, port 1420) and launches the native window,
rebuilding on changes. Vite proxies `/single-agent`, `/agents`, and `/api/ws`
to the runtime on `:3003` (see `vite.config.ts`), so the webview stays
same-origin — no CORS. This mirrors the web app's dev setup.

To point a packaged build at a runtime directly, set `VITE_RUNTIME_URL`
(e.g. `http://localhost:3003`) at build time; without it the app uses
same-origin URLs (the dev proxy).

## Build

```bash
cd gui
npm run tauri build
```

Produces a platform-native bundle under `src-tauri/target/release/bundle/`.

## Layout

- `src/` — React frontend (Vite)
- `src-tauri/` — Rust application shell, `tauri.conf.json`, icons, capabilities

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/)
  + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
  + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
