# Skills

**Agent Skills** are reusable bundles of instructions (and optional scripts and
reference files) that teach the agent how to do a specific task well. They
follow the open [agentskills.io](https://agentskills.io) standard — a `SKILL.md`
file with a name and description, optionally alongside `scripts/`, `references/`,
and `assets/` folders — so skills written for Claude Code, Codex, and other
tools work here unchanged.

The agent uses skills **automatically**. At the start of each turn it sees only
each skill's name and one-line description (cheap); when a task matches, it loads
that skill's full instructions on demand and follows them. You can also list and
run skills explicitly with the [`/skills` command](#the-skills-command).

## Where skills live

Skills are discovered from three places, and the sets are merged:

- **Global skills** — the agent's skills directory, which lives in its data dir:
  `~/.prism/skills` for a native install, `/data/skills` in Docker. (Override the
  data dir with `PRISM_DATA_DIR`, or the skills dir specifically with
  `PRISM_SKILLS_DIR` — see **[Configuration](configuration.md)**.) These are
  available in every conversation.
- **Workspace skills** — when you start the terminal UI inside a repository, that
  repo's `.claude/skills/` and `.agents/skills/` are loaded too, so a project can
  ship its own skills. These are labelled `(workspace)` in `/skills` listings.
- **Plugin skills** — the `skills/` folder of each installed
  **[plugin](plugins.md)**. These are labelled `(plugin: <id>)`.

On a name clash the **workspace** skill wins over a global one (a repo can
override a global skill), and `.claude/skills` takes precedence over
`.agents/skills`. Plugin skills come last, so a plugin can add a skill but never
replaces one you installed yourself.

## Installing skills

Installation is out of band — you put skill folders in place, and the agent
picks them up automatically (no restart needed). Two ways:

- **Drop a bundle in.** Copy a `<name>/SKILL.md` folder (with any `scripts/` /
  `references/` / `assets/`) into the skills directory above, or into a repo's
  `.claude/skills/` for a workspace skill.
- **Use the `skills` CLI.** From the ecosystem at [skills.sh](https://skills.sh):

  ```bash
  npx skills add <source> --copy
  ```

  where `<source>` is a GitHub repo (e.g. `owner/repo`), a skill URL, or a local
  path. Then move the resulting `<name>/` folder into the agent's skills
  directory. Use `--copy` so the bundle is a real copy that survives restarts.

A skill folder looks like:

```
my-skill/
├── SKILL.md        # required: name + description frontmatter, then instructions
├── scripts/        # optional: executable helpers the instructions can run
├── references/     # optional: longer docs loaded on demand
└── assets/         # optional: templates and data files
```

```markdown
---
name: my-skill
description: What this does and when to use it.
---

Step-by-step instructions for the agent to follow…
```

## The `/skills` command

Both the **[Terminal UI](terminal-ui.md)** and the **[Web UI](web-ui.md)** expose
a `/skills` slash command (type `/` in the chat input):

- `/skills` or `/skills list` — list the available skills with their
  descriptions; workspace skills are marked `(workspace)` and plugin-provided
  ones `(plugin: <id>)`.
- `/skills run <name>` — run a skill now. The agent loads it and works through
  it, streaming the reply back into the conversation.

Automatic (agent-chosen) use needs no command — the agent reaches for a skill
whenever a task matches its description.

## Shared with the Claude Code sub-agent

The same skills are visible to the **[Claude Code sub-agent](tools.md#claude-code-sub-agent)**:
the runtime points Claude Code at the agent's skills directory, and a repo's
`.claude/skills/` are discovered there natively. So whether the agent handles a
task itself or delegates it to Claude Code, it works from the same set of skills.
