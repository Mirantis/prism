import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockConfig, mockPrisma, compaction, delivery, access, mockHelp } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return {
    mockConfig: { programStatusReports: true },
    mockPrisma: { agentWorkspace: { findUniqueOrThrow: vi.fn() } },
    compaction: { events: new EventEmitter(), hasInFlight: vi.fn() },
    delivery: { events: new EventEmitter() },
    access: new EventEmitter(),
    mockHelp: { waiting: vi.fn() },
  };
});

vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../conversation.service', () => ({ conversationService: {} }));
vi.mock('../compaction.service', () => ({ compactionService: compaction }));
vi.mock('../message-delivery.service', () => ({ messageDeliveryService: delivery }));
vi.mock('../computer/computer.service', () => ({ computerService: access }));
vi.mock('../computer/computer-help.service', () => ({ computerHelpService: mockHelp }));

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Each OSC 7501 report written to stdout, with `title` and `msg` decoded. */
function reports(writes: string[]): Array<Record<string, string>> {
  return writes.flatMap((chunk) =>
    chunk
      .split('\x1b]7501;')
      .slice(1)
      .map((report) => {
        const body = report.slice(0, report.indexOf('\x1b\\'));
        const pairs = Object.fromEntries(
          body.split(':').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
        );
        for (const key of ['title', 'msg']) {
          if (pairs[key] !== undefined) pairs[key] = Buffer.from(pairs[key], 'base64').toString('utf8');
        }
        return pairs;
      }),
  );
}

