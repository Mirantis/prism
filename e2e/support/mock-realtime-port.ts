/**
 * The port the mock Realtime model listens on.
 *
 * Three places need it — the Playwright config starts the server and points the runtime's
 * managed Azure endpoint at it, the server binds it, and the voice steps read `/state` on
 * it — so it is owned here and read there. `MOCK_REALTIME_PORT` in the environment moves
 * all three at once.
 */
export const MOCK_REALTIME_PORT = Number(process.env.MOCK_REALTIME_PORT || 3103);
