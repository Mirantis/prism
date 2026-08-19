/**
 * Reading the room off Meet's participants panel.
 *
 * The probe bodies run against a real JSDOM document rather than a mock shaped like the
 * selectors they use — the same harness `provider.test.ts` uses, and for the same reason:
 * the failure this code actually has is Google moving the DOM, and a fake that answers
 * whatever the probe asks for cannot fail that way. JSDOM implements `MutationObserver`,
 * so the churn detection is exercised for real too.
 *
 * The markup is copied from live calls, including the details that look like noise: the
 * `data-participant-id` really is a `spaces/…/devices/…` path, the agent's own row really
 * does have `(You)` after its name, and a merged-audio cohort really does appear as an
 * extra row with no participant id whose meter is the one that moves.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Page } from 'playwright-core';
import {
  judgeSpeaker,
  namesFrom,
  openParticipants,
  readRoom,
  sharedMicrophoneNames,
  type RoomParticipant,
  type RoomReading,
} from '../participants';

/**
 * A page backed by one long-lived JSDOM document.
 *
 * Long-lived on purpose: the observer is installed on the first read and has to still be
 * there on the second, which is the whole mechanism. `MutationObserver` is swapped in
 * alongside `document` because the probe constructs one.
 */
async function room(html: string) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<body>${html}</body>`);
  const global = globalThis as unknown as Record<string, unknown>;

  const page = {
    async evaluate<A, T>(fn: (arg: A) => T, arg: A): Promise<T> {
      const previousDocument = global.document;
      const previousObserver = global.MutationObserver;
      global.document = dom.window.document;
      global.MutationObserver = dom.window.MutationObserver;
      try {
        return fn(arg);
      } finally {
        global.document = previousDocument;
        global.MutationObserver = previousObserver;
      }
    },
  } as unknown as Page;

  return { page, doc: dom.window.document };
}

/** Let JSDOM deliver the observer's records, which it does on a microtask. */
const delivered = () => new Promise((resolve) => setTimeout(resolve, 0));

const PANEL = `
  <div role="list" aria-label="Participants">
    <div role="listitem" aria-label="Iris" data-participant-id="spaces/_CtC/devices/244">
      <span>Iris(You)</span><div jscontroller="ES310d" class="IisKdb gjg47c"></div>
    </div>
    <div role="listitem" aria-label="Mario Sarcher" data-participant-id="spaces/_CtC/devices/235">
      <span>Mario Sarcher</span><div jscontroller="ES310d" class="IisKdb gjg47c"></div>
    </div>
  </div>`;

/** The same room with the two humans in it merged into one stream. */
const MERGED_PANEL = `
  <div role="list" aria-label="Participants">
    <div role="listitem" aria-label="Iris" data-participant-id="spaces/_CtC/devices/244">
      <span>Iris(You)</span><div jscontroller="ES310d" class="IisKdb gjg47c"></div>
    </div>
    <div role="listitem" aria-label="Merged audio">
      <span>Merged audio</span><div jscontroller="ES310d" class="IisKdb gjg47c"></div>
    </div>
    <div role="listitem" aria-label="Mario Sarcher" data-participant-id="spaces/_CtC/devices/235">
      <span>Mario Sarcher</span>
    </div>
  </div>`;

afterEach(() => {
  // Both of these are per-call state the probe keeps on the page's global, and each test is
  // a new call with a new document. Leaving `__prismPanel` behind carried one test's
  // fruitless-click count into the next one.
  const global = globalThis as unknown as Record<string, unknown>;
  delete global.__prismRoom;
  delete global.__prismPanel;
});

describe('readRoom', () => {
  it('answers null when the panel is not open', async () => {
    // Measured live: with the panel shut the list is not in the page at all, which is why
    // opening it is mandatory rather than an optimisation.
    const { page } = await room('<div>call in progress</div>');
    expect(await readRoom(page)).toBeNull();
  });

  it('reads each row as an identity, a name, and whether it is the agent', async () => {
    const { page } = await room(PANEL);
    const reading = await readRoom(page);

    expect(reading?.participants).toEqual([
      {
        id: 'spaces/_CtC/devices/244',
        name: 'Iris',
        isSelf: true,
        isGroup: false,
        hasMeter: true,
        meterHitsMsAgo: [],
      },
      {
        id: 'spaces/_CtC/devices/235',
        name: 'Mario Sarcher',
        isSelf: false,
        isGroup: false,
        hasMeter: true,
        meterHitsMsAgo: [],
      },
    ]);
    expect(reading?.activity).toBe('per-person');
    // Iris is the agent's own row, and the roster is the *other* people.
    expect(namesFrom(reading)).toEqual(['Mario Sarcher']);
  });

  it('reads a merged cohort as a group, and the people inside it as unmetered', async () => {
    // Not a failure. Meet is mixing the room into one stream, so one group identity is the
    // true answer — the members' own meters go still and the cohort's moves instead.
    const { page } = await room(MERGED_PANEL);
    const reading = await readRoom(page);

    expect(reading?.activity).toBe('merged');
    expect(reading?.participants.find((p) => p.name === 'Merged audio')).toMatchObject({
      isGroup: true,
      id: 'Merged audio',
    });
    expect(reading?.participants.find((p) => p.name === 'Mario Sarcher')).toMatchObject({
      isGroup: false,
    });
    // The roster still names the people: only attribution collapses, not the membership.
    // And the cohort's label is not one of them — fed to the transcriber it would bias
    // recognition toward the phrase, and handed to the model it would invite the agent to
    // talk to somebody who does not exist.
    expect(namesFrom(reading)).toEqual(['Mario Sarcher']);
  });

  it('lists a person once, however many rows the panel gives them', async () => {
    // Measured on a live merged-audio call: the same person appeared on two rows, and both
    // names reached the transcriber's keyword list — two of its twelve slots on one name, and
    // an extra participant reported to the model.
    const { page } = await room(`
      <div role="list" aria-label="Participants">
        <div role="listitem" aria-label="Maximilian Greis" data-participant-id="d/1"></div>
        <div role="listitem" aria-label="maximilian greis" data-participant-id="d/2"></div>
        <div role="listitem" aria-label="Jari" data-participant-id="d/3"></div>
      </div>`);

    // First spelling wins, as the tile-and-menu-label reading before it did.
    expect(namesFrom(await readRoom(page))).toEqual(['Maximilian Greis', 'Jari']);
  });

  it('reports attribution unavailable when no row has a meter', async () => {
    const { page } = await room(`
      <div role="list" aria-label="Participants">
        <div role="listitem" aria-label="Iris" data-participant-id="d/1"><span>Iris(You)</span></div>
      </div>`);

    expect((await readRoom(page))?.activity).toBe('unavailable');
  });

  it('records a meter churning, and only the row it churned in', async () => {
    const { page, doc } = await room(PANEL);
    await readRoom(page); // installs the observer

    const mario = doc.querySelector('[aria-label="Mario Sarcher"] [jscontroller="ES310d"]')!;
    mario.setAttribute('class', 'IisKdb Oaajhc');
    mario.setAttribute('class', 'IisKdb wEsLMd');
    await delivered();

    const reading = await readRoom(page);
    const rows = Object.fromEntries(reading!.participants.map((p) => [p.name, p]));
    expect(rows['Mario Sarcher'].meterHitsMsAgo.length).toBe(2);
    expect(rows['Iris'].meterHitsMsAgo).toEqual([]);
  });

  it('ignores a class change that is not the meter', async () => {
    // `childList` is deliberately not observed and the meter has to be on the path from the
    // mutated node up to the row. A row re-rendering because somebody joined would
    // otherwise read as that person speaking, which is the one failure direction that
    // attributes an exchange to the wrong person.
    const { page, doc } = await room(PANEL);
    await readRoom(page);

    doc.querySelector('[aria-label="Mario Sarcher"]')!.setAttribute('class', 'reordered');
    await delivered();

    expect((await readRoom(page))!.participants.every((p) => p.meterHitsMsAgo.length === 0)).toBe(
      true,
    );
  });

  it('re-installs the observer when Meet has replaced the list', async () => {
    const { page, doc } = await room(PANEL);
    await readRoom(page);

    // An observer attached to a detached node keeps its callback and never fires again, so
    // trusting the previous install would report a silent room for the rest of the call.
    doc.body.innerHTML = PANEL;
    await readRoom(page);

    const meter = doc.querySelector('[aria-label="Mario Sarcher"] [jscontroller="ES310d"]')!;
    meter.setAttribute('class', 'a');
    meter.setAttribute('class', 'b');
    await delivered();

    const reading = await readRoom(page);
    expect(reading!.participants.find((p) => p.name === 'Mario Sarcher')!.meterHitsMsAgo.length)
      .toBeGreaterThanOrEqual(2);
  });

  it('answers null rather than hanging when the page cannot answer', async () => {
    const wedged = { evaluate: () => new Promise(() => {}) } as unknown as Page;
    await expect(readRoom(wedged)).resolves.toBeNull();
  }, 10_000);
});

describe('openParticipants', () => {
  it('clicks the People control, which has its name as text', async () => {
    // Measured live: the control has no aria-label of its own, and its text is the label
    // plus a count badge — "People2".
    const { page, doc } = await room(
      '<div role="button"><span>People</span><div>2</div></div>',
    );
    let clicked = false;
    doc.querySelector('[role="button"]')!.addEventListener('click', () => {
      clicked = true;
    });

    await openParticipants(page);
    expect(clicked).toBe(true);
  });

  it('does nothing when the panel is already open', async () => {
    // Idempotent by construction rather than by bookkeeping: the list's presence is the
    // test, so the retry the runtime keeps making costs one DOM query.
    const { page, doc } = await room(`${PANEL}<div role="button"><span>People</span></div>`);
    let clicked = false;
    doc.querySelector('[role="button"]')!.addEventListener('click', () => {
      clicked = true;
    });

    await openParticipants(page);
    expect(clicked).toBe(false);
  });

  it('stops clicking once the control has opened no list three times', async () => {
    // The control is a toggle, so a click that produces no list is worse than useless: on the
    // next retry it closes whatever the last one opened, and the runtime spends the call
    // flicking a live control. Reachable if Google renames the list while leaving the control
    // findable by jsname.
    const { page, doc } = await room('<div role="button" jsname="ocqpFe">Menschen</div>');
    let clicks = 0;
    doc.querySelector('[role="button"]')!.addEventListener('click', () => {
      clicks += 1;
    });

    for (let i = 0; i < 6; i++) await openParticipants(page);
    expect(clicks).toBe(3);
  }, 20_000);

  it('never rejects when the page cannot be read', async () => {
    const broken = { evaluate: () => Promise.reject(new Error('Target closed')) } as unknown as Page;
    await expect(openParticipants(broken)).resolves.toBeUndefined();
  });
});

/**
 * The whole decision, and the whole test burden — everything the page does is arithmetic.
 */
describe('judgeSpeaker', () => {
  const row = (name: string, meterHitsMsAgo: number[], extra: Partial<RoomParticipant> = {}) => ({
    id: `d/${name}`,
    name,
    isSelf: false,
    isGroup: false,
    hasMeter: true,
    meterHitsMsAgo,
    ...extra,
  });
  const reading = (participants: RoomParticipant[], activity: RoomReading['activity'] = 'per-person') =>
    ({ participants, activity }) satisfies RoomReading;

  it('names the row whose meter is moving', () => {
    expect(judgeSpeaker(reading([row('Iris', []), row('Mario', [40, 300])]))).toEqual({
      id: 'd/Mario',
      name: 'Mario',
      isSelf: false,
      isGroup: false,
    });
  });

  it('treats a single transition as a state change, not speech', () => {
    // Muting swaps the meter for an icon and changes its class exactly once. Speech
    // churns, so one transition must not name somebody.
    expect(judgeSpeaker(reading([row('Mario', [40])]))).toBeNull();
  });

  it('declines when two rows are talking at once', () => {
    // One mixed channel: an overlapping utterance belongs to either of them, and a coin
    // flip would arm an exchange for the wrong person. Silence is the safe direction.
    expect(judgeSpeaker(reading([row('Iris', [30, 200]), row('Mario', [60, 250])]))).toBeNull();
  });

  it('names the fresher of two rows once they are clearly apart', () => {
    const verdict = judgeSpeaker(reading([row('Iris', [30, 200]), row('Mario', [700, 900])]));
    expect(verdict?.name).toBe('Iris');
  });

  it('declines a meter that stopped moving a while ago', () => {
    expect(judgeSpeaker(reading([row('Mario', [3_000, 3_200])]))).toBeNull();
  });

  it('declines when the platform offers no meters at all', () => {
    expect(judgeSpeaker(reading([row('Mario', [40, 300])], 'unavailable'))).toBeNull();
  });

  it('reports the agent itself rather than nobody', () => {
    // "That was me" and "I cannot tell" are different answers. A caller that folds them
    // together keeps naming a stale human for as long as the agent is speaking.
    const verdict = judgeSpeaker(reading([row('Iris', [40, 300], { isSelf: true })]));
    expect(verdict).toMatchObject({ name: 'Iris', isSelf: true });
  });

  it('reports a merged cohort as a group, and names who shares the microphone', () => {
    // Measured live: while a cohort row is present its members keep their rows but lose their
    // meters, so the meterless rows are exactly the people sharing the microphone. Naming them
    // is more use to the room than Meet's own label for the group row.
    const verdict = judgeSpeaker(
      reading(
        [
          row('Merged audio', [40, 300], { isGroup: true }),
          row('Jari', [], { hasMeter: false }),
          row('Mario Sarcher', [], { hasMeter: false }),
          row('Prismith', []),
        ],
        'merged',
      ),
    );
    expect(verdict).toMatchObject({ name: 'Merged audio', isGroup: true });
    // Prismith has a meter of his own, so he is in the room but not in the cohort.
    expect(verdict?.members).toEqual(['Jari', 'Mario Sarcher']);
  });

  it('names nobody as sharing a microphone when nothing is merged', () => {
    expect(sharedMicrophoneNames(reading([row('Jari', [40, 300])]))).toEqual([]);
    expect(sharedMicrophoneNames(null)).toEqual([]);
  });
});
