import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { config } from "../../../config";
import { createBedrockProvider } from "./bedrock-provider";

const JPEG = Buffer.from("fake jpeg bytes").toString("base64");

/** A computer tool's result as `toModelOutput` returns it: a reading and a screenshot. */
const SCREEN_TURN: ModelMessage[] = [
  { role: "user", content: "Look at the screen." },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "computer_screen",
        input: {},
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "computer_screen",
        output: {
          type: "content",
          value: [
            { type: "text", text: '{"success":true,"title":"Example"}' },
            {
              type: "file",
              mediaType: "image/jpeg",
              data: { type: "data", data: JPEG },
            },
          ],
        },
      },
    ],
  },
];

// Converse drops tool results from a request that declares no tools.
const tools = {
  computer_screen: tool({
    description: "Inspect the screen.",
    inputSchema: z.object({}),
  }),
};

/** The fields of a Converse or Anthropic Messages request body the assertions read. */
type RequestBody = {
  messages: Array<{
    role: string;
    content: Array<{
      type?: string;
      text?: string;
      image?: unknown;
      toolResult?: { content: unknown[] };
      content?: Array<{ type: string }>;
    }>;
  }>;
};

let requests: Array<{ url: string; body: RequestBody }>;

const region = config.awsRegion;

beforeEach(() => {
  config.awsRegion = "us-east-1";
  config.awsAccessKeyId = "test-key";
  config.awsSecretAccessKey = "test-secret";
  config.awsSessionToken = undefined;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const body = String(url).includes("/converse")
        ? {
            output: {
              message: { role: "assistant", content: [{ text: "ok" }] },
            },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }
        : {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  config.awsAccessKeyId = undefined;
  config.awsSecretAccessKey = undefined;
  config.awsRegion = region;
});

describe("converseToolImages", () => {
  it("sends a Converse model the screenshot beside the tool result, in the same user turn", async () => {
    await generateText({
      model: createBedrockProvider()("us.moonshotai.kimi-k3"),
      messages: SCREEN_TURN,
      tools,
    });

    const turn = requests[0].body.messages.at(-1);
    expect(turn.role).toBe("user");
    expect(turn.content).toHaveLength(3);
    expect(turn.content[0].toolResult?.content).toEqual([
      { text: '{"success":true,"title":"Example"}' },
      { text: "The image from this result follows in the next message." },
    ]);
    expect(turn.content[1]).toEqual({ text: "Image from computer_screen:" });
    expect(turn.content[2]).toEqual({
      image: { format: "jpeg", source: { bytes: JPEG } },
    });
  });

  it("leaves the screenshot inside the tool result for Claude", async () => {
    await generateText({
      model: createBedrockProvider()("us.anthropic.claude-opus-4-7"),
      messages: SCREEN_TURN,
      tools,
    });

    const turn = requests[0].body.messages.at(-1);
    expect(turn.content).toHaveLength(1);
    expect(turn.content[0].type).toBe("tool_result");
    expect(turn.content[0].content?.map((part) => part.type)).toEqual([
      "text",
      "image",
    ]);
  });
});
