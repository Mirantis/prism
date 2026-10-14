import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../../config';
import prisma from '../../../lib/prisma';
import { trackEvent } from '../../../lib/telemetry';
import { messageDeliveryService } from '../../message-delivery.service';
import { computerService } from '../computer.service';
import { computerHelpService, HELP_ANSWER_WAIT_MS } from '../computer-help.service';
import type { ComputerCaller, ComputerUse } from '../computer-access';
import { conversationEngineService } from '../../conversation-engine.service';
import { voiceChatService } from '../../voice/voice-chat.service';
import { ALERT_THE_USER, getComputerTools } from '../../../tools/computer';

vi.mock('../../../lib/prisma', () => ({
  default: {
    conversationMessage: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));
vi.mock('../computer.service', async () => {
  const { ComputerAccess } = await import('../computer-access');
  const access = new ComputerAccess();
  return {
    computerService: {
      access,
      assertCanHandBack: (id: string) => access.assertCanHandBack(id),
      handBack: (id: string) => access.handBack(id),
      continueFromChat: () => access.handBack(access.human ?? 'chat'),
      helpTarget: vi.fn(),
      signInForm: vi.fn(),
    },
  };
});
vi.mock('../../conversation.service', () => ({
  conversationService: {
    getOrCreateLatestThread: vi.fn(async () => ({ id: 'thread' })),
  },
}));
vi.mock('../../message-delivery.service', () => ({
  messageDeliveryService: {
    publish: vi.fn(),
    showInConversation: vi.fn(),
    threadContext: vi.fn(async (threadId: string) => ({ channel: 'websocket', threadId })),
  },
}));
vi.mock('../../goal.service', () => ({
  goalService: { getGoalForThread: vi.fn(async () => null), resumeGoal: vi.fn() },
}));
vi.mock('../../voice/voice-chat.service', () => ({
  voiceChatService: { continueComputer: vi.fn() },
}));
vi.mock('../../conversation-engine.service', () => ({
  conversationEngineService: { chat: vi.fn(async () => ({})) },
}));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: vi.fn() }));

const help = {
  type: 'computer_help',
  id: 'help-id',
  reason: 'Sign in',
  status: 'waiting',
};
const caller = { userId: 'user', agentId: 'agent', mode: 'chat' };
const options = { toolCallId: 'call', messages: [] };

/** The uses a test made. Each is canceled after the test, so no run waits into the next one. */
const uses: ComputerUse[] = [];
function createUse(fields: Partial<ComputerCaller> = {}): ComputerUse {
  const use = computerService.access.create({ ...caller, ...fields });
  uses.push(use);
  return use;
}
afterEach(() => {
  for (const use of uses.splice(0)) use.controller.abort();
});

beforeEach(async () => {
  await computerService.access.handBack('viewer');
  await computerService.access.takeControl('viewer');
  vi.mocked(prisma.conversationMessage.findFirst).mockResolvedValue({
    id: 'message',
    blocks: [help],
  } as never);
  vi.mocked(prisma.conversationMessage.updateMany).mockResolvedValue({
    count: 1,
  });
  vi.mocked(prisma.conversationMessage.findMany).mockResolvedValue([]);
});

