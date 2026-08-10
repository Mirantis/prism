/**
 * Type shim for `@ai-sdk/mcp/mcp-stdio`.
 *
 * The stdio MCP transport is only reachable through the package's `exports`
 * map, and the two resolvers disagree about which specifier works:
 *
 *   - **Runtime** (Node CJS, tsx, esbuild) honours `exports`, so
 *     `@ai-sdk/mcp/mcp-stdio` loads and `@ai-sdk/mcp/dist/mcp-stdio` throws
 *     `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *   - **tsc** runs `moduleResolution: "node10"`, which ignores `exports`
 *     entirely — so the subpath is `TS2307` while the deep path resolves fine.
 *
 * Declaring the subpath and re-exporting the deep path satisfies both: source
 * imports the specifier that works at runtime, and the types are the package's
 * own rather than a hand-written copy that could drift. A `paths` entry cannot
 * do this — its target is a filesystem path, and `node_modules` sits at a
 * different depth in a git worktree than in the main checkout.
 */
declare module '@ai-sdk/mcp/mcp-stdio' {
  export { Experimental_StdioMCPTransport, type StdioConfig } from '@ai-sdk/mcp/dist/mcp-stdio';
}
