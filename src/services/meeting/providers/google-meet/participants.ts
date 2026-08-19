/**
 * Who is in the room, and which of them is talking — read from Meet's Participants panel.
 *
 * This replaced a caption scrape, and the reason is worth keeping. Meet already diarises
 * speech for its caption pane, so reading the speaker label off a caption line looked like
 * the obvious route to attribution. Three calls with real participants measured otherwise:
 *
 * - Two people in one room share a stream, and Meet captions them
 *   `"groupsMario Sarcher & 1 others"`. That matches nobody on the roster, so attribution
 *   silently stopped for both of them.
 * - Caption text lags speech by one to two seconds, which put a skew between the speaker
 *   snapshot and the words it was being compared against that no local code could close.
 * - A caption line and a fragment of a sentence are structurally identical, so telling them
 *   apart needed a roster cross-check that existed only to undo the ambiguity.
 *
 * The Participants panel has none of that. Every row has the person's name in its
 * `aria-label`, a per-device `data-participant-id` that is stable for the call, and a voice
 * meter whose class changes as they talk. No lag, no transcription in the path, and nothing
 * that depends on the room's language. A merged-audio cohort is *covered* rather than
 * broken: the members' meters go quiet and a cohort row's meter moves instead, so the answer
 * degrades to one correct group identity.
 *
 * Two things it costs, both real:
 *
 * - **The panel has to be open.** With it shut the list is not in the DOM at all — measured,
 *   not assumed — so `openParticipants` is mandatory rather than an optimisation, and a
 *   panel that will not open means no attribution.
 * - **`(You)` and the People control's label are English.** The browser profile is the
 *   agent's own Google account, so its display language is ours to set, but a profile in
 *   another language loses self-detection and the panel toggle. It degrades to no
 *   attribution rather than to wrong attribution.
 */

import type { Page } from 'playwright-core';
import { logger } from '../../../../logger';
import type { SpeakerReading } from '../../meeting-provider.interface';
import { withTimeout } from './with-timeout';

/**
 * The slice of the DOM these probes touch.
 *
 * Structural rather than the real `Document`, for the reason the count probe gives: this
 * runtime compiles against Node's libs only, and adding `dom` to borrow one type would put
 * `document`, `fetch` and the rest of the browser surface in scope for every server module.
 */
interface RoomElement {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
  readonly parentElement: RoomElement | null;
  readonly isConnected: boolean;
  matches(selectors: string): boolean;
  querySelector(selectors: string): RoomElement | null;
  querySelectorAll(selectors: string): ArrayLike<RoomElement>;
  click(): void;
}

interface RoomDocument {
  querySelector(selectors: string): RoomElement | null;
  querySelectorAll(selectors: string): ArrayLike<RoomElement>;
}

/** One row of the panel, as the page hands it back. */
export interface RoomParticipant {
  /**
   * Meet's per-device path, or the cohort's own identity for a merged group.
   *
   * This, not the name, is what a caller compares. Two people can share a display name,
   * a display name can change mid-call, and the follow-up window's "was that the same
   * person?" test has to be exact.
   */
  id: string;
  name: string;
  isSelf: boolean;
  /** A cohort row: people Meet is mixing into one stream, not an individual. */
  isGroup: boolean;
  /**
   * Whether this row has a voice meter at all.
   *
   * Worth reporting because its *absence* is informative: while a cohort row is present, the
   * rows without meters are the people inside that cohort. That is the only signal the panel
   * gives for who is sharing the microphone, and it is what lets the agent say "one of Jari or
   * Mario" instead of reading Meet's own label for the group out loud.
   */
  hasMeter: boolean;
  /**
   * Ages of this row's recent voice-meter transitions, freshest first, empty when it has
   * not moved since the observer was installed.
   *
   * Deliberately raw. One transition is not speech — muting or unmuting swaps the meter
   * for an icon and changes its class exactly once — so the "is this speech?" rule needs
   * to see several in quick succession, and that rule belongs in `judgeSpeaker` where it
   * can be tested rather than in a `page.evaluate` body where it cannot.
   */
  meterHitsMsAgo: number[];
}

export interface RoomReading {
  /** Everyone the panel lists, including the agent itself. */
  participants: RoomParticipant[];
  /**
   * What the meters can currently distinguish.
   *
   * `merged` is not a failure: Meet is mixing several people in the room into one stream,
   * so one group identity is the true answer rather than a degraded one.
   */
  activity: 'per-person' | 'merged' | 'unavailable';
}

const LIST = '[role="list"][aria-label="Participants"]';
const ROW = '[role="listitem"][aria-label]';

/**
 * The voice meter inside a row.
 *
 * `jscontroller` rather than a class name because every class on this subtree is a
 * generated hash. The controller id is generated too, but it survives releases that
 * reshuffle classes, and losing it degrades to no attribution — which
 * `attribution_rate` reports.
 */
