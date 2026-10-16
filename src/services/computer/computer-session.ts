import type { ModelChannel } from './agent-computer';
import type { Computer } from './computer';
import { ComputerAccess, type ComputerKind, type ComputerUse } from './computer-access';
import type { ScreenFrame } from './picture-stream';
import type { SignInCredentials } from './sign-in-form';
import { hasComputer } from './supported';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';

/** How a sign-in the user answered ended. */
export type SignInOutcome =
  | 'filled'
  | 'no_form'
  | 'no_password_step'
  | 'tab_gone'
  | 'site_changed'
  | 'in_use'
  | 'error';

export interface ComputerViewer {
  screen(frame: ScreenFrame): void;
  audio(pcm: Buffer): void;
}

/** The control a person at a remote computer takes, as `ComputerAccess` names it. */
const LOCAL_CONTROLLER = 'local';

/** What a hand-back from chat is told while the person at the computer holds it. */
export const HELD_LOCALLY =
  'The person at the computer still has control. It continues when they hand it back there.';

/**
 * One computer, independent of calls, invocations, and viewers: who uses it and who
 * watches it. `open` brings the computer up, and a session caches what it returns until
 * the computer goes away.
 */
export class ComputerSession<C extends Computer = Computer> {
  readonly access: ComputerAccess;
  private computer: C | null = null;
  private opening: Promise<C> | null = null;
  private viewers = new Map<string, ComputerViewer>();
  private ready = new Set<string>();
  /** Whether the person at a remote computer holds it. */
  private heldLocally = false;

  constructor(
    readonly id: string,
    readonly kind: ComputerKind,
    private readonly start: () => Promise<C>,
  ) {
    this.access = new ComputerAccess(() => this.forgetSecureWindow(), kind);
  }

  status() {
    const describe = (use: ComputerUse) => ({ id: use.id, threadId: use.threadId, mode: use.mode });
    return {
      computerId: this.id,
      // The runtime's own desktop can come up when the host has one; a remote one is up or not.
      available: this.kind === 'local' ? hasComputer() : this.computer !== null,
      running: this.computer !== null,
      starting: this.opening !== null,
      paused: this.access.paused,
      secure: this.access.secure,
      controller: this.access.human,
      owner: this.access.owner ? describe(this.access.owner) : null,
      waiting: this.access.waiting.map(describe),
    };
  }

  get watched(): boolean {
    return this.viewers.size > 0;
  }

  /** Who holds the mouse and keyboard: a viewer, the person at a remote computer, or nobody. */
  get controller(): 'viewer' | 'local' | null {
    const human = this.access.human;
    return human === null ? null : human === LOCAL_CONTROLLER ? 'local' : 'viewer';
  }

  /** The desktop's sound, to every viewer. */
  broadcastAudio(pcm: Buffer): void {
    for (const viewer of this.viewers.values()) viewer.audio(pcm);
  }

  async open(): Promise<C> {
    if (this.computer) return this.computer;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      try {
        const computer = await this.start();
        this.computer = computer;
        return computer;
      } finally {
        this.opening = null;
        this.access.emit('change');
      }
    })();
    this.access.emit('change');
    return this.opening;
  }

  /** A remote computer's link came up: viewers already watching get its screen. */
  connected(computer: C): void {
    this.computer = computer;
    if (this.viewers.size) this.startStream(computer);
    this.access.emit('change');
  }

  /** The computer went away. A person holding it from there no longer does. */
  lost(computer: C): void {
    if (this.computer !== computer) return;
    this.computer = null;
    this.ready.clear();
    void this.releaseLocally().catch((err) =>
      logger.warn({ err }, '[Computer] Could not end the hold of a computer that went away'),
    );
    this.access.emit('change');
  }

  async act<T>(
    use: ComputerUse,
    action: (computer: Computer) => Promise<T>,
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

  /**
   * Show a viewer the screen. The runtime's own desktop comes up for it; a remote computer
   * that is not connected is shown once it connects.
   */
  async attach(id: string, viewer: ComputerViewer): Promise<() => void> {
    this.viewers.set(id, viewer);
    if (this.kind === 'remote') {
      if (this.computer) this.startStream(this.computer);
      this.access.emit('change');
      return () => this.detach(id);
    }
    try {
      const computer = await this.open();
      if (this.viewers.has(id)) this.startStream(computer);
    } catch (error) {
      this.detach(id);
      throw error;
    }
    return () => this.detach(id);
  }

  /** Restart the stream so every viewer receives a decoder configuration and keyframe. */
  private startStream(computer: Computer): void {
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

  detach(id: string): void {
    const watched = this.viewers.delete(id);
    this.ready.delete(id);
    this.access.disconnected(id);
    if (!this.viewers.size) this.computer?.stopScreenStream();
    if (watched && this.kind === 'remote') this.access.emit('change');
  }

  /** A takeover answering a help request is secure: pass that request's id. */
  async takeControl(id: string, help?: { id: string; targetId?: string }): Promise<void> {
    if (!this.viewers.has(id)) throw new Error('Open Computer before taking control.');
    await this.access.takeControl(id, help?.id);
    if (help?.targetId) await this.computer?.focusTarget(help.targetId);
  }

  /** The person at a remote computer takes it, secure while a help request waits on it. */
  async holdLocally(helpId?: string): Promise<void> {
    // Set first, so a release that arrives while the agent's action drains still applies.
    this.heldLocally = true;
    try {
      await this.access.takeControl(LOCAL_CONTROLLER, helpId);
    } catch (error) {
      this.heldLocally = false;
      throw error;
    }
  }

  async releaseLocally(): Promise<void> {
    if (!this.heldLocally) return;
    this.heldLocally = false;
    await this.access.handBack(LOCAL_CONTROLLER);
  }

  /** Nothing a person typed inside a secure window reaches the agent after it. */
  private async forgetSecureWindow(): Promise<void> {
    await this.computer?.clearAfterSecureWindow();
  }

  async helpTarget(tab?: number): Promise<string | undefined> {
    return this.computer?.tabTarget(tab);
  }

  /** The sign-in on a tab, when it holds one the user can answer. */
  async signInForm(
    tab?: number,
  ): Promise<{ origin: string; fields: 'both' | 'password'; targetId?: string } | undefined> {
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
    // The person at a remote computer holds it until their client releases it, and only
    // that release ends the secure window they may be typing in.
    if (this.access.human === LOCAL_CONTROLLER) throw new Error(HELD_LOCALLY);
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
