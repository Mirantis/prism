# Prism Agent GUI

Desktop GUI for Prism Agent, built with [Tauri](https://tauri.app/)
(Rust shell) + React + TypeScript + Vite.

This is currently an empty starter — a single window with no features yet.
It lives alongside the existing clients (`cli/` TUI, `web/` SPA) and is a
standalone app with its own toolchain; it is **not** part of the root npm
workspaces.

## Prerequisites

- [Rust toolchain](https://www.rust-lang.org/tools/install) (stable)
- Node.js 22+
- Platform dependencies for Tauri — see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.
  On macOS this is just the Xcode Command Line Tools.

## Develop

```bash
cd gui
npm install
npm run tauri dev
```

`tauri dev` starts Vite (frontend, port 1420) and launches the native
window, rebuilding on changes.

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
