/**
 * The port the runtime's webhook listener binds.
 *
 * The Playwright config pins the runtime to it and the webhook steps POST to it,
 * so it is owned here and read in both places.
 */
export const WEBHOOK_PORT = 3004;