describe.each(['viewer', 'chat'] as const)('%s computer continuation', (source) => {
  async function resume() {
    if (source === 'viewer')
      return computerHelpService.continueRequest('agent', 'user', help.id, 'continue', 'viewer');
    const use = computerService.access.create(caller);
    return getComputerTools(use).computer_continue.execute!(
      { helpId: help.id, dismiss: false },
      options,
    );
  }

  it('keeps human control when the help ID does not exist', async () => {
    vi.mocked(prisma.conversationMessage.findFirst).mockResolvedValue(null);
    await expect(resume()).rejects.toThrow('Help request not found');
    expect(computerService.access.paused).toBe(true);
    expect(computerService.access.human).toBe('viewer');
  });

  it('keeps human control when the request is already closed', async () => {
    vi.mocked(prisma.conversationMessage.findFirst).mockResolvedValue({
      id: 'message',
      blocks: [{ ...help, status: 'dismissed' }],
    } as never);
    await resume();
    expect(computerService.access.paused).toBe(true);
    expect(computerService.access.human).toBe('viewer');
    expect(prisma.conversationMessage.updateMany).not.toHaveBeenCalled();
  });

  it('keeps human control when another request resolves the same help first', async () => {
    vi.mocked(prisma.conversationMessage.updateMany).mockResolvedValue({
      count: 0,
    });
    await resume();
    expect(computerService.access.paused).toBe(true);
    expect(computerService.access.human).toBe('viewer');
  });

  it('hands control back after resolving a waiting request', async () => {
    await resume();
    expect(computerService.access.paused).toBe(false);
    expect(computerService.access.human).toBeNull();
  });
});

it("continues a channel thread's request in that thread, with the channel's guidelines", async () => {
  const context = {
    channel: 'slack',
    channelId: 'C1',
    channelThreadId: 'root-1',
    channelLabel: 'the channel **#ops**',
    threadId: 'thread',
  };
  vi.mocked(prisma.conversationMessage.findFirst).mockResolvedValue({
    id: 'message',
    blocks: [{ ...help, threadId: 'thread', originChannel: 'slack', originChannelId: 'C1' }],
  } as never);
  vi.mocked(messageDeliveryService.threadContext).mockResolvedValueOnce(context);

  await computerHelpService.continueRequest('agent', 'user', help.id, 'continue', 'viewer');

  expect(messageDeliveryService.threadContext).toHaveBeenCalledWith('thread', 'slack', 'C1');
  expect(conversationEngineService.chat).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: 'thread',
      metadata: {
        channel: 'slack',
        channelId: 'C1',
        channelThreadId: 'root-1',
        channelLabel: 'the channel **#ops**',
      },
    }),
  );
});

it('rejects another viewer before resolving the help request', async () => {
  await expect(
    computerHelpService.continueRequest('agent', 'user', help.id, 'continue', 'other'),
  ).rejects.toThrow('Another viewer has control');
  expect(prisma.conversationMessage.updateMany).not.toHaveBeenCalled();
  expect(computerService.access.human).toBe('viewer');
});

describe('a help request a username and a password answer', () => {
  beforeEach(() => {
    vi.mocked(computerService.helpTarget).mockResolvedValue('target-1');
    vi.mocked(computerService.signInForm).mockResolvedValue(undefined);
  });

  const ask = async (reason: string, credentials?: boolean) =>
    (
      await computerHelpService.request(
        computerService.access.create({ ...caller, threadId: 'thread' }),
        reason,
        undefined,
        credentials,
      )
    ).help;

  it('records the sign-in, the site it goes to, and the fields the page asks for', async () => {
    vi.mocked(computerService.signInForm).mockResolvedValue({
      origin: 'https://mail.example.com',
      fields: 'both',
      targetId: 'target-sign-in',
    });

    const request = await ask('Sign in to the inbox', true);

    expect(request.credentials).toBe(true);
    expect(request.site).toBe('https://mail.example.com');
    expect(request.credentialFields).toBe('both');
    // The tab holding the form, which is not always the one the agent was looking at.
    expect(request.targetId).toBe('target-sign-in');
  });

  it('asks for the password alone where that is the whole of the step', async () => {
    vi.mocked(computerService.signInForm).mockResolvedValue({
      origin: 'https://mail.example.com',
      fields: 'password',
    });

    expect((await ask('Enter the password', true)).credentialFields).toBe('password');
  });

  it('asks for the desktop instead when that tab holds no sign-in form', async () => {
    const request = await ask('Approve the device', true);

    expect(request.credentials).toBeUndefined();
    expect(request.site).toBeUndefined();
  });

  it('tells the agent which answer the user was offered', async () => {
    await computerService.access.handBack('viewer');
    const { computer_help } = getComputerTools(
      computerService.access.create({ ...caller, threadId: 'thread' }),
    );
    const call = () =>
      computer_help.execute!({ reason: 'Sign in to the inbox', credentials: true }, options);

    expect(await call()).toMatchObject({ credentials: false, message: /take over the desktop/ });

    vi.mocked(computerService.signInForm).mockResolvedValue({
      origin: 'https://mail.example.com',
      fields: 'both',
    });
    expect(await call()).toMatchObject({ credentials: true, message: /^Help requested/ });
  });

  it('leaves the browser alone for a request of any other kind', async () => {
    const request = await ask('Solve the CAPTCHA');

    expect(computerService.signInForm).not.toHaveBeenCalled();
    expect(request.credentials).toBeUndefined();
  });
});

