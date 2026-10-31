/**
 * Hand-labelled threads for the thread reply gate: a reply in a Slack or Teams
 * thread that does not mention the agent, and whether the agent answers it. Each
 * case runs the adapter's participation rule and then the classifier, as the
 * adapter hands the thread over. All names are invented.
 */

import { threadGateAction } from './harness';
import type { Scenario } from './scenarios';
import { THREAD_TRANSCRIPT_LINES, type GateAgent, type ThreadLine } from '../services/thread-reply-classifier.service';
import type { ChatPlatform } from '../services/channel-adapter.interface';

interface Member {
  kind: 'person' | 'bot';
  name: string;
}

const MEMBERS = {
  ana: { kind: 'person', name: 'Ana Example' },
  ben: { kind: 'person', name: 'Ben Example' },
  triage: { kind: 'bot', name: 'Triage Bot' },
  billing: { kind: 'bot', name: 'Billing Bot' },
} satisfies Record<string, Member>;

type Author = 'agent' | keyof typeof MEMBERS;

/** One message of a thread, oldest first. The last one is judged. */
type Line = [Author, string];

interface GateCase {
  id: string;
  expect: string;
  platform: ChatPlatform;
  label: 'respond' | 'ignore';
  thread: Line[];
}

/** The agent every case decides for, with a role written the way an onboarded Soul opens. */
const ATLAS: GateAgent = {
  name: 'Atlas',
  role: "## Role\nYou deploy the platform team's services and watch CI on main.",
};

/**
 * What the adapter hands the classifier, or null when its participation rule
 * leaves the message without a classification: the agent posted in the messages
 * the classifier reads, or in Teams the message that brought it in is one of them.
 */
function gateInput(gateCase: GateCase): ThreadLine[] | null {
  const before = gateCase.thread.slice(0, -1);
  const recent = before.slice(-THREAD_TRANSCRIPT_LINES);
  const rootInView = gateCase.platform === 'teams' && before.length <= THREAD_TRANSCRIPT_LINES;
  if (!recent.some(([author]) => author === 'agent') && !rootInView) return null;
  return gateCase.thread.map(([author, text]) => ({
    author: author === 'agent' ? { kind: 'agent', name: ATLAS.name } : { kind: MEMBERS[author].kind, name: MEMBERS[author].name },
    text,
  }));
}

function scenario(gateCase: GateCase): Scenario {
  return {
    id: `gate.${gateCase.id}`,
    expect: gateCase.expect,
    grader: 'gate verdict',
    run: async () => {
      const lines = gateInput(gateCase);
      const action = lines ? await threadGateAction(gateCase.platform, ATLAS, lines) : 'ignore';
      return { pass: action === gateCase.label, detail: lines ? action : `${action} (participation rule)` };
    },
  };
}

/** Twelve messages between people about other things, to push the agent out of the window. */
const CHATTER: Line[] = [
  ['ana', 'is anyone going to the offsite on Thursday?'],
  ['ben', 'yes, I booked the train'],
  ['ana', 'which one?'],
  ['ben', 'the 8:10 from the central station'],
  ['ana', 'I will take the same one'],
  ['ben', 'great, see you there'],
  ['ana', 'do we need to bring laptops?'],
  ['ben', 'the agenda says yes'],
  ['ana', 'ok'],
  ['ben', 'also the badge, they check it at the door'],
  ['ana', 'good to know'],
  ['ben', 'lunch is included too'],
];

