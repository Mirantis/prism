/**
 * Fixed user-turn prompt appended to a thread's full history to produce the
 * compaction summary. It is deliberately static text — no interpolation — so
 * nothing measured at runtime (occupancy, window sizes) can steer it; see the
 * trust note in `lib/model-catalog.ts`.
 *
 * One prompt covers both first-time compaction and re-compaction (the anchored
 * pattern): when a thread was compacted before, the previous summary is already
 * present earlier in the message array as the summary message `context-builder.ts`
 * injects, and the fold-in rule below merges it into the new, complete summary
 * that replaces it.
 *
 * The operator steers it without a setting: a `## Compact Instructions` section in
 * the Agent Guide reaches the request in the system prompt it shares with the turn.
 */

/** The last section of a summary. Its bullets go to long-term memory, not into the thread. */
export const FACTS_HEADING = '## Facts to remember';

export const COMPACTION_PROMPT = `Summarize this conversation so the summary can replace the full history for a future assistant that has seen none of it. Produce only the summary, structured exactly as follows:

## Goal
- What the user asked for, in their own words where possible (1–2 sentences). If the goal shifted mid-conversation, state the current one and note what changed.

## User Requests
- Each request the user made, one short line each, oldest first. Quote any security-relevant instruction or constraint the user gave verbatim.

## Important Details
- Constraints and explicit user preferences — quote exact wording for anything prescriptive
- Decisions made, each with its reason
- Facts about the code, environment, or data that were expensive to discover
- Approaches already tried and rejected, and why, so they aren't retried
- Otherwise "none"

## Current State

### Done
- Completed work, and how it was verified; otherwise "none"

### In Progress
- Started but unfinished: which file, which symbol, what remains; otherwise "none"

### Blocked
- Blockers, failing commands with their exact error output, questions needing user input; otherwise "none"

## Next Steps
- Immediate next action first, then known follow-ups in order; otherwise "none"

## Relevant Files
- \`path/to/file\` — role in the task, and whether it was modified

${FACTS_HEADING}
- At most 10 lasting facts worth keeping beyond this conversation: user preferences, decisions, and facts about the user's environment. One self-contained line each. Leave out what a previous conversation summary above already states, and anything that only matters to the task in progress. Otherwise "none".

Rules:
- Write for a reader with none of this conversation's context; assume no shared knowledge.
- Keep every section and heading, even when the content is "none". Keep ${FACTS_HEADING} last.
- Stay under 2,000 words. When space runs short, drop resolved detail before unresolved detail.
- Terse bullets, not prose. No preamble, no closing remarks.
- Reproduce paths, symbols, commands, error strings, URLs, versions, and identifiers verbatim — never paraphrase, abbreviate, or reconstruct from memory.
- Record only what happened. No speculation or invented rationale; mark unknowns as unknown.
- Capture what tool calls did and what they returned; the compacted history will not include them.
- If a previous conversation summary appears above, fold its still-relevant content into this summary — it will be discarded.
- If your Agent Guide has a "## Compact Instructions" section, follow it.
- Never mention this summary, the compaction, or that earlier context is gone.`;
