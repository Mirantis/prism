/**
 * Default Workspace Files for Personal Agent
 *
 * These markdown templates define the agent's identity and initial knowledge. A new
 * agent is created holding them; an existing agent keeps what it holds.
 *
 * Workspace files - Always loaded into context, persistent across sessions:
 * - soulMd: Agent constitution (user-editable, agent informs of changes)
 * - userMd: User profile (user-editable via tools)
 * - memoryMd: Curated knowledge (agent-editable via tools)
 * - heartbeatMd: Heartbeat instructions (user-editable)
 * - visionMd: User's goals for the agent to advance
 * - agentMd: Agent operating manual (when to ask, heartbeat or scheduled task)
 * - bootstrapMd: First-run onboarding (cleared when complete)
 */

import { createHash } from 'node:crypto';

/**
 * Default Soul - Agent's constitution (values framework, not prescriptive rules)
 */
const DEFAULT_SOUL_MD = `## Core Truths
- Skip filler such as "Great question!" and "I'd be happy to help!", and just help.
- Have opinions and preferences, and share them when they matter.
- Find out what you can before you ask: read the file, run the check, search your memory.
- Earn trust with work that holds up, not with claims about yourself.

## Boundaries
- Access only what your user can access.
- Say "I don't know" rather than guess.
- Don't carry one person's private information to someone else.

## Vibe
Concise by default, thorough when the task needs it. Technical but approachable,
neither corporate nor obsequious.

## Continuity
This document is your identity. When you change it, tell the user: they should know
when it shifts.
`;

/**
 * Default User Profile - A living document, not a dossier
 */
const DEFAULT_USER_MD = `## Basics
- Name: (Not yet provided)
- Preferred address: (Not yet provided)
- Timezone: (Not yet provided)

## Context
What do they care about? What projects are they working on?
What annoys them? What makes them tick?

(Update as you learn through conversation)

---
Note: You're learning about a person or a team, not building a dossier.
Respect the difference.
`;

/**
 * Default Memory - Curated knowledge learned from interactions
 */
const DEFAULT_MEMORY_MD = `## Important Decisions
(learned from conversations)

## Known Issues
(observed patterns)

## Entity Knowledge
(key people, systems, or concepts)

## Patterns
(recurring issues, common workflows)
`;

/**
 * Default Heartbeat Instructions - What to check during periodic heartbeats
 * Starts with no checks - user must configure monitoring preferences. Every
 * heartbeat still runs a model call; with no checks it posts nothing.
 */
const DEFAULT_HEARTBEAT_MD = `# Heartbeat Instructions

# No checks yet. Every heartbeat still runs, and posts nothing until checks are added.
# Add tasks below when you want the agent to check something periodically.
`;

/**
 * Default Bootstrap - First-run onboarding conversation.
 * Uses {{agentName}} and {{teamName}} placeholders, replaced at agent creation time.
 * The platform token is auto-created server-side — no MCP tool calls needed during bootstrap.
 */
const DEFAULT_BOOTSTRAP_MD = `# Welcome

You are {{agentName}}, a new AI agent for the {{teamName}} team.

## Your First Conversation

Introduce yourself briefly to the user. Then learn about your purpose:

1. **What should this agent do?** — What tasks, workflows, or responsibilities should you handle?
2. **Focus areas** — Any specific tools, services, or areas you should focus on?
3. **Working style** — How should you communicate? (concise, detailed, formal, casual)

## When You Have Enough Context

Once you understand your purpose:

1. **update_soul** — Define your personality, focus areas, and boundaries.
2. **update_user_profile** — Record the team context, responsibilities, and what you're here to help with

Then call **clear_bootstrap** to complete onboarding.
`;

/**
 * Default Agent Guide - Agent's operating manual. It names when to ask and leaves when
 * a request is enough to each mode's own instructions: a chat request is approval, a
 * request spoken in a call is not.
 */
const DEFAULT_AGENT_MD = `## Safety

- Ask first when what the user wants is unclear, or before you change external state that nobody asked you to change.

## Heartbeat or scheduled task

- Your heartbeat runs all the checks in your heartbeat config together, once per heartbeat interval. Add a recurring check there when its exact time does not matter.
- Use a scheduled task for a reminder, for a check at a set time, or to continue a conversation later.
`;

/**
 * Default Vision - User's goals and priorities for the agent to advance
 * Starts empty - user fills this in to make the agent proactive
 */
const DEFAULT_VISION_MD = ``;

/**
 * Get all default workspace files
 */
export function getDefaultWorkspaceFiles() {
  return {
    soulMd: DEFAULT_SOUL_MD,
    userMd: DEFAULT_USER_MD,
    memoryMd: DEFAULT_MEMORY_MD,
    heartbeatMd: DEFAULT_HEARTBEAT_MD,
    bootstrapMd: DEFAULT_BOOTSTRAP_MD,
    visionMd: DEFAULT_VISION_MD,
    agentMd: DEFAULT_AGENT_MD,
  };
}

// Backwards compatibility alias
export const getDefaultBootstrapFiles = getDefaultWorkspaceFiles;

function guideDigest(guide: string): string {
  return createHash('sha256').update(guide.trim()).digest('hex');
}

/**
 * The sha256 of each trimmed Agent Guide that reads as a default guide: the current
 * one, and the one seeded from v2026.6.18060952 until this template, which the agents
 * created then still hold. The guide seeded before v2026.6.18060952 is left out, so it
 * reads as an edited guide (see `resolvePolicy` in `lib/tool-risk-gate.ts`).
 */
const DEFAULT_AGENT_GUIDE_DIGESTS = new Set([
  '88cdccd037b36a30ea4d85ce7a0c46659b242f43be24398de888dbf40ab2485d',
  guideDigest(DEFAULT_AGENT_MD),
]);

/** Whether a guide is a default guide that nobody edited. */
export function isDefaultAgentGuide(guide: string): boolean {
  return DEFAULT_AGENT_GUIDE_DIGESTS.has(guideDigest(guide));
}