const CASES: GateCase[] = [
  {
    id: 'approval-after-agent-question',
    expect: 'An approval of what the agent asked to do is answered.',
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ana', 'payments-api has a fix ready in #194, CI is green.'],
      ['agent', 'I reviewed #194 and the checks pass. Shall I merge it?'],
      ['ana', 'yes go ahead'],
    ],
  },
  {
    id: 'correction-of-agent',
    expect: "A correction of the agent's work is answered.",
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ana', 'Atlas, deploy v1.4 of checkout please.'],
      ['agent', 'Deployed checkout v1.4 to staging.'],
      ['ana', 'that was meant for prod, not staging'],
    ],
  },
  {
    id: 'follow-up-on-agent-output',
    expect: "A follow-up question on the agent's answer is answered.",
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ben', 'Atlas, why is main red?'],
      ['agent', 'Three jobs failed on main: unit, e2e-web and lint. The first failure is in unit.'],
      ['ben', 'which test in unit?'],
    ],
  },
  {
    id: 'instruction-without-question',
    expect: 'An extra instruction for the work the agent is doing is answered.',
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ana', 'Atlas, ship checkout v1.5 to prod.'],
      ['agent', 'Deploying checkout v1.5 to prod now.'],
      ['ana', "also tag the release when it's done"],
    ],
  },
  {
    id: 'role-request-to-thread',
    expect: "A request to the whole thread for work in the agent's role is answered.",
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ana', 'payments-api is throwing 500s since the last deploy'],
      ['agent', 'The 500s started at 10:42, right after payments-api v2.3 went out.'],
      ['ben', 'I see the same in the logs'],
      ['ben', 'can someone roll back payments-api to v2.2?'],
    ],
  },
  {
    id: 'named-in-text',
    expect: 'A message that names the agent in plain text is answered, with another bot in the thread.',
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ana', 'error rate on checkout looks high'],
      ['triage', 'Opened OPS-41 for high checkout error rate.'],
      ['agent', 'The error rate is 4.1%, up from 0.3% this morning.'],
      ['ben', 'Triage Bot, assign OPS-41 to me'],
      ['triage', 'OPS-41 is assigned to Ben Example.'],
      ['ana', "Atlas, what's the error rate now?"],
    ],
  },
  {
    id: 'answer-after-other-bot-post',
    expect: "An answer to the agent's question is answered after another bot posted in between.",
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ana', 'Atlas, the nightly build failed again'],
      ['agent', 'The nightly build failed on a flaky e2e test. Should I page on-call?'],
      ['triage', 'Opened OPS-52 for the nightly build failure.'],
      ['ana', "no, don't page anyone"],
    ],
  },
  {
    id: 'answer-to-agent-among-bots',
    expect: "A bare answer to the agent's question is answered when another bot posted last.",
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ben', 'Atlas, spin up a preview environment for #210'],
      ['agent', 'Which region should the preview run in?'],
      ['billing', 'Daily cost report: preview environments cost 41 USD yesterday.'],
      ['ben', 'eu-west-1'],
    ],
  },
  {
    id: 'root-outside-window',
    expect: 'A question about the task the thread root gave the agent is answered in a long thread.',
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ana', 'Atlas, keep an eye on this thread and tell us when main is green again.'],
      ...CHATTER.slice(0, 4),
      ['agent', 'The rerun on main is queued.'],
      ...CHATTER.slice(4, 10),
      ['ben', 'green yet?'],
    ],
  },
  {
    id: 'colleague-named-and-agent-asked',
    expect: 'A message that gives a colleague one task and the agent another is answered.',
    platform: 'slack',
    label: 'respond',
    thread: [
      ['ana', 'e2e is flaky again on main'],
      ['agent', 'e2e-web failed twice on main today, both times on the checkout spec.'],
      ['ana', 'Ben, can you look at the checkout spec? Atlas, rerun the e2e job please.'],
    ],
  },
  {
    id: 'teams-approval',
    expect: 'An approval in a Teams reply chain is answered.',
    platform: 'teams',
    label: 'respond',
    thread: [
      ['ana', 'Atlas, the worker pool is stuck again'],
      ['agent', 'The worker pool has 0 of 8 workers healthy. I can restart the pool. Proceed?'],
      ['ana', 'Proceed'],
    ],
  },
  {
    id: 'human-answers-human',
    expect: "One person's answer to another is left alone.",
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'Atlas, who is on call this week?'],
      ['agent', 'The on-call rota names Ben Example for this week.'],
      ['ana', 'Ben, are you on call tonight too?'],
      ['ben', 'yes, until 6 tomorrow'],
    ],
  },
  {
    id: 'thanks-to-person',
    expect: 'A thanks to another person is left alone.',
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'the README has a broken link'],
      ['agent', 'The link to the setup guide points to a deleted page.'],
      ['ben', 'fixed it in #215'],
      ['ana', 'thanks Ben!'],
    ],
  },
  {
    id: 'request-to-other-bot',
    expect: 'A request to another bot by name is left alone.',
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'checkout is down for some users'],
      ['agent', 'Checkout returns 503 for 12% of requests since 14:05.'],
      ['triage', 'I can open an incident ticket for this.'],
      ['ana', 'Triage Bot, open a ticket for this'],
    ],
  },
  {
    id: 'other-bot-status',
    expect: "Another bot's status post is left alone.",
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ben', 'Atlas, deploy billing-api v3.1'],
      ['agent', 'billing-api v3.1 is live in prod.'],
      ['billing', 'Invoice run for October finished: 1,204 invoices sent.'],
    ],
  },
  {
    id: 'reply-to-other-bot',
    expect: "An answer to another bot's question is left alone.",
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'the login page is slow'],
      ['agent', 'Login p95 latency is 2.4 s, up from 0.6 s yesterday.'],
      ['triage', 'Opened OPS-60. Who should I assign it to?'],
      ['ana', 'assign it to Ben'],
    ],
  },
  {
    id: 'work-of-other-bot',
    expect: 'A request for work that another bot in the thread does is left alone.',
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'a customer was billed twice in October'],
      ['billing', 'I found two invoices for that customer in October: INV-881 and INV-882.'],
      ['agent', 'No deploy touched billing-api in October.'],
      ['ana', 'can someone file the invoice correction for INV-882?'],
    ],
  },
  {
    id: 'bots-converse',
    expect: "A person's answer to another bot is left alone after the agent posted.",
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ben', 'Atlas, is the staging database healthy?'],
      ['agent', 'The staging database is healthy: 12% CPU, no replication lag.'],
      ['triage', 'Ana, OPS-70 is still open. Should I close it?'],
      ['ana', 'ok, do that'],
    ],
  },
  {
    id: 'question-to-person-agent-could-answer',
    expect: 'A question to another person is left alone, also when the agent knows the answer.',
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'Atlas, what went out today?'],
      ['agent', 'Today checkout v1.6 and search v4.2 went to prod.'],
      ['ben', 'I also merged the search fix'],
      ['ana', 'Ben, did your search fix go out with v4.2?'],
    ],
  },
  {
    id: 'asks-person-about-agent-output',
    expect: "A question to another person about the agent's answer is left alone.",
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'Atlas, why did the deploy fail?'],
      ['agent', 'The deploy failed because the migration timed out after 300 s on the orders table.'],
      ['ana', 'Ben, do you agree with that?'],
    ],
  },
  {
    id: 'request-already-claimed',
    expect: 'A request that a person took on is left alone.',
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'Atlas, the worker queue is growing'],
      ['agent', 'The worker queue holds 4,300 jobs and grows by about 200 a minute.'],
      ['ana', 'can someone restart the worker?'],
      ['ben', 'on it'],
      ['ana', "thanks, tell me when it's done"],
    ],
  },
  {
    id: 'aside',
    expect: 'An aside that asks for nothing is left alone.',
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ben', 'Atlas, how many deploys this week?'],
      ['agent', 'There were 23 deploys to prod this week.'],
      ['ben', 'lol what a week'],
    ],
  },
  {
    id: 'greeting',
    expect: 'A greeting to everyone is left alone.',
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'Atlas, is main green?'],
      ['agent', 'Main is green: the last 5 runs passed.'],
      ['ben', 'morning all'],
    ],
  },
  {
    id: 'stale-agent-post',
    expect: 'A request in a thread the agent left more than ten messages ago is left alone.',
    platform: 'slack',
    label: 'ignore',
    thread: [
      ['ana', 'anyone know why search is slow?'],
      ['agent', 'Search p95 is 1.8 s since the index rebuild.'],
      ...CHATTER,
      ['ana', 'can someone check the search logs?'],
    ],
  },
  {
    id: 'teams-human-chatter',
    expect: 'People talking among themselves in a Teams reply chain are left alone.',
    platform: 'teams',
    label: 'ignore',
    thread: [
      ['ben', 'Atlas, is the release branch cut?'],
      ['agent', 'The release branch release/2026.11 was cut at 09:00.'],
      ['ana', 'Ben, lunch at 12?'],
      ['ben', 'sure, the usual place'],
    ],
  },
  {
    id: 'teams-request-to-other-bot',
    expect: 'A go-ahead to another bot in a Teams reply chain is left alone.',
    platform: 'teams',
    label: 'ignore',
    thread: [
      ['ana', 'Atlas, any failed deploys today?'],
      ['agent', 'One deploy failed today: search v4.3 at 11:20.'],
      ['triage', 'I can open a ticket for the failed search deploy.'],
      ['ana', 'yes please, Triage Bot'],
    ],
  },
];

// The cases have to reach past the window for the long-thread ones to mean anything.
if (CHATTER.length <= THREAD_TRANSCRIPT_LINES) throw new Error('CHATTER must be longer than the gate window.');

export const THREAD_GATE_SCENARIOS: Scenario[] = CASES.map(scenario);
