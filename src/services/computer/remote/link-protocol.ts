/**
 * The computer link, version 1: what a remote computer's client and the runtime say to
 * each other on `/api/computer-link`. `docs/computer-link-protocol.md` is the contract
 * for client authors; these schemas are where the runtime reads it.
 *
 * Text frames are JSON-RPC 2.0, one message each, with requests in both directions.
 * Binary frames carry the screen stream.
 */

import { z } from 'zod';

export const COMPUTER_LINK_PATH = '/api/computer-link';
export const LINK_PROTOCOL_VERSION = 1;

/** The largest frame either side sends: a full-size PNG of a large screen, as base64. */
export const MAX_LINK_FRAME_BYTES = 16 * 1024 * 1024;

/** The first byte of a binary frame; the second holds flags. */
export const LINK_JPEG_FRAME = 0x01;
export const LINK_VIDEO_FRAME = 0x03;
/** Flag bit 0 of a video frame: the picture stands on its own. */
export const LINK_KEYFRAME_FLAG = 0x01;

/** Close codes, each with what the client does next (see the protocol doc). */
export const LINK_CLOSE = {
  shuttingDown: 1001,
  protocolError: 4400,
  removed: 4403,
  replaced: 4409,
  unsupportedVersion: 4426,
} as const;

export const PLATFORMS = ['macos', 'windows', 'linux'] as const;
export type RemotePlatform = (typeof PLATFORMS)[number];

export const CAPABILITIES = ['screen', 'input', 'windows', 'elements', 'stream'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Why the client refused a request, in `error.data.reason`. */
export type LinkErrorReason =
  | 'permission_denied'
  | 'unsupported'
  | 'held'
  | 'busy'
  | 'invalid_params'
  | 'internal';

const displaySchema = z.object({
  id: z.string().min(1).max(100),
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  scale: z.number().positive().max(8).default(1),
  primary: z.boolean().default(false),
});
export type RemoteDisplay = z.infer<typeof displaySchema>;

/** A capability the client names that this runtime does not know is left out, not refused. */
const capabilitiesSchema = z
  .array(z.string().max(50))
  .max(50)
  .transform((names) =>
    names.filter((name): name is Capability => (CAPABILITIES as readonly string[]).includes(name)),
  );

const problemSchema = z.object({
  capability: z.string().max(50),
  message: z.string().max(500),
});
export type CapabilityProblem = z.infer<typeof problemSchema>;

export const initializeParams = z.object({
  protocolVersion: z.number().int(),
  // The version reaches telemetry, so it is a version and no other text.
  client: z.object({ name: z.string().min(1).max(100), version: z.string().regex(/^[\w.+-]{1,50}$/) }),
  platform: z.enum(PLATFORMS),
  displays: z.array(displaySchema).min(1).max(16),
  capabilities: capabilitiesSchema,
  problems: z.array(problemSchema).max(50).default([]),
});
export type InitializeParams = z.infer<typeof initializeParams>;

export const displaysChangedParams = z.object({ displays: z.array(displaySchema).min(1).max(16) });

export const capabilitiesChangedParams = z.object({
  capabilities: capabilitiesSchema,
  problems: z.array(problemSchema).max(50).default([]),
});

export const captureResult = z.object({
  mediaType: z.enum(['image/jpeg', 'image/png']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.string().min(1),
});

export const windowsResult = z.object({
  windows: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string().max(1000),
        app: z.string().max(200).default(''),
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        focused: z.boolean().default(false),
        minimized: z.boolean().default(false),
      }),
    )
    .max(500),
});

export const elementsResult = z.object({
  elements: z
    .array(
      z.object({
        app: z.string().max(200).default(''),
        // An AT-SPI role name; Prism acts on those in `ACTIONABLE_ROLES` and ignores the rest.
        role: z.string().max(100),
        name: z.string().max(1000),
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
    )
    .max(5000),
});

export const streamStartResult = z.object({
  encoding: z.enum(['h264', 'jpeg']),
  codec: z.string().max(100).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const emptyResult = z.object({});

const id = z.union([z.number().int(), z.string().max(100)]);

/**
 * One JSON-RPC 2.0 message, read loosely enough to tell its kind apart. An error is tried
 * before a result, since `z.unknown()` also accepts a missing `result`.
 */
export const rpcMessage = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id, method: z.string().max(100), params: z.unknown().optional() }),
  z.object({ jsonrpc: z.literal('2.0'), method: z.string().max(100), params: z.unknown().optional() }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: id.nullable(),
    error: z.object({
      code: z.number().int(),
      message: z.string().max(2000),
      data: z.unknown().optional(),
    }),
  }),
  z.object({ jsonrpc: z.literal('2.0'), id, result: z.unknown() }),
]);

/** The JSON-RPC 2.0 error codes the runtime answers with. */
export const RPC_ERROR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;
