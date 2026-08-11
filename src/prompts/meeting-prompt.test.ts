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
    expect(text).toMatch(/and staging\?/i);
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
