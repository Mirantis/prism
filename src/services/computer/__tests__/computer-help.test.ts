import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../../../lib/prisma';
import { computerService } from '../computer.service';
import { computerHelpService } from '../computer-help.service';
import { getComputerTools } from '../../../tools/computer';

vi.mock('../../../lib/prisma', () => ({
  default: {
    conversationMessage: {
      findFirst: vi.fn(),
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
    getChannelContext: vi.fn(async () => ({ channel: 'websocket' })),
  },
}));
vi.mock('../../message-delivery.service', () => ({
  messageDeliveryService: { publish: vi.fn(), mirror: vi.fn() },
}));
vi.mock('../../voice/voice-chat.service', () => ({
  voiceChatService: { continueComputer: vi.fn() },
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

  const ask = (reason: string, credentials?: boolean) =>
    computerHelpService.request(
      computerService.access.create({ ...caller, threadId: 'thread' }),
      reason,
      undefined,
      credentials,
    );

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