describe('where a help request is asked', () => {
  const publicUrl = config.publicUrl;
  beforeEach(async () => {
    await computerService.access.handBack('viewer');
    vi.mocked(computerService.helpTarget).mockResolvedValue('target-1');
  });
  afterEach(() => {
    config.publicUrl = publicUrl;
  });

  const ask = (run: Partial<ComputerCaller>) => computerHelpService.request(createUse(run), 'Sign in');
  const published = () => vi.mocked(messageDeliveryService.publish).mock.calls[0];

  it.each([
    ['heartbeat', 'HEARTBEAT'],
    ['cron', 'CRON_TASK'],
    ['webhook', 'WEBHOOK'],
  ])('sends a %s run with no origin to every channel', async (mode, trigger) => {
    const { help } = await ask({ mode });

    const [, threadId, content, triggeredBy, options] = published();
    expect(threadId).toBe('thread');
    expect(triggeredBy).toBe(trigger);
    expect(options?.channelContext).toBeUndefined();
    expect(options?.blocks).toEqual([expect.objectContaining({ id: help.id, broadcast: true })]);
    // A channel that posts only replies is among them, and a relative link is nothing there.
    expect(content).toContain('Open Computer in the Prism Web UI.');
    expect(messageDeliveryService.threadContext).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'computer help requested',
      'user',
      expect.objectContaining({ 'computer.delivery': 'all' }),
    );
  });

  it('links every channel to the public Computer page when there is one', async () => {
    config.publicUrl = 'https://prism.example.com';
    const { help } = await ask({ mode: 'heartbeat' });

    expect(published()[2]).toContain(
      `[Open Computer](https://prism.example.com/computer?help=${help.id})`,
    );
  });

  it.each([
    ['a Slack thread', { mode: 'cron', originChannel: 'slack', originChannelId: 'C0123' }],
    ['a web chat', { mode: 'goal', originChannel: 'websocket' }],
    ['a conversation a scheduled task is bound to', { mode: 'cron' }],
    ['a chat turn that names no channel', { mode: 'chat' }],
  ] as const)('keeps a request from %s in its own channel', async (_, run) => {
    const slack = { channel: 'slack', channelId: 'C0123', channelThreadId: '1700.1', threadId: 'thread' };
    if (run.originChannel === 'slack')
      vi.mocked(messageDeliveryService.threadContext).mockResolvedValueOnce(slack);

    const { help } = await ask({ ...run, threadId: 'thread' });

    expect(messageDeliveryService.threadContext).toHaveBeenCalledWith(
      'thread',
      run.originChannel,
      'originChannelId' in run ? run.originChannelId : undefined,
    );
    expect(published()[4]?.channelContext).toEqual(
      run.originChannel === 'slack' ? slack : { channel: 'websocket', threadId: 'thread' },
    );
    expect(help.broadcast).toBeUndefined();
    expect(prisma.conversationMessage.findMany).not.toHaveBeenCalled();
  });

  it('posts nothing while a broadcast request is still waiting', async () => {
    const waiting = { ...help, id: 'waiting-id', broadcast: true as const };
    vi.mocked(prisma.conversationMessage.findMany).mockResolvedValue([
      { blocks: [waiting] },
    ] as never);
    const use = createUse({ mode: 'heartbeat' });
    await computerService.access.acquire(use);

    expect(await computerHelpService.request(use, 'Sign in again')).toEqual({
      help: waiting,
      repeated: true,
      answer: expect.any(Promise),
    });
    expect(messageDeliveryService.publish).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalledWith('computer help requested', expect.anything(), expect.anything());
    expect(trackEvent).toHaveBeenCalledWith('computer help repeated', 'user', {
      'agent.id': 'agent',
      'computer.help_id': 'waiting-id',
      mode: 'heartbeat',
    });
    // The run still gives the computer up, as it does when it asks.
    expect(computerService.access.owner).toBeNull();
  });

  it('tells a run that meets a waiting request what that request asks, once it is answered', async () => {
    vi.mocked(prisma.conversationMessage.findMany).mockResolvedValue([
      { blocks: [{ ...help, id: 'waiting-id', reason: 'Sign in to the inbox', broadcast: true }] },
    ] as never);
    const { computer_help } = getComputerTools(createUse({ mode: 'webhook' }));

    const result = computer_help.execute!({ reason: 'Solve the CAPTCHA', credentials: false }, options);
    await vi.waitFor(() => expect(computerHelpService.awaiting()).toHaveLength(1));
    await computerHelpService.continueRequest('agent', 'user', 'waiting-id', 'continue');

    expect(await result).toMatchObject({
      helpId: 'waiting-id',
      answer: 'continued',
      message: /It asks: "Sign in to the inbox"\. The user finished helping\. .* If something else blocks it, ask for that help now\./,
    });
  });
});