describe('programStatusService', () => {
  let writes: string[];
  let exitHandlers: Array<() => void>;
  let service: typeof import('../program-status.service').programStatusService;
  let threads: typeof import('../conversation-thread-activity.service').conversationThreadActivityService;
  let stream: typeof import('../event-stream.service').eventStreamService;

  const states = () => reports(writes).map((report) => report.state);
  const last = () => reports(writes).at(-1);

  beforeEach(async () => {
    vi.resetModules();
    writes = [];
    exitHandlers = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
      if (event === 'exit') exitHandlers.push(handler);
      return process;
    }) as typeof process.once);
    mockConfig.programStatusReports = true;
    mockPrisma.agentWorkspace.findUniqueOrThrow.mockResolvedValue({ name: 'Peter' });
    compaction.hasInFlight.mockReturnValue(false);
    mockHelp.waiting.mockResolvedValue([]);
    ({ programStatusService: service } = await import('../program-status.service'));
    ({ conversationThreadActivityService: threads } = await import('../conversation-thread-activity.service'));
    ({ eventStreamService: stream } = await import('../event-stream.service'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    compaction.events.removeAllListeners();
    delivery.events.removeAllListeners();
    access.removeAllListeners();
  });

  const start = async () => {
    service.start('agent-1', 'owner-1');
    await settle();
  };

  describe('Scenario: Work and its result', () => {
    it('reports idle with the agent name when it starts', async () => {
      await start();

      expect(reports(writes)).toEqual([{ state: 'idle', app: 'prism', title: 'Peter' }]);
    });

    it('reports a turn as working, and a delivered reply as done', async () => {
      await start();
      const turn = service.beginTurn();
      await settle();
      expect(last()).toEqual({ state: 'working', app: 'prism', title: 'Peter', msg: 'Thinking' });

      delivery.events.emit('published', {});
      turn.end({});
      await settle();

      expect(states()).toEqual(['idle', 'working', 'done']);
      expect(last()).toEqual({ state: 'done', app: 'prism', title: 'Peter', msg: 'Reply ready' });
    });

    it('ends idle after a turn that delivered nothing, such as a suppressed heartbeat', async () => {
      await start();
      const first = service.beginTurn();
      delivery.events.emit('published', {});
      first.end({});
      await settle();

      service.beginTurn().end({});
      await settle();

      expect(states()).toEqual(['idle', 'done', 'idle']);
    });

    it('reports done when the reply is delivered after the turn ended', async () => {
      await start();
      service.beginTurn().end({});
      await settle();

      delivery.events.emit('published', {});
      await settle();

      expect(last()?.state).toBe('done');
    });

    it('reports a failed turn as an error, whose error reply does not make it done', async () => {
      await start();
      service.beginTurn().end({ error: 'The agent could not answer. Try again.' });
      delivery.events.emit('published', {});
      await settle();

      expect(last()).toEqual({
        state: 'error',
        app: 'prism',
        title: 'Peter',
        msg: 'The agent could not answer. Try again.',
      });
    });

    it('reports a turn that failed with the error the user reads', async () => {
      await start();
      service.beginTurn().end({ error: 'The AI spending limit is reached.' });
      await settle();

      expect(last()).toMatchObject({ state: 'error', msg: 'The AI spending limit is reached.' });
    });

    it('reports an exchange that failed after its turns ended as an error', async () => {
      await start();
      const endExchange = threads.beginThread('thread-1', 'owner-1');
      const turn = service.beginTurn();
      await settle();
      delivery.events.emit('published', {});
      turn.end({});
      // The reply could not be stored, so the chat clients are told the exchange failed.
      stream.publish({
        type: 'turn',
        payload: { threadId: 'thread-1', state: 'idle', outcome: 'failed', error: 'The agent could not answer. Try again.' },
      });
      endExchange();
      await settle();

      expect(states()).toEqual(['idle', 'working', 'error']);
    });

    it('ends idle after a cancelled turn', async () => {
      await start();
      const turn = service.beginTurn();
      delivery.events.emit('published', {});
      turn.end({ cancelled: true });
      await settle();

      expect(last()?.state).toBe('idle');
    });

    it('clears the last result when new work starts', async () => {
      await start();
      service.beginTurn().end({ error: 'The agent could not answer. Try again.' });
      await settle();

      const next = service.beginTurn();
      delivery.events.emit('published', {});
      next.end({});
      await settle();

      expect(last()?.state).toBe('done');
    });
  });

  describe('Scenario: Work that spans several turns', () => {
    it('stays working for a conversation exchange between its turns', async () => {
      await start();
      const endExchange = threads.beginThread('thread-1', 'owner-1');
      service.beginTurn().end({});
      await settle();
      const followUp = service.beginTurn();
      delivery.events.emit('published', {});
      followUp.end({});
      await settle();
      expect(last()?.state).toBe('working');

      endExchange();
      await settle();

      expect(states()).toEqual(['idle', 'working', 'done']);
    });

    it('stays working while a compaction the turn queued runs, and then reports the reply', async () => {
      await start();
      const turn = service.beginTurn();
      compaction.hasInFlight.mockReturnValue(true);
      delivery.events.emit('published', {});
      turn.end({});
      await settle();
      expect(last()).toEqual({
        state: 'working',
        app: 'prism',
        title: 'Peter',
        msg: 'Compacting the conversation',
      });

      compaction.hasInFlight.mockReturnValue(false);
      compaction.events.emit('settled', 'thread-1');
      await settle();

      expect(states()).toEqual(['idle', 'working', 'done']);
    });
  });

  describe('Scenario: The agent waits for the user', () => {
    it('reports a waiting sign-in as blocked on auth, over work', async () => {
      await start();
      const turn = service.beginTurn();
      mockHelp.waiting.mockResolvedValue([
        { type: 'computer_help', id: 'help-1', reason: 'Sign in to example.com', credentials: true, status: 'waiting' },
      ]);
      access.emit('change');
      await settle();

      expect(last()).toEqual({
        state: 'blocked',
        kind: 'auth',
        app: 'prism',
        title: 'Peter',
        msg: 'Sign in to example.com',
      });
      expect(mockHelp.waiting).toHaveBeenLastCalledWith('agent-1', 'owner-1');

      mockHelp.waiting.mockResolvedValue([]);
      access.emit('change');
      await settle();
      expect(last()?.state).toBe('working');
      turn.end({});
    });

    it('reports no reply once a help request is answered, since its card is not one', async () => {
      await start();
      const turn = service.beginTurn();
      mockHelp.waiting.mockResolvedValue([
        { type: 'computer_help', id: 'help-1', reason: 'Sign in to example.com', credentials: true, status: 'waiting' },
      ]);
      delivery.events.emit('published', { blocks: [{ type: 'computer_help', id: 'help-1' }] });
      access.emit('change');
      turn.end({});
      await settle();
      expect(last()?.state).toBe('blocked');

      mockHelp.waiting.mockResolvedValue([]);
      access.emit('change');
      await settle();

      expect(last()?.state).toBe('idle');
    });

    it('reports the last listed other help request as a question', async () => {
      mockHelp.waiting.mockResolvedValue([
        { type: 'computer_help', id: 'help-1', reason: 'Sign in to example.com', credentials: true, status: 'waiting' },
        { type: 'computer_help', id: 'help-2', reason: 'Solve the captcha on the open tab', status: 'waiting' },
      ]);
      await start();

      expect(last()).toMatchObject({ state: 'blocked', kind: 'question', msg: 'Solve the captcha on the open tab' });
    });
  });

  describe('Scenario: Reports on or off', () => {
    it('clears the record when the process exits', async () => {
      await start();
      writes = [];

      for (const handler of exitHandlers) handler();

      expect(writes).toEqual(['\x1b]7501;state=clear\x1b\\']);
    });

    it('writes nothing when reports are off', async () => {
      mockConfig.programStatusReports = false;
      await start();
      service.beginTurn().end({});
      await settle();

      expect(writes).toEqual([]);
      expect(exitHandlers).toEqual([]);
    });

    it('shows a new agent name in the next report', async () => {
      await start();
      mockPrisma.agentWorkspace.findUniqueOrThrow.mockResolvedValue({ name: 'Ada' });

      service.beginTurn();
      await settle();

      expect(last()).toMatchObject({ state: 'working', title: 'Ada' });
    });
  });
});