const METER = '[jscontroller="ES310d"]';

/** How Meet marks the agent's own row. */
const SELF_MARK = '(You)';

/** Longest thing that could be a person's name in the label position. */
const MAX_NAME_CHARS = 40;

/** Most recent meter transitions kept per row — enough to tell churn from a single toggle. */
const METER_HITS_KEPT = 6;

/** How long to give the panel to render after the control is clicked. */
const PANEL_OPEN_MS = 600;

/**
 * Clicks that opened no list before this gives up for the rest of the call.
 *
 * Reachable when Google renames the list while leaving the control findable by `jsname`, or
 * on a profile in another language: the click keeps landing and the list never appears. The
 * runtime would then spend a whole call clicking a live control on every poll, which is the
 * shape the mic path is careful to avoid and this has the same duty.
 *
 * Measured, so as not to overstate it: clicking this control while the panel is *already*
 * open left it open — it selects a side panel rather than toggling one — so a stray click is
 * not known to undo the previous one. The bound is here because the cost of being wrong
 * about that is a call spent flicking Meet's UI, and one DOM query is cheap insurance.
 */
const FRUITLESS_OPENS_BEFORE_GIVING_UP = 3;

/**
 * Cap on one panel read.
 *
 * Matches the caption probe this replaced: it runs every second, so a read still
 * outstanding when the next tick is due has already lost the thing it was for.
 */
const READ_TIMEOUT_MS = 1_500;

/**
 * How recently a meter must have moved for its row to count as speaking now.
 *
 * Wide enough to bridge the gaps between words, short enough that it does not still name
 * someone who finished a sentence ago.
 */
const SPEAKING_RECENCY_MS = 1_200;

/** Transitions inside this span are churn — that is, speech rather than a mute toggle. */
const SPEECH_CHURN_MS = 800;

/** Fewer than this many transitions in `SPEECH_CHURN_MS` is a state change, not speech. */
const SPEECH_CHURN_HITS = 2;

/**
 * Two rows this close together cannot be told apart.
 *
 * The audio is one mixed channel, so an utterance overlapping two speakers cannot
 * be attributed to either. Answering nothing leaves the follow-up window inert, which is
 * the safe direction; answering a coin flip would arm an exchange for the wrong person.
 */
const OVERLAP_MS = 400;

/**
 * Open the Participants panel, if it is not already open.
 *
 * Idempotent, and cheap when there is nothing to do: the list's presence is the test, so a
 * repeat call is one DOM query. The runtime calls this on every join and keeps calling it
 * while nothing has been attributed, the same shape as unmuting — one unlucky moment while
 * the control bar is still painting would otherwise cost attribution for a whole call,
 * silently.
 *
 * Never throws. Attribution is a hint a call runs without, and a panel that refuses to open
 * is not a reason to refuse a meeting.
 */
export async function openParticipants(page: Page): Promise<void> {
  try {
    const outcome = await withTimeout(
      page.evaluate(
        async ({ list, settleMs, giveUpAfter }) => {
          const w = globalThis as unknown as {
            document: RoomDocument;
            __prismPanel?: { fruitless: number };
          };
          const doc = w.document;
          if (doc.querySelector(list)) return 'open';

          const tries = (w.__prismPanel ??= { fruitless: 0 });
          if (tries.fruitless >= giveUpAfter) return 'gave-up';

          // The control has its name as *text* — "People" plus a count badge, so
          // "People2" — and has no aria-label of its own. Matched on that text, with the
          // jsname as a second try, because between an English word and a minified
          // identifier neither is clearly the more durable of the two.
          const byText = Array.from(doc.querySelectorAll('[role="button"]')).find((el) =>
            /^people\s*\d*$/i.test(el.textContent?.trim() ?? ''),
          );
          const control = byText ?? doc.querySelector('[jsname="ocqpFe"]');
          if (!control) return 'no-control';

          control.click();
          await new Promise((resolve) => setTimeout(resolve, settleMs));

          // Checked rather than assumed, because the click is the cheap half: what has to be
          // true afterwards is that the list is *there*.
          if (doc.querySelector(list)) {
            tries.fruitless = 0;
            return 'opened';
          }
          tries.fruitless += 1;
          return 'no-list';
        },
        { list: LIST, settleMs: PANEL_OPEN_MS, giveUpAfter: FRUITLESS_OPENS_BEFORE_GIVING_UP },
      ),
      READ_TIMEOUT_MS + PANEL_OPEN_MS,
    );

    if (outcome === 'opened') {
      logger.info('[Meeting] Opened the participants panel, so I can tell who is speaking');
    } else if (outcome === 'no-list') {
      logger.debug('[Meeting] Clicked the participants control but no list appeared');
    } else if (outcome === 'gave-up') {
      logger.debug('[Meeting] Not clicking the participants control again — it opens no list');
    }
  } catch (err) {
    logger.debug(`[Meeting] Could not open the participants panel: ${String(err)}`);
  }
}

