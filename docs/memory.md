# Memory

The agent remembers across conversations. Memory has two layers, both persisted
in the embedded database, and each serves a different purpose.

## Two layers

### 1. Curated memory (always in context)

A single markdown document the agent maintains itself — the same **Memory**
document described in **[The agent's identity](agent-identity.md)**. It's always
present in the system prompt, so recall is instant and free of any search step.
This is where the agent keeps the things it has decided are worth holding onto
permanently: important decisions, known issues, durable facts about your
environment, recurring patterns.

It's deliberately bounded. The agent prunes and rewrites it rather than letting
it grow without limit — think of it as the agent's working notes, not its
archive.

### 2. Searchable memory (recalled on demand)

An embedding-indexed store for everything else. The agent writes entries here as
it works, and queries them **by meaning** — not keyword — when something becomes
relevant. This is the archive: far larger than what could fit in the prompt, and
retrieved only when needed.

- **Embeddings** are generated with Amazon Titan v2 (via Bedrock) and stored
  alongside each entry.
- **Search** runs as vector similarity over the embedded SQLite database
  (using `sqlite-vec`), filtered to the agent and a recency window, ranked by
  semantic closeness.
- Each entry has a **category** (observation, action, decision, or event) and an
  **importance** score, so recall can be scoped and weighted.

## How the agent uses it

You don't manage memory directly — the agent does, through three
[tools](tools.md#memory):

- **Write** — record something worth keeping (with a category and importance).
  The embedding is computed in the background, so writes don't slow the
  conversation.
- **Search** — pull back relevant past entries by meaning, optionally filtered
  by category and how far back to look.
- **Delete** — remove entries that are no longer accurate.

In practice this is invisible: you tell the agent something, and it decides
whether to fold it into curated memory, drop it into searchable memory, or both.
Later, in an unrelated conversation, it can search and recall it.

## Telling the agent to remember

Just say so. "Remember that we deploy on Fridays," "make a note that the billing
service owner is Dana," "forget what I said about the old API key" — the agent
maps these to the right memory operations. If you want something kept *always in
view*, ask it to add the fact to its curated memory specifically; for everything
else, the searchable store is the default.

## Persistence and backup

Both layers live in the agent's SQLite database, so they survive restarts,
daily [session resets](sessions-and-safety.md), and upgrades. Memory is included
in the `.prism` export from the **[Web UI](web-ui.md#profile)**, so backing up
the agent backs up everything it remembers.
