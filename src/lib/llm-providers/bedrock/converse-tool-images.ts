import type { LanguageModelMiddleware } from "ai";

type Prompt = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];
type Message = Prompt[number];
type UserPart = Extract<Message, { role: "user" }>["content"][number];

const MOVED_NOTE = "The image from this result follows in the next message.";

/**
 * Moves each image in a tool result into a user message placed directly after it.
 *
 * Converse reads an image inside a `toolResult` from Claude and Nova models only, and reads
 * it from every model as a user content block. The SDK joins the `tool` message and the `user` message after it into one Converse user turn, so
 * the image stays beside the result it belongs to. The rewrite depends on the message
 * alone, so the prompt prefix stays identical from turn to turn.
 */
export const converseToolImages: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    prompt: params.prompt.flatMap(moveToolImages),
  }),
};

function moveToolImages(message: Message): Message[] {
  if (message.role !== "tool") return [message];
  const images: UserPart[] = [];
  const content = message.content.map((part) => {
    if (part.type !== "tool-result" || part.output.type !== "content")
      return part;
    const value = part.output.value.map((item) => {
      if (item.type !== "file" || !item.mediaType.startsWith("image/"))
        return item;
      images.push({ type: "text", text: `Image from ${part.toolName}:` });
      images.push({ type: "file", data: item.data, mediaType: item.mediaType });
      return { type: "text" as const, text: MOVED_NOTE };
    });
    return { ...part, output: { ...part.output, value } };
  });
  if (!images.length) return [message];
  return [
    { ...message, content },
    { role: "user", content: images },
  ];
}