/**
 * Read the panel: who is listed, and when each of them last made a sound.
 *
 * Null when the panel is not open or the read failed — one value for all of it, because
 * every caller does the same thing with each of those.
 *
 * ### Why an observer in the page rather than sampling the classes
 *
 * The meter encodes amplitude, so it passes through its idle value between words. A poll
 * sees only the instant it fires, and at one second apart it lands in those gaps often
 * enough to miss a person talking continuously. A `MutationObserver` sees every transition,
 * so "moved 300ms ago" is exact however slowly the runtime harvests.
 *
 * It watches `class` attributes only, and counts a mutation only when the meter is on the
 * path from the mutated node up to the row. Watching `childList` too would catch a Meet
 * release that swaps the meter node instead of restyling it — but it would also fire when
 * anything else in a row changes, and a row re-rendering because somebody joined would read
 * as that person speaking. Precision is the right trade here: a missed transition costs
 * attribution, which the metric shows, while a false one attributes an exchange to the
 * wrong person.
 */
export async function readRoom(page: Page): Promise<RoomReading | null> {
  try {
    return await withTimeout(
      page.evaluate(
        ({ list, row, meter, selfMark, maxNameChars, hitsKept }) => {
          const w = globalThis as unknown as {
            document: RoomDocument;
            MutationObserver: new (cb: (records: ArrayLike<{ target: RoomElement }>) => void) => {
              observe(target: RoomElement, options: Record<string, unknown>): void;
              disconnect(): void;
            };
            __prismRoom?: {
              hits: Map<string, number[]>;
              observer: { disconnect(): void };
              list: RoomElement;
            };
          };

          const panel = w.document.querySelector(list);
          if (!panel) return null;

          const identify = (el: RoomElement): string =>
            el.getAttribute('data-participant-id') ??
            el.getAttribute('data-cohort-id') ??
            el.getAttribute('aria-label') ??
            '';

          // Re-installed whenever the list this was attached to is gone: an observer on a
          // detached node keeps its callback and never fires again, so trusting a previous
          // install would report a silent room for the rest of the call.
          let state = w.__prismRoom;
          if (!state || state.list !== panel || !state.list.isConnected) {
            state?.observer.disconnect();
            const hits = new Map<string, number[]>();
            const observer = new w.MutationObserver((records) => {
              const at = Date.now();
              for (let i = 0; i < records.length; i++) {
                let node: RoomElement | null = records[i].target;
                let sawMeter = false;
                while (node && node !== panel) {
                  if (!sawMeter && node.matches(meter)) sawMeter = true;
                  if (node.matches(row)) break;
                  node = node.parentElement;
                }
                if (!sawMeter || !node || node === panel) continue;

                const key = identify(node);
                if (!key) continue;
                const seen = hits.get(key) ?? [];
                seen.unshift(at);
                if (seen.length > hitsKept) seen.length = hitsKept;
                hits.set(key, seen);
              }
            });
            observer.observe(panel, { subtree: true, attributes: true, attributeFilter: ['class'] });
            state = { hits, observer, list: panel };
            w.__prismRoom = state;
          }

          const now = Date.now();
          const participants: RoomParticipant[] = [];
          let meteredWithId = 0;
          let meteredWithoutId = 0;

          for (const el of Array.from(panel.querySelectorAll(row))) {
            const name = el.getAttribute('aria-label')?.trim() ?? '';
            const id = identify(el);
            if (!id || name.length === 0 || name.length > maxNameChars) continue;

            const hasMeter = el.querySelector(meter) !== null;
            if (hasMeter) {
              if (el.getAttribute('data-participant-id')) meteredWithId += 1;
              else meteredWithoutId += 1;
            }

            participants.push({
              id,
              name,
              isSelf: (el.textContent ?? '').includes(selfMark),
              isGroup: !el.getAttribute('data-participant-id'),
              hasMeter,
              meterHitsMsAgo: (state.hits.get(id) ?? []).map((at) => now - at),
            });
          }

          // A metered row with no participant id is a cohort: several people Meet is
          // mixing into one stream, whose own members' meters have gone quiet.
          const activity =
            meteredWithoutId > 0 ? 'merged' : meteredWithId > 0 ? 'per-person' : 'unavailable';

          return { participants, activity };
        },
        {
          list: LIST,
          row: ROW,
          meter: METER,
          selfMark: SELF_MARK,
          maxNameChars: MAX_NAME_CHARS,
          hitsKept: METER_HITS_KEPT,
        },
      ),
      READ_TIMEOUT_MS,
    );
  } catch (err) {
    logger.debug(`[Meeting] Could not read the participants panel: ${String(err)}`);
    return null;
  }
}