describe('a background run that asks for help', () => {
  beforeEach(async () => {
    await computerService.access.handBack('viewer');
  });

  async function askAndWait(mode: string) {
    const use = createUse({ mode });
    const result = getComputerTools(use).computer_help.execute!(
      { reason: 'Approve the sign-in on your phone', credentials: false },
      options,
    ) as Promise<{ helpId: string; answer: string; message: string }>;
    await vi.waitFor(() => expect(computerHelpService.awaiting()).toHaveLength(1));
    return { use, result, helpId: computerHelpService.awaiting()[0].helpId };
  }

  it.each(['heartbeat', 'cron', 'webhook'])('waits in a %s run until the user answers', async (mode) => {
    const { use, result, helpId } = await askAndWait(mode);
    expect(computerHelpService.awaiting()).toEqual([{ id: use.id, helpId, mode, threadId: undefined }]);

    await computerHelpService.continueRequest('agent', 'user', helpId, 'continue');

    expect(await result).toMatchObject({ helpId, answer: 'continued', message: /^The user finished helping\./ });
    expect(computerHelpService.awaiting()).toEqual([]);
    // The run continues the work itself, so the answer starts no turn of its own.
    expect(conversationEngineService.chat).not.toHaveBeenCalled();
    expect(voiceChatService.continueComputer).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('computer help wait ended', 'user', {
      'agent.id': 'agent',
      'computer.help_id': helpId,
      mode,
      outcome: 'continued',
      elapsed_ms: expect.any(String),
    });
  });

  it('is told when the user dismisses the request', async () => {
    const { result, helpId } = await askAndWait('heartbeat');

    await computerHelpService.continueRequest('agent', 'user', helpId, 'dismiss');

    expect(await result).toMatchObject({ answer: 'dismissed', message: /^The user dismissed the help request\./ });
  });

  it('goes on without an answer after 30 minutes, leaving the request open', async () => {
    vi.useFakeTimers();
    try {
      const { result } = await askAndWait('cron');

      await vi.advanceTimersByTimeAsync(HELP_ANSWER_WAIT_MS);

      expect(await result).toMatchObject({
        answer: 'unanswered',
        message: /^The user did not answer within 30 minutes, and the request stays open\./,
      });
      expect(prisma.conversationMessage.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting when its invocation is canceled', async () => {
    const { use, result } = await askAndWait('webhook');

    use.controller.abort(new Error('Stopped'));

    await expect(result).rejects.toThrow('Stopped');
    expect(computerHelpService.awaiting()).toEqual([]);
  });

  it('shows its conversation idle while it waits', async () => {
    const use = createUse({ mode: 'heartbeat' });
    const phases: string[] = [];
    use.idle = async (wait) => {
      phases.push('idle');
      try {
        return await wait();
      } finally {
        phases.push('working');
      }
    };
    const result = getComputerTools(use).computer_help.execute!({ reason: 'Approve it', credentials: false }, options);
    await vi.waitFor(() => expect(phases).toEqual(['idle']));

    await computerHelpService.continueRequest('agent', 'user', computerHelpService.awaiting()[0].helpId, 'continue');
    await result;

    expect(phases).toEqual(['idle', 'working']);
  });

  it('tells the turn that answers that the waiting run does the work', async () => {
    const { result, helpId } = await askAndWait('heartbeat');
    const { computer_continue } = getComputerTools(createUse({ mode: 'chat', threadId: 'channel-thread' }));

    expect(await computer_continue.execute!({ helpId, dismiss: false }, options)).toEqual({
      success: true,
      message: 'The run that asked for this help has the answer and continues by itself. Leave its work to it.',
    });
    expect(await result).toMatchObject({ answer: 'continued' });
  });

  it('says that the call waits, where a chat turn is told to end its turn', () => {
    expect(getComputerTools(createUse({ mode: 'heartbeat' })).computer_help.description).toContain(
      'This call waits up to 30 minutes for the user\'s answer',
    );
    expect(getComputerTools(createUse({ mode: 'chat' })).computer_help.description).toContain(
      'end this turn and wait for the user',
    );
  });

  it('returns at once in a chat turn', async () => {
    const result = await getComputerTools(createUse({ mode: 'chat', threadId: 'thread' })).computer_help.execute!(
      { reason: 'Sign in', credentials: false },
      options,
    );

    expect(result).toMatchObject({ success: true, message: /^Help requested\./ });
    expect(computerHelpService.awaiting()).toEqual([]);
  });

  it.each([
    ['a sign-in', false],
    ['the desktop, when the tab holds no sign-in form', true],
  ])('tells a new request for %s to alert the user', async (_name, desktop) => {
    const result = (await getComputerTools(createUse({ threadId: 'thread' })).computer_help.execute!(
      { reason: 'Sign in', credentials: desktop },
      options,
    )) as { message: string };

    if (desktop) expect(result.message).toMatch(/take over the desktop/);
    expect(result.message).toContain(ALERT_THE_USER);
  });
});

describe('the help a turn is told about', () => {
  const inThread = { ...help, id: 'own', threadId: 'thread' };
  const broadcast = { ...help, id: 'broadcast', threadId: 'latest', broadcast: true as const };
  const rows = (...items: object[]) => items.map((item) => ({ blocks: [item] })) as never;

  it("is the conversation's own help and every broadcast request still waiting", async () => {
    vi.mocked(prisma.conversationMessage.findMany)
      .mockResolvedValueOnce(rows(inThread))
      .mockResolvedValueOnce(rows(broadcast));

    expect(await computerHelpService.forTurn('agent', 'user', 'thread')).toEqual([
      inThread,
      broadcast,
    ]);
  });

  it('names a broadcast request once when it was asked in this conversation', async () => {
    vi.mocked(prisma.conversationMessage.findMany)
      .mockResolvedValueOnce(rows(broadcast))
      .mockResolvedValueOnce(rows(broadcast));

    expect(await computerHelpService.forTurn('agent', 'user', 'latest')).toEqual([broadcast]);
  });

  it('is the waiting broadcast requests for a run with no conversation', async () => {
    vi.mocked(prisma.conversationMessage.findMany).mockResolvedValueOnce(rows(broadcast));

    expect(await computerHelpService.forTurn('agent', 'user')).toEqual([broadcast]);
    expect(prisma.conversationMessage.findMany).toHaveBeenCalledTimes(1);
  });
});
