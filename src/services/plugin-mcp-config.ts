/**
 * Agent Plugins `mcp.json` parsing and validation.
 *
 * Pure and self-contained on purpose: no MCP SDK imports, no connections, and
 * (bar one realpath check) no I/O — so the whole rule set from the Agent Plugins
 * 1.0.0 MCP schema can be unit-tested without spawning a process.
 *
 * The failure model is graduated, per spec §7.2.2. An unusable *file* disables
 * MCP for that plugin alone and leaves its skills untouched; a single bad server
 * entry is skipped while its siblings still load. Nothing here throws.
 *
 * Note the vocabulary gap: the spec's remote transport is `streamable-http`,
 * while the AI SDK calls the same thing `http`. We validate the spec's names and
 * translate at this boundary, so SDK naming never leaks into the file format we
 * accept from plugin authors.
 */

import fs from 'fs';
import path from 'path';

/** The one Agent Plugins MCP schema this runtime implements. */
export const MCP_SCHEMA_1_0_0 = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/** Substituted into `args`, `env` values and `cwd` — never into `command` (§9.2). */
const PLACEHOLDER_RE = /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g;

/** The client supplies these; a server that declares them is invalid (§9.2). */
const RESERVED_ENV = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);

/**
 * A command is one executable token. The transport spawns with `shell: false`,
 * so these characters could never be *interpreted* — rejecting them turns
 * `"command": "uvx foo"` into a clear message instead of an ENOENT for a file
 * literally named `uvx foo`.
 */