/**
 * Which row the meters point at, or null when they cannot say.
 *
 * Pure, and the whole decision — everything the page does is arithmetic. Three ways it
 * answers null, all of them "I cannot tell" rather than "nobody":
 *
 * - no meter has churned recently, so nobody is talking;
 * - two rows churned within `OVERLAP_MS` of each other, so the mixed channel's utterance
 *   belongs to either of them;
 * - the panel offered no meters at all.
 *
 * The agent's own row is returned when it is the one talking, with `isSelf` set, rather
 * than filtered out. "That was me" and "I cannot tell" are different answers, and a caller
 * that folds them together keeps naming a stale human for as long as the agent speaks.
 */
export function judgeSpeaker(reading: RoomReading): SpeakerReading | null {
  if (reading.activity === 'unavailable') return null;

  const speaking = reading.participants
    .map((p) => ({ p, at: speechAge(p.meterHitsMsAgo) }))
    .filter((c): c is { p: RoomParticipant; at: number } => c.at !== null)
    .sort((a, b) => a.at - b.at);

  const [first, second] = speaking;
  if (!first) return null;
  if (second && second.at - first.at < OVERLAP_MS) return null;

  return {
    id: first.p.id,
    name: first.p.name,
    isSelf: first.p.isSelf,
    isGroup: first.p.isGroup,
    ...(first.p.isGroup ? { members: sharedMicrophoneNames(reading) } : {}),
  };
}

/**
 * How long ago this row was last *speaking*, as opposed to last changing.
 *
 * A single transition is not speech: muting swaps the meter for an icon and changes its
 * class once. Speech churns, so several transitions have to fall inside one short span
 * before the freshest of them counts.
 */
function speechAge(hitsMsAgo: number[]): number | null {
  const freshest = hitsMsAgo[0];
  if (freshest === undefined || freshest > SPEAKING_RECENCY_MS) return null;

  const churning = hitsMsAgo.filter((age) => age - freshest <= SPEECH_CHURN_MS).length;
  return churning >= SPEECH_CHURN_HITS ? freshest : null;
}

/**
 * The people sharing one microphone, when the platform is mixing some of the room.
 *
 * While a cohort row is present the members are exactly the rows that have an identity but no
 * meter of their own — Meet moves the meter to the group. Empty when nothing is merged, which
 * is the common case.
 *
 * This exists so nobody has to say "Merged audio" to a human. That is Meet's label for its own
 * UI, and an agent that reads it out is naming somebody who does not exist; naming the two
 * people who actually share the microphone is both true and useful.
 */
export function sharedMicrophoneNames(reading: RoomReading | null): string[] {
  if (reading === null || reading.activity !== 'merged') return [];
  return reading.participants
    .filter((p) => !p.isGroup && !p.isSelf && !p.hasMeter)
    .map((p) => p.name);
}

/**
 * The other people in the room. Empty when the panel could not be read.
 *
 * Two exclusions, and both of them leaked before they were here.
 *
 * A **cohort row's label is not a person.** "Merged audio" passes every plausibility test a
 * name has to pass, and it reaches three places that each do the wrong thing with it: the
 * transcriber takes it as a decoding hint and biases recognition toward the phrase, the model
 * is told it is somebody in the call and may greet it, and the follow-up window's drift guard
 * treats it as a third party a sentence can be addressed to. `isGroup` exists so nothing says
 * "Merged audio" as though it were somebody, and honouring it only on the speaker path left
 * the roster path saying it anyway — in exactly the merged-audio call this read exists to
 * cover.
 *
 * The **agent's own row** is excluded here rather than by name further downstream, because the
 * Google account's display name need not match the agent's own. A renamed agent would seed its
 * own account name into the transcriber's keywords and be reported to itself as a participant
 * in the room; `isSelf` is read off the panel and cannot disagree with itself that way.
 */
export function namesFrom(reading: RoomReading | null): string[] {
  if (reading === null) return [];

  // Case-insensitively unique, keeping the first spelling. Not hypothetical: a live call with
  // merged audio listed the same person twice and sent the transcriber
  // `keywords=[…, Maximilian Greis, Maximilian Greis, …]`, spending two of its twelve slots on
  // one name and telling the model there was an extra person in the room. The reading this
  // replaced deduped for the same reason — two scrapes of one person — and dropping it when the
  // roster moved to a single source was a regression rather than a simplification, because one
  // source can still list one person twice.
  const seen = new Map<string, string>();
  for (const p of reading.participants) {
    if (p.isGroup || p.isSelf) continue;
    const key = p.name.toLowerCase();
    if (!seen.has(key)) seen.set(key, p.name);
  }
  return [...seen.values()];
}
