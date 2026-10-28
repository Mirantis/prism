import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockListTargets } = vi.hoisted(() => ({ mockListTargets: vi.fn() }));

vi.mock('./outbound-message.service', () => ({ outboundMessageService: { listTargets: mockListTargets } }));
vi.mock('./message-delivery.service', () => ({ messageDeliveryService: {} }));
vi.mock('./conversation.service', () => ({ conversationService: {} }));

import { deliveryTargetService, isValidDeliverTo, parseCommaList } from './delivery-target.service';
import type { LinkedTarget } from './channel-adapter.interface';

const MAIN: LinkedTarget = { key: 'slack:C0MAIN', platform: 'slack', kind: 'channel', conversationId: 'C0MAIN', name: 'general', isMain: true };
const OPS: LinkedTarget = { ...MAIN, key: 'slack:C0OPS', conversationId: 'C0OPS', name: 'ops', isMain: false };
const DM: LinkedTarget = { key: 'slack:D0ANA', platform: 'slack', kind: 'dm', conversationId: 'D0ANA', name: 'Ana', isMain: false, dmUserId: 'user-1' };
const TEAMS: LinkedTarget = { key: 'teams:19:ops', platform: 'teams', kind: 'channel', conversationId: '19:ops', name: 'Ops', isMain: true };

describe('parseCommaList', () => {
  it('splits and trims, dropping empties', () => {
    expect(parseCommaList(' push, pull_request ,,')).toEqual(['push', 'pull_request']);
    expect(parseCommaList(null)).toEqual([]);
    expect(parseCommaList('')).toEqual([]);
  });
});

describe('isValidDeliverTo', () => {
  it('accepts only known deliver targets', () => {
    expect(isValidDeliverTo('all')).toBe(true);
    expect(isValidDeliverTo('chat')).toBe(true);
    expect(isValidDeliverTo('slack')).toBe(true);
    expect(isValidDeliverTo('teams')).toBe(true);
    expect(isValidDeliverTo('none')).toBe(true);
    expect(isValidDeliverTo('log')).toBe(false);
  });
});

describe('Requirement: a delivery setting is where an autonomous run may post', () => {
  beforeEach(() => {
    mockListTargets.mockResolvedValue([MAIN, OPS, DM, TEAMS]);
  });

  it.each([
    ['all', [], { webChat: true, targets: [MAIN, OPS, DM, TEAMS] }],
    ['chat', [], { webChat: true, targets: [] }],
    ['none', [], { webChat: false, targets: [] }],
    ['slack', [], { webChat: false, targets: [MAIN, OPS, DM] }],
    ['slack', ['C0OPS'], { webChat: false, targets: [OPS] }],
    ['teams', [], { webChat: false, targets: [TEAMS] }],
  ])('%s with chosen channels %j allows %j', async (deliverTo, channelIds, expected) => {
    expect(await deliveryTargetService.ceiling('agent-1', { deliverTo, channelIds })).toEqual(expected);
  });

  it('allows web chat for a platform with nothing linked, where a delivery goes too', async () => {
    mockListTargets.mockResolvedValue([MAIN]);

    expect(await deliveryTargetService.ceiling('agent-1', { deliverTo: 'teams', channelIds: [] })).toEqual({
      webChat: true,
      targets: [],
    });
    expect(await deliveryTargetService.ceiling('agent-1', { deliverTo: 'slack', channelIds: ['C0GONE'] })).toEqual({
      webChat: true,
      targets: [],
    });
  });
});
