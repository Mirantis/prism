import { EventEmitter } from 'node:events';
import { AgentComputer, type ModelChannel } from './agent-computer';
import type { Computer } from './computer';
import type { ComputerCaller, ComputerKind, ComputerUse } from './computer-access';
import { ComputerSession } from './computer-session';
import { DEFAULT_SCREEN, type ScreenSize } from './screen-size';
import { hasComputer, usesRemoteComputers } from './supported';
import type { ComputerLink } from './remote/computer-link';
import { CAPABILITIES, LINK_CLOSE, type CapabilityProblem } from './remote/link-protocol';
import type { RemoteComputer } from './remote/remote-computer';
import { remoteComputerService } from './remote/remote-computer.service';

export type { ComputerViewer, SignInOutcome } from './computer-session';

/** The id the runtime's own desktop goes by, in the API and as a tool's `computer`. */
export const LOCAL_COMPUTER_ID = 'local';

/** One computer as the list shows it. */
export interface ComputerSummary {
  id: string;
  kind: ComputerKind;
  name: string;
  connection: 'connected' | 'disconnected';
  platform: string | null;
  clientVersion: string | null;
  display: ScreenSize | null;
  capabilities: string[];
  problems: CapabilityProblem[];
  lastConnectedAt: string | null;
  lastSeenAt: string | null;
  owner: { threadId?: string; mode: string } | null;
  controller: 'viewer' | 'local' | null;
}

/** What the model calls each platform's Command or Windows key. */
const SUPER_KEY: Record<string, string> = { macos: 'super is Command', windows: 'super is the Windows key' };
const PLATFORM_NAMES: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

async function openLocal(onAudio: (pcm: Buffer) => void): Promise<AgentComputer> {
  const computer = new AgentComputer();
  try {
    await computer.openBrowser(DEFAULT_SCREEN);
    computer.startBrowserAudio(onAudio);
    return computer;
  } catch (error) {
    await computer.stop();
    throw error;
  }
}

/**
 * Every computer the agent has: the runtime's own desktop and the remote computers, each
 * a `ComputerSession`. An invocation owns one computer at a time. Emits `change` whenever
 * any of them changes, which is what every status reader subscribes to.
 */
class ComputerService extends EventEmitter {
  readonly local: ComputerSession<AgentComputer> = this.track(
    new ComputerSession(LOCAL_COMPUTER_ID, 'local', () => openLocal((pcm) => this.local.broadcastAudio(pcm))),
  );
  private remotes = new Map<string, ComputerSession>();
  private links = new Map<string, { computer: RemoteComputer; link: ComputerLink }>();

  constructor() {
    super();
    // Every viewer socket and every link listens for changes, so their number has no bound here.
    this.setMaxListeners(0);
  }

  private track<C extends Computer>(session: ComputerSession<C>): ComputerSession<C> {
    session.access.on('change', () => this.emit('change'));
    return session;
  }

  /** The runtime's own desktop, or a registered remote computer. */
  session(id: string): ComputerSession | undefined {
    if (id === LOCAL_COMPUTER_ID) return this.local;
    const row = remoteComputerService.get(id);
    if (!row) return undefined;
    let session = this.remotes.get(id);
    if (!session) {
      session = this.track(
        new ComputerSession(id, 'remote', async () => {
          throw new Error(
            `${remoteComputerService.get(id)?.name ?? row.name} is not connected. Ask your user to start the computer client on it.`,
          );
        }),
      );
      this.remotes.set(id, session);
    }
    return session;
  }

  /** Every session, the runtime's own first. */
  sessions(): ComputerSession[] {
    return [this.local, ...remoteComputerService.list().flatMap((row) => this.session(row.id) ?? [])];
  }

  createUse(caller: ComputerCaller, signal?: AbortSignal): ComputerUse {
    return this.local.access.create(caller, signal);
  }

  /** The invocation ended: every computer it held or waited for is free. */
  finish(use: ComputerUse): void {
    for (const session of this.sessions()) {
      if (session !== this.local && session.access.holds(use)) session.access.yield(use);
    }
    this.local.access.finish(use);
  }

  yield(use: ComputerUse): void {
    for (const session of this.sessions()) if (session.access.holds(use)) session.access.yield(use);
  }

  /**
   * The computer a tool call names, or the run's default: the runtime's own when it has
   * one, else the only remote computer. Throws, with a message for the model, otherwise.
   */
  resolve(use: ComputerUse, name?: string): ComputerSession {
    const remote = usesRemoteComputers(use.mode);
    const wanted = name?.trim().toLowerCase();
    if (!wanted) {
      if (hasComputer()) return this.local;
      const rows = remote ? remoteComputerService.list() : [];
      if (rows.length === 1) return this.session(rows[0].id)!;
      if (rows.length > 1) throw new Error(`Name the computer to use: ${this.names()}.`);
      throw new Error('There is no computer in this run.');
    }
    if (wanted === LOCAL_COMPUTER_ID && hasComputer()) return this.local;
    if (!remote) throw new Error(`Only your own computer is available in a ${use.mode} run.`);
    const row = remoteComputerService
      .list()
      .find((item) => item.id === name!.trim() || item.name.toLowerCase() === wanted);
    if (!row) throw new Error(`There is no computer named ${JSON.stringify(name)}. The computers are: ${this.names()}.`);
    return this.session(row.id)!;
  }

  /** Run `action` on the computer a tool call names, as the invocation `use`. */
  async act<T>(
    use: ComputerUse,
    session: ComputerSession,
    action: (computer: Computer) => Promise<T>,
    channel: ModelChannel,
    inspection = false,
  ): Promise<T> {
    if (use.computerId !== session.id) {
      for (const other of this.sessions()) {
        if (other !== session && other.access.holds(use)) other.access.yield(use);
      }
      use.computerId = session.id;
    }
    return session.act(use, action, channel, inspection);
  }

