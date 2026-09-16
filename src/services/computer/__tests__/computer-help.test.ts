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
    },
  };
});
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
  computerService.access.handBack('viewer');
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
