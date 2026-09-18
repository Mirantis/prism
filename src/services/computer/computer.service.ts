import { AgentComputer, type ModelChannel } from './agent-computer';
import { ComputerAccess, type ComputerUse } from './computer-access';
import type { ScreenFrame } from './picture-stream';
import { DEFAULT_SCREEN } from './screen-size';
import { hasComputer } from './supported';
import type { SignInCredentials } from './sign-in-form';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';

/** How a sign-in the user answered ended. */
export type SignInOutcome =
  | 'filled'
  | 'no_form'
  | 'tab_gone'
  | 'site_changed'
  | 'in_use'
  | 'error';

export interface ComputerViewer {
  screen(frame: ScreenFrame): void;
  audio(pcm: Buffer): void;
}

/** The runtime's desktop, independent of calls, invocations, and viewers. */
class ComputerService {
  readonly access = new ComputerAccess(() => this.forgetSecureWindow());
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
      secure: this.access.secure,
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

  /** A takeover answering a help request is secure: pass that request's id. */
  async takeControl(id: string, help?: { id: string; targetId?: string }): Promise<void> {
    if (!this.viewers.has(id)) throw new Error('Open Computer before taking control.');
    await this.access.takeControl(id, help?.id);
    if (help?.targetId) await this.computer?.focusTarget(help.targetId);
  }

  /** Nothing a person typed inside a secure window reaches the agent after it. */
  private async forgetSecureWindow(): Promise<void> {
    await this.computer?.clearAfterSecureWindow();
  }

  async helpTarget(tab?: number): Promise<string | undefined> {
    return this.computer?.tabTarget(tab);
  }

  /** The site of a sign-in the user can answer with a username and a password. */
  async signInSite(tab?: number): Promise<string | undefined> {
    return this.computer?.signInForm(tab);
  }

  /**
   * Type a sign-in the user answered, with the agent stopped for as long as it takes.
   *
   * The window around it is the one a takeover opens, so nothing decides anything while
   * a field holds a password, and the fields are cleared when it closes.
   */
  async signIn(
    help: { id: string; targetId?: string; site?: string },
    credentials: SignInCredentials,
    userId: string,
    agentId?: string,
  ): Promise<SignInOutcome> {
    const startedAt = Date.now();
    const outcome = await this.runSignIn(help, credentials);
    trackEvent('computer sign-in filled', userId, {
      ...(agentId ? { 'agent.id': agentId } : {}),
      'computer.help_id': help.id,
      status: outcome,
      elapsed_ms: String(Date.now() - startedAt),
    });
    return outcome;
  }

  private async runSignIn(
    help: { id: string; targetId?: string; site?: string },
    credentials: SignInCredentials,
  ): Promise<SignInOutcome> {
    const computer = this.computer;
    if (!computer || !help.targetId || !help.site) return 'tab_gone';
    // Somebody is at the keyboard: their takeover pauses the desktop, and this one would
    // queue behind it and type into a screen they are using.
    if (this.access.paused) return 'in_use';
    try {
      return await this.access.runSecure(help.id, () =>
        computer.signIn(help.targetId!, help.site!, credentials),
      );
    } catch (err) {
      logger.error({ err }, '[Computer] A sign-in could not be typed');
      return 'error';
    }
  }

  assertCanHandBack(id: string): void {
    if (!this.viewers.has(id)) throw new Error('Open Computer before continuing.');
    this.access.assertCanHandBack(id);
  }

  async handBack(id: string): Promise<void> {
    this.assertCanHandBack(id);
    this.computer?.releaseInput();
    await this.access.handBack(id);
  }

  async continueFromChat(): Promise<void> {
    const id = this.access.human ?? 'chat';
    this.access.assertCanHandBack(id);
    this.computer?.releaseInput();
    await this.access.handBack(id);
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