  /**
   * The computer an invocation used last, which its help requests are about; before it
   * has used one, the computer a call that names none would use.
   */
  current(use: ComputerUse): ComputerSession {
    const used = use.computerId ? this.session(use.computerId) : undefined;
    if (used) return used;
    try {
      return this.resolve(use);
    } catch {
      return this.local;
    }
  }

  /**
   * A remote computer's link came up. A link already open for it is replaced, and ends
   * the way a dropped link ends, the hold it took included.
   */
  linked(id: string, computer: RemoteComputer, link: ComputerLink): void {
    const previous = this.links.get(id);
    this.links.set(id, { computer, link });
    if (previous) {
      previous.link.close(LINK_CLOSE.replaced, 'replaced by a newer link');
      this.session(id)?.lost(previous.computer);
    }
    this.session(id)?.connected(computer);
    this.emit('change');
  }

  /** Whether `computer` is the one linked for `id` right now. */
  isLinked(id: string, computer: RemoteComputer): boolean {
    return this.links.get(id)?.computer === computer;
  }

  unlinked(id: string, computer: RemoteComputer): void {
    if (this.links.get(id)?.computer !== computer) return;
    this.links.delete(id);
    this.remotes.get(id)?.lost(computer);
    this.emit('change');
  }

  /**
   * Remove a remote computer: its link closes, and the runs holding or waiting for it are
   * told so at their next step. False when there was no such computer.
   */
  async remove(id: string, userId: string): Promise<boolean> {
    const name = remoteComputerService.get(id)?.name;
    if (!(await remoteComputerService.remove(id, userId))) return false;
    const linked = this.links.get(id);
    this.links.delete(id);
    const session = this.remotes.get(id);
    this.remotes.delete(id);
    // The link's close handler finds the link gone and does nothing, so its end runs here:
    // whatever the person at the computer held, and any secure window, end with it.
    if (linked) session?.lost(linked.computer);
    await session?.access.retire(new Error(`${name ?? 'That computer'} was removed.`));
    linked?.link.close(LINK_CLOSE.removed, 'computer removed');
    await linked?.computer.stop();
    this.emit('change');
    return true;
  }

  summaries(): ComputerSummary[] {
    const list: ComputerSummary[] = [];
    if (hasComputer()) {
      list.push({
        id: LOCAL_COMPUTER_ID,
        kind: 'local',
        name: 'This runtime',
        connection: 'connected',
        platform: 'linux',
        clientVersion: null,
        display: { ...DEFAULT_SCREEN },
        capabilities: [...CAPABILITIES],
        problems: [],
        lastConnectedAt: null,
        lastSeenAt: null,
        ...this.useOf(this.local),
      });
    }
    for (const row of remoteComputerService.list()) {
      const session = this.session(row.id)!;
      const info = this.links.get(row.id)?.computer.info();
      list.push({
        id: row.id,
        kind: 'remote',
        name: row.name,
        connection: info ? 'connected' : 'disconnected',
        platform: info?.platform ?? row.platform,
        clientVersion: info?.clientVersion ?? row.clientVersion,
        display: info?.display ?? null,
        capabilities: info?.capabilities ?? [],
        problems: info?.problems ?? [],
        lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        ...this.useOf(session),
      });
    }
    return list;
  }

  /**
   * The computers line of a turn's notices, for a run that may use a remote computer
   * while any exists. It changes with every connection, so it never goes in the cached prompt.
   */
  notice(mode: string): string | null {
    if (!usesRemoteComputers(mode) || remoteComputerService.count === 0) return null;
    const rows = remoteComputerService.list();
    const parts = [
      ...(hasComputer() ? ['"local" (your own computer)'] : []),
      ...rows.map((row) => {
        const info = this.links.get(row.id)?.computer.info();
        const platform = info?.platform ?? row.platform;
        const traits = [
          platform ? PLATFORM_NAMES[platform] ?? platform : null,
          info ? 'connected' : 'not connected',
          platform && SUPER_KEY[platform] ? SUPER_KEY[platform] : null,
        ].filter(Boolean);
        return `${JSON.stringify(row.name)} (${traits.join(', ')})`;
      }),
    ];
    const fallback = hasComputer()
      ? 'your own computer'
      : rows.length === 1
        ? JSON.stringify(rows[0].name)
        : null;
    return (
      `Computers you can use: ${parts.join('; ')}. A remote computer is your user's own machine. ` +
      'Pass its name as `computer` to use it; ' +
      (fallback ? `without one, the computer tools use ${fallback}.` : 'every computer tool call needs one.')
    );
  }

  async close(): Promise<void> {
    for (const { link } of this.links.values()) link.close(LINK_CLOSE.shuttingDown, 'runtime shutting down');
    this.links.clear();
    await Promise.all([...this.remotes.values()].map((session) => session.close()));
    await this.local.close();
  }

  private names(): string {
    return [
      ...(hasComputer() ? [`"${LOCAL_COMPUTER_ID}"`] : []),
      ...remoteComputerService.list().map((row) => JSON.stringify(row.name)),
    ].join(', ');
  }

  private useOf(session: ComputerSession): Pick<ComputerSummary, 'owner' | 'controller'> {
    const owner = session.access.owner;
    return {
      owner: owner ? { threadId: owner.threadId, mode: owner.mode } : null,
      controller: session.controller,
    };
  }
}

export const computerService = new ComputerService();
