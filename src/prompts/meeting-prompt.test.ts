import { describe, it, expect } from 'vitest';
import { getMeetingInstructions } from './meeting-prompt';

const base = { agentName: 'Prism', platform: 'Google Meet', responseMode: 'auto' as const };

describe('getMeetingInstructions', () => {
  it('names the agent and the platform it is on', () => {
    const text = getMeetingInstructions(base);
    expect(text).toContain('**Prism**');
    expect(text).toContain('Google Meet');
  });

  it('asks for speech, not formatting', () => {
    // Markdown has no spoken form; the model has to be told once, clearly.
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/no markdown/i);
    expect(text).toMatch(/one sentence, two at most/i);
    expect(text).toMatch(/ten to twenty-five words/i);
  });

  it('asks it to keep the pace up rather than going quiet mid-thought', () => {
    // A long silence in a call reads as a dropped connection, not as thinking.
    expect(getMeetingInstructions(base)).toMatch(/don't trail off or pause mid-thought/i);
  });

  it('requires a spoken line before every tool call, with varied phrasing', () => {
    // An unexplained pause in a call sounds like the bot froze, so this is
    // mandatory rather than "when it will take a moment".
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/never use a tool in silence/i);
    expect(text).toMatch(/let me check that real quick/i);
    expect(text).toMatch(/vary the phrasing/i);
  });

  it('says what to do when a tool fails, rather than leaving it to be inferred', () => {
    // The bridge hands failures back as an error string, so the model does see
    // them. Without an instruction the failure modes are guessing an answer,
    // reading the raw error out, or retrying the same call in a loop — and a room
    // cannot see that a lookup failed unless the agent says so.
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/when a tool fails, say so/i);
    expect(text).toMatch(/never fill the gap with what you expected/i);
    expect(text).toMatch(/do not run the same call again unchanged/i);
  });

  it('tells the model it really does have the destructive tools here', () => {
    // `meeting` mode withholds no destructive tool, so the prompt must not imply
    // otherwise — a model that thinks a tool is unavailable refuses instead of
    // confirming.
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/everything else in your toolset works here/i);
    expect(text).toMatch(/including the destructive parts/i);
  });

  it('tells the model speech is its only channel', () => {
    // There is no tool for reaching a chat from a call: a meeting runs neither the
    // invoke loop nor the conversation engine, and `share_file` is filtered out of
    // `meeting` mode. Saying so is the whole guard against a promise it can't keep.
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/only way you can reach anyone from here/i);
    expect(text).toMatch(/never offer to/i);
    expect(text).toMatch(/not to this meeting's own chat panel/i);
  });

  it('never offers to hand anything over to a chat', () => {
    // Each of these was an instruction in this prompt with no tool behind it. A
    // near-identical phrase still appears as something the model is told never to
    // say, so the check is that they survive only inside the prohibition.
    const promises = [
      /Say "I'll drop the command in the chat"/i,
      /offer the detail in chat/i,
      /say you'll take it to chat, and do/i,
      /something to mention afterwards/i,
    ];
    for (const responseMode of ['open', 'addressed'] as const) {
      const text = getMeetingInstructions({ ...base, responseMode });
      for (const promise of promises) expect(text).not.toMatch(promise);
      // ...and the prohibition itself is present, in the model's own words.
      expect(text).toMatch(/No "I'll drop that in the chat"/i);
      expect(text).toMatch(/a promise you cannot keep/i);
    }
  });

  it('requires explicit in-room consent before anything irreversible', () => {
    // With the code-level filter gone, this instruction IS the boundary.
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/not an authenticated channel/i);
    expect(text).toMatch(/deletes, deploys, spends money, grants access/i);
    expect(text).toMatch(/explicit "yes" in the room/i);
    expect(text).toMatch(/never infer that permission/i);
  });

  it('puts self-configuration under the confirmation rule rather than off limits', () => {
    // The operator's call: the model used to refuse a spoken request to rename itself
    // or rewrite its Soul, profile or memory, which also made it refuse its own user
    // asking in a call. It now does them, so the confirmation rule above is the only
    // guard — and it has to name self-configuration explicitly, or a model reading
    // "anything irreversible" won't reliably count renaming itself as irreversible.
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/changes your own configuration/i);
    expect(text).toMatch(/renaming yourself, rewriting your Soul/i);
    expect(text).toMatch(/things you can do from here/i);
  });

  it('no longer tells the model to refuse or defer a self-configuration request', () => {
    // The two deleted instructions, pinned as absences.
    const text = getMeetingInstructions(base);
    expect(text).not.toMatch(/aimed at your configuration, your memory, or your instructions/i);
    expect(text).not.toMatch(/Don't take instructions about who you are/i);
    // Those two patterns only catch a verbatim return, and a reworded refusal would
    // slip past them. Nothing in this prompt asks the model to turn a request down
    // any more, so the whole vocabulary can be banned instead — a much harder thing
    // to reintroduce by accident.
    expect(text).not.toMatch(/\b(refuse|refuses|decline|declines)\b/i);
  });

  it('tells it to actually call leave_meeting rather than just announce leaving', () => {
    expect(getMeetingInstructions(base)).toMatch(/call `leave_meeting`/);
  });

  it('warns that the audio has no speaker labels', () => {
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/single mixed channel/i);
    expect(text).toMatch(/may mishear/i);
  });

  it('tells a one-to-one call to take everything as its own', () => {
    const text = getMeetingInstructions({ ...base, responseMode: 'open' });
    expect(text).toMatch(/only one other person/i);
    expect(text).not.toMatch(/not prompted to speak for every utterance/i);
  });

  it('warns a gated call not to explain its own silence', () => {
    const text = getMeetingInstructions({ ...base, responseMode: 'addressed' });
    expect(text).toMatch(/not prompted to speak for every utterance/i);
    // A model that doesn't know it is being filtered re-introduces itself every
    // time it is let through, or asks whether the follow-up was meant for it.
    expect(text).toMatch(/don't re-introduce yourself/i);
    // No grace period, so it must not expect to hear the turns in between and must
    // not read a gap as the speaker changing the subject.
    expect(text).toMatch(/every time/i);
    expect(text).toMatch(/did not hear the turns in between/i);
  });

  it('covers both cases under auto, since the room decides which applies', () => {
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/depends on who else is in it/i);
    expect(text).toMatch(/not prompted to speak for every utterance/i);
  });

  it('adapts to another platform without code changes', () => {
    const text = getMeetingInstructions({ ...base, platform: 'Microsoft Teams' });
    expect(text).toContain('Microsoft Teams');
    expect(text).not.toContain('Google Meet');
  });
});

