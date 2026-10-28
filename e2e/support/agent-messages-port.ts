/**
 * The port the runtime's agent-messages listener binds.
 *
 * The Playwright config pins the runtime to it and the agent message steps POST
 * to it, so it is owned here and read in both places.
 */
export const AGENT_MESSAGES_PORT = 3005;
