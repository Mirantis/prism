import { describe, it, expect } from 'vitest';
import { getMeetingBackendInstructions, getMeetingVoiceInstructions } from './meeting-prompt';

const base = { agentName: 'Prism', platform: 'Google Meet' };

/**
 * The prompt is hard-wrapped, so a phrase longer than a few words straddles a line
 * break. Matching the single-line form keeps an assertion about wording from turning
 * red when the wording moves to another column.
 */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('getMeetingVoiceInstructions', () => {
  it('names the agent and the platform it is on', () => {
    const text = getMeetingVoiceInstructions(base);
    expect(text).toContain('**Prism**');
    expect(text).toContain('Google Meet');
  });

  it('asks for speech that is brief and keeps moving', () => {
    const text = flat(getMeetingVoiceInstructions(base));
    expect(text).toMatch(/one sentence, two at most/i);
    expect(text).toMatch(/ten to twenty-five words/i);
    expect(text).toMatch(/don't trail off or pause mid-thought/i);
  });

  it('stays quiet unless it is spoken to, with no backchannel between other people', () => {
    // The voice takes its own turns, so this rule is the whole of what keeps it out of
    // a conversation between two other people.
    const text = flat(getMeetingVoiceInstructions(base));
    expect(text).toMatch(/Most of what you hear is not for you/i);
    expect(text).toMatch(/addresses you by name/i);
    expect(text).toMatch(/keep listening and say nothing/i);
    expect(text).toMatch(/no "mm-hmm" while other people talk to each other/i);
  });

  it('uses the names it is told and never guesses one', () => {
    const text = flat(getMeetingVoiceInstructions(base));
    expect(text).toMatch(/You are told who is speaking/i);
    expect(text).toMatch(/never guess one/i);
    expect(text).toMatch(/may mishear/i);
  });

  it('lists what the backend can do, so it hands a request over rather than refusing it', () => {
    // Told nothing, the voice model answered "I can't see your screen" on its own.
    const text = flat(getMeetingVoiceInstructions(base));
    expect(text).toMatch(/Your backend is you, doing the work/i);
    expect(text).toMatch(/look at your screen and share it with the room/i);
    expect(text).toMatch(/turn your microphone off or on/i);
    expect(text).toMatch(/leave the call/i);
    expect(text).toMatch(/Never say you cannot do something without handing it over first/i);
  });

  it('says something while the backend works, and leads with the answer after', () => {
    const text = flat(getMeetingVoiceInstructions(base));
    expect(text).toMatch(/Say something while it works/i);
    expect(text).toMatch(/Vary the phrasing/i);
    expect(text).toMatch(/Then lead with the answer/i);
    expect(text).toMatch(/never fill the gap with what you expected/i);
  });

  it('puts a link or a command in the call chat rather than reading it out', () => {
    expect(flat(getMeetingVoiceInstructions(base))).toMatch(/in the call's chat/i);
  });

  it('confirms in the room before anything lasting is handed over', () => {
    const text = flat(getMeetingVoiceInstructions(base));
    expect(text).toMatch(/deletes, deploys, spends money, grants access/i);
    expect(text).toMatch(/explicit "yes" in the room/i);
    expect(text).toMatch(/Never read that permission out of enthusiasm/i);
  });

  it('numbers its rules without a gap', () => {
    const numbers = [...getMeetingVoiceInstructions(base).matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it('frames the call as a channel rather than a persona', () => {
    const text = getMeetingVoiceInstructions(base);
    expect(text).toMatch(/channel, not an identity/i);
    expect(text).toMatch(/never introduce or describe yourself as a voice assistant/i);
  });
});

describe('getMeetingBackendInstructions', () => {
  it('names the agent and the platform, and says its words are spoken', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toContain('Prism');
    expect(text).toContain('Google Meet');
    expect(text).toMatch(/the voice says out loud to everyone in the room/i);
  });

  it('asks for speech, not formatting', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/no markdown/i);
    expect(text).toMatch(/One or two short sentences/i);
  });

  it('says what to do when a tool fails, rather than leaving it to be inferred', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/When a tool fails, say so/i);
    expect(text).toMatch(/Never fill the gap with what you expected/i);
    expect(text).toMatch(/Do not run the same call again unchanged/i);
  });

  it('tells the model it really does have the destructive tools here', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/everything else in your toolset works here/i);
    expect(text).toMatch(/including the destructive parts/i);
  });

  it('tells the model it can hand one line to the call chat, and what for', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/`send_meeting_chat`/);
    expect(text).toMatch(/a link, an identifier, a command to paste/i);
    expect(text).toMatch(/Never post the answer you should be speaking/i);
    expect(text).toMatch(/say the content out loud instead/i);
  });

  it('tells the model it can read the chat, and that somebody has to ask', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/`read_meeting_chat`/);
    expect(text).toMatch(/nothing tells you a message has arrived/i);
    expect(text).toMatch(/asks you to look/i);
    expect(text).toMatch(/who typed it/i);
  });

  it('tells the model what its screen can do, and what drives it', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/share_screen/);
    expect(text).toMatch(/whole screen your browser is on/i);
    expect(text).toMatch(/stop_screen_share/);
    expect(text).toMatch(/one command at a time/i);
    expect(text).toMatch(/see_screen/);
  });

  it('tells the model nothing else leaves the call, and never to offer it', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/nothing else reaches anyone from here/i);
    expect(text).toMatch(/never offer to/i);
    expect(text).toMatch(/not to Slack, not to a chat session/i);
    expect(text).toMatch(/neither is a line you post in its chat/i);
    expect(text).toMatch(/No "I'll drop that in the chat afterwards"/i);
    expect(text).toMatch(/a promise you cannot keep/i);
  });

  it('tells it to schedule work it was asked for and cannot finish in the call', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/needs more time than the room has/i);
    expect(text).toMatch(/`schedule_task` to run it once/);
    expect(text).toMatch(/the run reports what it found/i);
    expect(text).toMatch(/counts as nothing to report and stays unsent/i);
    expect(text).toMatch(/the answer arrives in their chat/i);
    expect(text).toMatch(/by the time it runs, the call is usually over/i);
    expect(text).toMatch(/as arranged, never as done/i);
  });

  it('asks for the two schedule forms the runtime reads as a single run', () => {
    // `parseSchedule` treats only "in X <unit>" and "at H[:MM]" as one-shot; anything
    // else it hands to cron as a repeating expression.
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/"in twenty minutes" or "at four"/i);
    expect(text).toMatch(/a cadence like "every morning" reports over and over/i);
  });

  it('needs no second yes to schedule, but one for destructive deferred work', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/separate "yes" for that: the request is the agreement/i);
    expect(text).toMatch(/Scheduling a follow-up \(6\) is outside this list/i);
    expect(text).toMatch(/before you schedule anything on that list/i);
  });

  it('names one scheduler, and no thread option', () => {
    const text = getMeetingBackendInstructions(base);
    expect(text).not.toMatch(/create_goal/);
    expect(text).not.toMatch(/continueInThread/i);
  });

  it('keeps the rule numbers its own cross-references cite', () => {
    const text = getMeetingBackendInstructions(base);
    expect(text).toMatch(/^6\. \*\*Schedule work you were asked for/m);
    expect(text).toMatch(/^7\. \*\*You can show the room your screen/m);
    expect(text).toMatch(/and only there \(7\)/);
    expect(text).toMatch(/schedule the work \(6\)/);
  });

  it('acts on a lasting request only once the transcript shows a yes', () => {
    // No code-level filter guards a meeting, so this instruction is the boundary.
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/not an authenticated channel/i);
    expect(text).toMatch(/deletes, deploys, spends money, grants access/i);
    expect(text).toMatch(/the transcript must show an explicit "yes" from the room/i);
    expect(text).toMatch(/write the question instead of calling the tool/i);
    expect(text).toMatch(/Never infer that permission/i);
  });

  it('puts self-configuration under the confirmation rule rather than off limits', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/changes your own configuration/i);
    expect(text).toMatch(/renaming yourself, rewriting your Soul/i);
  });

  it('never tells the model to turn a request down', () => {
    const both = getMeetingBackendInstructions(base) + getMeetingVoiceInstructions(base);
    expect(both).not.toMatch(/\b(refuse|refuses|decline|declines)\b/i);
  });

  it('tells the model the microphone is its own to open and close', () => {
    const text = flat(getMeetingBackendInstructions(base));
    expect(text).toMatch(/`set_microphone`/);
    expect(text).toMatch(/nobody asked for quiet, turn it back on/i);
    expect(text).toMatch(/`isMicLive`/);
  });

  it('tells it to actually call leave_meeting rather than just announce leaving', () => {
    expect(getMeetingBackendInstructions(base)).toMatch(/call `leave_meeting`/);
  });

  it('adapts to another platform without code changes', () => {
    const input = { ...base, platform: 'Microsoft Teams' };
    for (const text of [getMeetingVoiceInstructions(input), getMeetingBackendInstructions(input)]) {
      expect(text).toContain('Microsoft Teams');
      expect(text).not.toContain('Google Meet');
    }
  });
});
