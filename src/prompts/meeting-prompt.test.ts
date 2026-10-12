import { describe, it, expect, vi } from 'vitest';
import * as cron from 'node-cron';

// `parseSchedule` lives beside the tool, which reaches the database and the scheduler.
vi.mock('../lib/prisma', () => ({ default: {}, prisma: {} }));
vi.mock('../services/cron-scheduler.service', () => ({ cronSchedulerService: {} }));

import { getMeetingInstructions } from './meeting-prompt';
import { parseSchedule } from '../tools/cron';

const base = { agentName: 'Prism', platform: 'Google Meet', responseMode: 'auto' as const };

/** Single-spaced text, so an assertion about wording does not depend on where a line breaks. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

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
    expect(getMeetingInstructions(base)).toMatch(/all your other tools work here, including the destructive ones/i);
  });

  it('keeps answers in speech and the call chat for one line', () => {
    // The one channel out of a call other than speech. It has to be named with its
    // purpose, or the model uses it as a second conversation and posts an answer where
    // the room is not listening. How to post, and what to do when a post fails, is the
    // tool's description.
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/`send_meeting_chat`/);
    expect(text).toMatch(/a link, an identifier, a command to paste/i);
    expect(text).toMatch(/never post an answer you should be speaking/i);
  });

  it('tells the model the chat reaches it only when it reads it, and what to do then', () => {
    // The read is a pull with nothing behind it, and speech is where the room hears
    // what it found.
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/reaches you only when you call `read_meeting_chat`/);
    expect(text).toMatch(/asks you to look/i);
    expect(text).toMatch(/say what you found out loud/i);
  });

  it('tells the model nothing else leaves the call', () => {
    // A meeting runs neither the invoke loop nor the conversation engine, and
    // `share_file` is filtered out of `meeting` mode. Saying so is the whole guard
    // against a promise it can't keep.
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/nothing else leaves the call/i);
    expect(text).toMatch(/never offer to/i);
    expect(text).toMatch(/not to Slack, not to a chat session/i);
    // Including that the chat line itself is not kept, so it is never offered as a
    // record of anything.
    expect(text).toMatch(/a line you post in its chat is not stored/i);
  });

  it('never offers to hand anything over to a chat elsewhere', () => {
    // Each of these was an instruction in this prompt with no tool behind it. A
    // near-identical phrase still appears as something the model is told never to
    // say, so the check is that they survive only inside the prohibition. The list is
    // the promises with no tool behind them; deferred work has one, and is covered by
    // its own test.
    const promises = [
      /Say "I'll drop the command in the chat"/i,
      /offer the detail in chat/i,
      /say you'll take it to chat, and do/i,
      /something to mention afterwards/i,
    ];
    for (const responseMode of ['open', 'addressed'] as const) {
      const text = getMeetingInstructions({ ...base, responseMode });
      for (const promise of promises) expect(text).not.toMatch(promise);
      // ...and the prohibition itself is present, in the model's own words. `afterwards`
      // is doing real work: the call's own chat is reachable, and a later one is not.
      expect(text).toMatch(/no "I'll drop that in the chat afterwards"/i);
      expect(text).toMatch(/a promise you cannot keep/i);
    }
  });

  it('tells it to schedule work it was asked for and cannot finish in the call', () => {
    // `schedule_task` is live in `meeting` mode, so deferring work is the one promise
    // of follow-through a call can keep. The instruction has to survive the
    // scheduled-run DELIVER/SUPPRESS gate, which suppresses a run with nothing to
    // say — so "write the instruction so the run reports back" is pinned, not implied.
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/needs more time than the room has/i);
    expect(text).toMatch(/`schedule_task` to run it once/);
    // Both kinds of deferred work, named in one clause: a room asks for research and
    // for changes, and a model reading only "work" defers one and improvises the other.
    expect(text).toMatch(/a question that needs digging or a change that needs writing/i);
    expect(text).toMatch(/the run reports what it found/i);
    expect(text).toMatch(/a run with nothing to report is not delivered/i);
    // Where the run's own answer lands, which is the user's chat. The room's chat panel
    // is not named as unreachable: `cron` mode keeps `send_meeting_chat`, so a run that
    // finds the call still live can post a line into it.
    expect(text).toMatch(/the answer arrives in their chat/i);
    expect(text).toMatch(/not in this room/i);
    expect(text).toMatch(/as arranged, never as done/i);
  });

  it('gives schedule examples that the scheduler reads the way the prompt says', () => {
    // `parseSchedule` reads digits only. An example it cannot read as one-shot becomes a
    // repeating cron expression, or an error, when the model copies it.
    const text = flat(getMeetingInstructions(base));
    const examples = text.match(
      /Write the schedule as "([^"]+)" or "([^"]+)"; a cadence such as "([^"]+)" reports over and over/,
    );
    expect(examples).not.toBeNull();
    const [, first, second, cadence] = examples!;
    for (const oneShot of [first, second]) expect(parseSchedule(oneShot).isOneShot).toBe(true);
    const repeating = parseSchedule(cadence);
    expect(repeating.isOneShot).toBe(false);
    expect(cron.validate(repeating.cronExpression)).toBe(true);
  });

  it('needs no second yes to schedule, but one for destructive deferred work', () => {
    // The request for the work is the consent to schedule it. The work itself is not
    // covered by that: nobody is in the room when the run happens, so a destructive
    // job is agreed before it goes on the calendar.
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/the request is the agreement/i);
    // The schedule bullet comes after the confirmation section, and the later of two
    // rules wins, so it names the exception too.
    expect(text).toMatch(/no separate "yes", unless the work is on the confirmation list/i);
    expect(text).toMatch(/work from this list does, before you schedule it/i);
  });

  it('names one scheduler, and no thread option', () => {
    // The prompt is read aloud by a realtime model: every option it names is latency
    // and a way to get it wrong. `create_goal` is available in a call too and is
    // deliberately unnamed; `continueInThread` would resume in the caller's thread
    // but is rejected for a repeating schedule, so the prompt stays on the plain
    // one-off path.
    const text = getMeetingInstructions(base);
    expect(text).not.toMatch(/create_goal/);
    expect(text).not.toMatch(/continueInThread/i);
  });

  it('requires explicit in-room consent before anything irreversible', () => {
    // With the code-level filter gone, this instruction IS the boundary. It also
    // narrows chat's "the request is your approval" for a call.
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/not an authenticated channel/i);
    expect(text).toMatch(/even an explicit request is not approval/i);
    expect(text).toMatch(/deletes, deploys, spends money, grants access/i);
    // Spoken, since the chat panel is in the room too and each line it returns is named.
    expect(text).toMatch(/explicit spoken "yes" in the room/i);
    expect(text).toMatch(/never infer that permission/i);
  });

  it('puts self-configuration under the confirmation rule rather than off limits', () => {
    // The operator's call: the model used to refuse a spoken request to rename itself
    // or rewrite its Soul, profile or memory, which also made it refuse its own user
    // asking in a call. It now does them, so the confirmation rule above is the only
    // guard — and it has to name self-configuration explicitly, or a model reading
    // "anything irreversible" won't reliably count renaming itself as irreversible.
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/changes your own configuration \(your name, your Soul/i);
    // Asked for one, the model answers with the question, not with the tool call.
    expect(text).toMatch(/do not call the tool yet/i);
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

  it('tells the model what a muted microphone means for what it says', () => {
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/`set_microphone`/);
    // The half a model cannot observe: a muted turn is answered into nothing, and it will
    // carry on as though the room had heard it.
    expect(text).toMatch(/nothing you say reaches the room/i);
    // A mute the room asked for is left alone; one the call imposed is the agent's to undo.
    expect(text).toMatch(/nobody in the room asked for quiet, turn it back on/i);
  });

  it('tells it to actually call leave_meeting rather than just announce leaving', () => {
    expect(getMeetingInstructions(base)).toMatch(/call `leave_meeting`/);
  });

  it('warns that the audio has no speaker labels and may be misheard', () => {
    const text = getMeetingInstructions(base);
    expect(text).toMatch(/no speaker labels/i);
    expect(text).toMatch(/never guess a name/i);
    expect(text).toMatch(/live audio garbles/i);
  });

  it('tells a one-to-one call to take everything as its own', () => {
    const text = getMeetingInstructions({ ...base, responseMode: 'open' });
    expect(text).toMatch(/only one other person/i);
    expect(text).not.toMatch(/prompted to speak only when someone calls you by name/i);
  });

  it('warns a gated call not to explain its own silence', () => {
    const text = flat(getMeetingInstructions({ ...base, responseMode: 'addressed' }));
    expect(text).toMatch(/prompted to speak only when someone calls you by name/i);
    // A model that doesn't know it is being filtered re-introduces itself every
    // time it is let through, or asks whether the follow-up was meant for it.
    expect(text).toMatch(/don't re-introduce yourself/i);
    // No grace period, so it must not expect to hear the turns in between and must
    // not read a gap as the speaker changing the subject.
    expect(text).toMatch(/every time/i);
    expect(text).toMatch(/did not hear the turns in between/i);
  });

  it('covers both cases under auto, since the room decides which applies', () => {
    const text = flat(getMeetingInstructions(base));
    expect(text).toMatch(/while only one other person is in the call/i);
    expect(text).toMatch(/prompted to speak only when someone calls you by name/i);
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
    expect(flat(getMeetingInstructions(base))).toMatch(/your Soul, Agent Guide and User sections describe/);
  });
});