const COMMAND_TOKEN_RE = /^[^\s;|&$<>`"'\\\n]+$/;

/** A server name becomes part of every tool name, so it must be prefix-safe. */
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** RFC 7230 token characters. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Headers the transport owns. A plugin setting these would either break the
 * connection or spoof identity, and the spec is explicit that `headers` is
 * visible package data rather than a credential channel.
 */
const CLIENT_OWNED_HEADERS = new Set([
  'accept',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'host',
  'mcp-protocol-version',
  'mcp-session-id',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const TOP_LEVEL_FIELDS = new Set(['$schema', 'mcpServers']);
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const REMOTE_FIELDS = new Set(['type', 'url', 'headers']);

/** A validated server entry, with every placeholder already expanded. */
export type ResolvedServer =
  | {
      kind: 'stdio';
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
    }
  | {
      kind: 'http' | 'sse';
      name: string;
      url: string;
      headers: Record<string, string>;
    };

export interface ParseResult {
  servers: ResolvedServer[];
  /** Per-entry problems, already attributed to a server name. */
  warnings: string[];
}

export interface McpParseContext {
  pluginId: string;
  /** Absolute path to the plugin root — becomes `PLUGIN_ROOT`. */
  pluginRoot: string;
  /** Absolute path to the plugin's persistent data dir — becomes `PLUGIN_DATA`. */
  pluginData: string;
}

/**
 * Parse one plugin's `mcp.json`.
 *
 * Returns `null` when the file itself is unusable — unparseable, an unknown
 * top-level key, or a `$schema` this runtime does not implement. A *missing*
 * `$schema` is not unusable: it is assumed to mean 1.0.0 and reported. Returns
 * a result otherwise; individual bad entries land in `warnings` and the rest
 * load.
 */
export function parseMcpJson(raw: string, ctx: McpParseContext): ParseResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  // Closed top level (spec §7.2.1).
  if (Object.keys(parsed).some((k) => !TOP_LEVEL_FIELDS.has(k))) return null;

  const servers: ResolvedServer[] = [];
  const warnings: string[] = [];

  // §10.1: when `$schema` is present it must match the version `plugin.json`
  // declares, so a file targeting a version we don't implement is refused.
  //
  // Absent is tolerated, which the spec's schema (`required: ["$schema", …]`)
  // does not require of us. Practically no `mcp.json` in the wild carries it —
  // the Claude Code, Cursor and VS Code files people copy from all omit it —
  // and rejecting the whole file for that means every server silently fails to
  // load while the plugin's skills keep working, which reads as a runtime bug
  // rather than a malformed file. Same leniency as the missing `type` below,
  // and equally visible: it comes back as a diagnostic.
  if (parsed.$schema === undefined) {
    warnings.push(`mcp.json has no "$schema" — assuming ${MCP_SCHEMA_1_0_0}`);
  } else if (parsed.$schema !== MCP_SCHEMA_1_0_0) {
    return null;
  }

  if (!isPlainObject(parsed.mcpServers)) return null;

  // Sorted so the tool block this eventually produces is stable regardless of
  // how the JSON happened to be written or reformatted.
  for (const name of Object.keys(parsed.mcpServers).sort()) {
    const result = resolveServer(name, parsed.mcpServers[name], ctx, warnings);
    if (result) servers.push(result);
  }

  return { servers, warnings };
}

function resolveServer(
  name: string,
  rawEntry: unknown,
  ctx: McpParseContext,
  warnings: string[],
): ResolvedServer | null {
  const skip = (reason: string): null => {
    warnings.push(`MCP server "${name}": ${reason}`);
    return null;
  };

  if (!SERVER_NAME_RE.test(name)) {
    return skip('name must start alphanumeric and contain only letters, digits, "_" or "-"');
  }
  if (!isPlainObject(rawEntry)) return skip('configuration must be an object');

  // The spec requires `type`, but omitting it for stdio is a common habit in
  // hand-written MCP configs. Default it rather than reject — and say so, so the
  // leniency is visible rather than silent.
  let type = rawEntry.type;
  if (type === undefined) {
    warnings.push(`MCP server "${name}": no "type" declared, assuming "stdio"`);
    type = 'stdio';
  }

  if (type === 'stdio') return resolveStdio(name, rawEntry, ctx, skip);
  if (type === 'streamable-http') return resolveRemote(name, 'http', rawEntry, skip, warnings);
  if (type === 'sse') return resolveRemote(name, 'sse', rawEntry, skip, warnings);
  return skip(`unsupported transport type ${JSON.stringify(type)}`);
}

function resolveStdio(
  name: string,
  entry: Record<string, unknown>,
  ctx: McpParseContext,
  skip: (reason: string) => null,
): ResolvedServer | null {
  const unknown = unknownFields(entry, STDIO_FIELDS);
  if (unknown.length > 0) {
    return skip(
      `stdio configuration has unsupported field(s) ${unknown.join(', ')} — ` +
        `remove them, or move the server to a client that understands them ` +
        `(allowed: ${[...STDIO_FIELDS].join(', ')})`,
    );
  }

  const vars = { PLUGIN_ROOT: ctx.pluginRoot, PLUGIN_DATA: ctx.pluginData };

  // `command` is never expanded (§9.2) and must be a single token: a bare
  // executable name, or a `./` path contained by the plugin.
  const command = entry.command;
  if (typeof command !== 'string' || command.length === 0) {
    return skip('stdio "command" must be a non-empty string');
  }
  if (!COMMAND_TOKEN_RE.test(command)) {
    return skip('stdio "command" must be a single token — put arguments in "args"');
  }
  let resolvedCommand = command;
  if (command.startsWith('./')) {
    const abs = path.resolve(ctx.pluginRoot, command);
    if (!contains(ctx.pluginRoot, abs)) return skip('stdio "command" escapes the plugin directory');
    resolvedCommand = abs;
  } else if (command.includes('/') || command.includes('\\')) {
    return skip('stdio "command" must be a bare executable name or begin with "./"');
  }

  if (entry.args !== undefined && !isStringArray(entry.args)) {
    return skip('stdio "args" must be an array of strings');
  }
  const args = (entry.args ?? []).map((a) => expand(a, vars));

  if (entry.env !== undefined && !isStringRecord(entry.env)) {
    return skip('stdio "env" must be an object of strings');
  }
  const rawEnv = (entry.env ?? {}) as Record<string, string>;
  for (const key of Object.keys(rawEnv)) {
    if (RESERVED_ENV.has(key)) {
      return skip(`stdio "env" must not define ${key} — the runtime supplies it`);
    }
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) env[k] = expand(v, vars);
  // Injected last, which is exactly why the two names are reserved above.
  env.PLUGIN_ROOT = ctx.pluginRoot;
  env.PLUGIN_DATA = ctx.pluginData;

  // Defaults to the plugin root (§7.2.1) and must stay inside one of the two
  // directories the plugin owns.
  const rawCwd = entry.cwd;
  if (rawCwd !== undefined && typeof rawCwd !== 'string') {
    return skip('stdio "cwd" must be a string');
  }
  let cwd = ctx.pluginRoot;
  if (typeof rawCwd === 'string') {
    const base = cwdBase(rawCwd, ctx);
    if (!base) {
      return skip('stdio "cwd" must be a "./" path, ${PLUGIN_ROOT} or ${PLUGIN_DATA}');
    }
    const abs = path.resolve(base, expand(rawCwd, vars));
    if (!contains(base, abs)) return skip('stdio "cwd" escapes the plugin directory');
    cwd = abs;
  }

  return { kind: 'stdio', name, command: resolvedCommand, args, env, cwd };
}

function resolveRemote(
  name: string,
  kind: 'http' | 'sse',
  entry: Record<string, unknown>,
  skip: (reason: string) => null,
  warnings: string[],
): ResolvedServer | null {
  const unknown = unknownFields(entry, REMOTE_FIELDS);
  if (unknown.length > 0) {
    return skip(
      `${kind} configuration has unsupported field(s) ${unknown.join(', ')} — ` +
        `remove them (allowed: ${[...REMOTE_FIELDS].join(', ')})`,
    );
  }
  if (typeof entry.url !== 'string' || entry.url.length === 0) {
    return skip('"url" must be a non-empty string');
  }

  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return skip('"url" must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return skip('"url" must use http or https');
  }
  if (url.username || url.password) return skip('"url" must not contain user information');
  if (url.hash) return skip('"url" must not contain a fragment');
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return skip('a non-loopback "url" must use https');
  }

  if (entry.headers !== undefined && !isStringRecord(entry.headers)) {
    return skip('"headers" must be an object of strings');
  }
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries((entry.headers ?? {}) as Record<string, string>)) {
    const lower = key.toLowerCase();
    if (!HEADER_NAME_RE.test(key)) {
      warnings.push(`MCP server "${name}": ignoring invalid header name "${key}"`);
      continue;
    }
    if (seen.has(lower)) {
      warnings.push(`MCP server "${name}": ignoring duplicate header "${key}"`);
      continue;
    }
    if (CLIENT_OWNED_HEADERS.has(lower)) {
      // Spec: headers are visible package data, not a credential channel.
      warnings.push(`MCP server "${name}": ignoring header "${key}" — the runtime owns it`);
      continue;
    }
    seen.add(lower);
    headers[key] = value;
  }

  return { kind, name, url: entry.url, headers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One non-recursive pass. `String.replace` never rescans the text it inserts, so
 * a value that expands to the literal characters `${PLUGIN_DATA}` stays literal
 * — which is precisely the behaviour §9.2 requires. Any other `${...}` is left
 * alone, since a server may legitimately want that text.
 */
function expand(value: string, vars: Record<string, string>): string {
  return value.replace(PLACEHOLDER_RE, (_match, key: string) => vars[key]);
}

/** Which directory a `cwd` is anchored to, or null when it is anchored to neither. */
function cwdBase(cwd: string, ctx: McpParseContext): string | null {
  if (cwd.startsWith('./')) return ctx.pluginRoot;
  if (cwd === '${PLUGIN_ROOT}' || cwd.startsWith('${PLUGIN_ROOT}/')) return ctx.pluginRoot;
  if (cwd === '${PLUGIN_DATA}' || cwd.startsWith('${PLUGIN_DATA}/')) return ctx.pluginData;
  return null;
}

/**
 * Whether `target` stays within `base`. Compared lexically first, then again
 * through `realpath` when both paths exist — so a symlink planted inside the
 * plugin cannot point a subprocess somewhere else. `PLUGIN_DATA` is created
 * just before launch, so a not-yet-existing path is checked lexically only.
 */
function contains(base: string, target: string): boolean {
  if (!within(path.resolve(base), path.resolve(target))) return false;
  try {
    return within(fs.realpathSync(base), fs.realpathSync(target));
  } catch {
    return true; // one of them doesn't exist yet — the lexical check stands
  }
}

function within(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * The keys of `entry` that aren't in `allowed`, sorted.
 *
 * Named in the diagnostic rather than counted: "contains unknown fields" tells
 * an author their server was skipped but not what to delete, which leaves them
 * comparing their file to a spec by eye.
 */
function unknownFields(entry: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(entry)
    .filter((k) => !allowed.has(k))
    .sort();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string');
}