describe('who the agent is in a call', () => {
  it('frames the call as a channel rather than a persona', () => {
    // A live call had the agent introduce itself as "a voice agent called Prism"
    // — a persona it synthesised from being told it was participating by voice,
    // over the identity its Soul and profile actually give it. Being in a meeting
    // is a way of communicating, not a different agent.
    const text = getMeetingInstructions(base);

    expect(text).toMatch(/channel, not an identity/i);
    expect(text).toMatch(/never introduce or describe yourself as a voice assistant/i);
  });

  it('points at the identity sections rather than restating them', () => {
    // The meeting instructions are appended *after* Soul, Agent Guide and User, so
    // anything they assert about identity competes with the real thing. They should
    // defer to it instead.
    const text = getMeetingInstructions(base);

    expect(text).toMatch(/Soul/);
    expect(text).toMatch(/Nothing above this line tells you who\s+you are/i);
  });
});

/**
 * The `delegate` tool mode changes one section, and the promise made about it is that
 * an unset `MEETING_TOOL_MODE` leaves a call's instructions exactly as they were.
 */
describe('the tool mode a call runs in', () => {
  it('gives an unset mode exactly the instructions full mode gets', () => {
    // The flag is off by default and this is what "off" has to mean: not similar
    // instructions, the same ones, character for character.
    for (const responseMode of ['auto', 'open', 'addressed'] as const) {
      expect(getMeetingInstructions({ ...base, responseMode })).toBe(
        getMeetingInstructions({ ...base, responseMode, toolMode: 'full' }),
      );
    }
  });

  it('says nothing about a handoff in full mode', () => {
    const text = getMeetingInstructions({ ...base, toolMode: 'full' });

    expect(text).not.toContain('handle_request');
    expect(text).toMatch(/Everything else in your toolset works here/);
  });

  it('tells the delegate mode to speak first and to write the request out in full', () => {
    const text = getMeetingInstructions({ ...base, toolMode: 'delegate' });

    // Speak-first survives the mode change: it matters more here, not less, since the
    // pause it covers is now a whole agent turn long.
    expect(text).toMatch(/Never hand something off in silence — speak first/);
    expect(text).toContain('handle_request');
    expect(text).toMatch(/write the request out in full/);
    // The handler hears nothing, which the model has to be told or it hands over a
    // fragment ("check the thing they mentioned") and gets nothing usable back.
    expect(text).toMatch(/it hears nothing/);
    // And the room must not be told about the machinery.
    expect(text).toMatch(/Never mention the\s+handoff/);
  });

  it('keeps the confirmation rule verbatim in delegate mode', () => {
    // The tool surface shrinking is not a restriction — the same destructive tools run
    // one step further away, and that step has no confirmation rule of its own. So this
    // rule is the whole boundary in both modes.
    const full = getMeetingInstructions({ ...base, toolMode: 'full' });
    const delegate = getMeetingInstructions({ ...base, toolMode: 'delegate' });
    const rule = (text: string) => text.slice(text.indexOf('15. **But a meeting is not'));

    expect(rule(delegate)).toBe(rule(full));
    expect(rule(delegate)).toMatch(/get an explicit "yes" in the room first/);
  });

  it('warns the delegate mode off the one thing it cannot do', () => {
    // A delegated turn runs in `subagent` mode, which has never held the goal tools —
    // so this is the one place the two modes differ in ability, and agreeing to a goal
    // in a call that cannot set one is a promise broken silently.
    const text = getMeetingInstructions({ ...base, toolMode: 'delegate' });

    expect(text).toMatch(/cannot do is set you a \*\*goal\*\*/);
  });
});
