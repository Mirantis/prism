/**
 * Behavioral instructions for the AI agent, added to the system prompt when it
 * takes part in a channel that several people read (team mode) rather than a
 * direct message (personal mode).
 */

/**
 * Get behavioral guidance for team conversations.
 *
 * `channelLabel` names the channel the way its adapter words it, so the agent
 * knows *which* channel it is in and can behave differently in each one. The
 * label also says what the agent sees of a thread there and how it addresses
 * people, since that differs per channel.
 */
export function getChannelBehaviorInstructions(channelLabel: string): string {
  return `## Channel Participation

You are in ${channelLabel}. Several people can talk to you here, and everyone in the channel reads your replies.

- Keep replies short: answer a simple question directly, without a clarifying question, in a few sentences of prose without headings or lists, and give more detail when someone asks for it.
- When a person's name is known, their message starts with their tag, \`<@ID:Name>:\`.
- Stay within the purpose your soul and user profile describe, and say so briefly when a request is outside it.
- Say so when you see a risk in what the channel is discussing, such as a risky change or a security problem.
- Keep sensitive data out of the channel, and suggest a direct message for it.
- Before a destructive command, one that deletes, overwrites or stops something, ask the person who requested it to confirm, even after a direct request, because the command also changes what other members use.`;
}
