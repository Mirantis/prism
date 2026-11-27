# Copilot instructions

These rules apply to every pull request in this repository. They are
non-negotiable gates — a PR that touches behavior is not complete until the
matching tests below exist and pass.

## Testing requirements

### 1. Every PR that changes behavior must add or update unit tests

Any PR that changes behavior must ship with related unit tests covering the
new or modified logic. If you change a function's behavior, the unit tests for
that function must change with it. Pure refactors with no behavior change must
still keep the existing unit tests passing.

### 2. Every user-facing change must add end-to-end tests

Any change a user can observe (web UI, terminal/CLI UI, Slack, slash commands,
flags, env vars, commands, or any other surface) must ship with corresponding
end-to-end tests that exercise the real flow on **each surface it touches**.

The e2e suites live in `e2e/`:

- **Web**: Playwright BDD — a `.feature` in `e2e/features/` with step
  definitions in `e2e/steps/`, driving the SPA against a real agent-runtime.
  Run via `npm run test --workspace=prism-agent-e2e`.
- **CLI/TUI**: Gherkin `.feature` files in `e2e/tui/features/` bound with
  `@amiceli/vitest-cucumber` in `e2e/tui/tests/`, driving the `prism` binary
  under a PTY against a real runtime. Run via
  `npm run test:e2e:tui --workspace=prism-agent-e2e`.

A feature that spans both web and CLI needs e2e coverage on **both**. Assert on
authoritative state where possible (downloaded file bytes, DB rows via the
management API) rather than only on-screen text.

### 3. Every bug fix must add a regression test

Any PR that fixes a bug must include a regression test that fails without the
fix and passes with it, so the bug cannot silently return. Place it at the
level that reproduces the bug (unit for logic bugs, e2e for user-facing bugs).

## Summary checklist

Before requesting review, confirm:

- [ ] If behavior changed, related unit tests added or updated.
- [ ] If user-facing behavior changed, e2e tests added on every surface it touches.
- [ ] If this PR fixes a bug, a regression test added that fails without the fix.
