import { AgentComputer, type ModelChannel } from './agent-computer';
import { ComputerAccess, type ComputerUse } from './computer-access';
import type { ScreenFrame } from './picture-stream';
import { DEFAULT_SCREEN } from './screen-size';
import { hasComputer } from './supported';
import { logger } from '../../logger';

export interface ComputerViewer {
  screen(frame: ScreenFrame): void;
  audio(pcm: Buffer): void;
}

/** The runtime's desktop, independent of calls, invocations, and viewers. */
class ComputerService {
  readonly access = new ComputerAccess();
  private computer: AgentComputer | null = null;
  private opening: Promise<AgentComputer> | null = null;
  private viewers = new Map<string, ComputerViewer>();
  private ready = new Set<string>();

  status() {
    const describe = (use: ComputerUse) => ({ id: use.id, threadId: use.threadId, mode: use.mode });
    return {
      available: hasComputer(),
      running: this.computer !== null,
      starting: this.opening !== null,
      paused: this.access.paused,
      controller: this.access.human,
      owner: this.access.owner ? describe(this.access.owner) : null,
      waiting: this.access.waiting.map(describe),
    };
  }

  async open(): Promise<AgentComputer> {
    if (this.computer) return this.computer;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const computer = new AgentComputer();
      try {
        await computer.openBrowser(DEFAULT_SCREEN);
        this.computer = computer;
        computer.startBrowserAudio((pcm) => {
          for (const viewer of this.viewers.values()) viewer.audio(pcm);
        });
        return computer;
      } catch (error) {
        await computer.stop();
        throw error;
      } finally {
        this.opening = null;
        this.access.emit('change');
      }
    })();
    this.access.emit('change');
    return this.opening;
  }

  async act<T>(
    use: ComputerUse,
    action: (computer: AgentComputer) => Promise<T>,
    channel: ModelChannel,
    inspection = false,
  ): Promise<T> {
    return this.access.run(
      use,
      async () => {
        const computer = await this.open();
        return computer.withModelChannel(channel, () => action(computer));
      },
      inspection,
    );
  }

  async attach(id: string, viewer: ComputerViewer): Promise<() => void> {
    this.viewers.set(id, viewer);
    try {
      const computer = await this.open();
      if (this.viewers.has(id)) {
        // Restart the encoder so every viewer receives a decoder configuration and keyframe.
        this.ready.clear();
        computer.startScreenStream((frame) => {
          for (const [viewerId, client] of this.viewers) {
            if (frame.kind === 'start') client.screen(frame);
            else if (frame.kind !== 'h264' || frame.keyframe || this.ready.has(viewerId)) {
              this.ready.add(viewerId);
              client.screen(frame);
            }
          }
        });
      }
    } catch (error) {
      this.detach(id);
      throw error;
    }
    return () => this.detach(id);
  }

  detach(id: string): void {
    this.viewers.delete(id);
    this.ready.delete(id);
    this.access.disconnected(id);
    if (!this.viewers.size) this.computer?.stopScreenStream();
  }

  async takeControl(id: string, targetId?: string): Promise<void> {
    if (!this.viewers.has(id)) throw new Error('Open Computer before taking control.');
    await this.access.takeControl(id);
    if (targetId) await this.computer?.focusTarget(targetId);
  }

  async helpTarget(tab?: number): Promise<string | undefined> {
    return this.computer?.tabTarget(tab);
  }

  handBack(id: string): void {
    if (!this.viewers.has(id)) throw new Error('Open Computer before continuing.');
    this.computer?.releaseInput();
    this.access.handBack(id);
  }

  continueFromChat(): void {
    this.computer?.releaseInput();
    this.access.handBack(this.access.human ?? 'chat');
  }

  input(id: string, text: string): void {
    let frame: { type?: string };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.type === 'viewport') return;
    if (frame.type?.startsWith('user_screen')) {
      this.computer?.handleInput(text);
      return;
    }
    if (this.access.human === id && this.access.paused) this.computer?.handleInput(text);
  }

  async close(): Promise<void> {
    this.access.stop();
    for (const use of this.access.waiting) use.controller.abort();
    await this.opening?.catch(() => {});
    const computer = this.computer;
    this.computer = null;
    this.viewers.clear();
    await computer?.stop().catch((err) => logger.warn({ err }, '[Computer] Shutdown failed'));
  }
}

export const computerService = new ComputerService();
