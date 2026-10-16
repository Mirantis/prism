/**
 * A computer outside the runtime, used over its link.
 *
 * The client on that computer captures, types and reads its windows and controls; this
 * side does everything the runtime's own desktop also does around those: the model's
 * picture size and the coordinates in it, waiting for the screen to settle, OCR where the
 * computer offers no controls, and a viewer's pointer and keys. Coordinates on the link
 * are pixels of the display's full capture.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../../../logger';
import { hasBinaries } from '../../../lib/has-binary';
import { ACTION_SETTLE_MS, WINDOW_ACTION_DONE, type ModelChannel } from '../agent-computer';
import type { Computer } from '../computer';
import type { DesktopActionResult, TextLocation, WindowAction } from '../computer-tools';
import type { MouseButton, ScrollDirection } from '../desktop-control';
import { chordFor, inputFrame, pasteText } from '../desktop-input';
import { findWindows } from '../desktop-windows';
import type { ScreenFrame } from '../picture-stream';
import { describeElements, findElements, type ScreenElement } from '../screen-elements';
import { boundedPictureFor, MAX_SCREEN, type ScreenSize } from '../screen-size';
import { findText, readScreenWords, upscaleForOcr } from '../screen-text';
import { ComputerLink, LinkError } from './computer-link';
import {
  captureResult,
  elementsResult,
  emptyResult,
  LINK_JPEG_FRAME,
  LINK_KEYFRAME_FLAG,
  LINK_VIDEO_FRAME,
  streamStartResult,
  windowsResult,
  capabilitiesChangedParams,
  displaysChangedParams,
  type Capability,
  type CapabilityProblem,
  type InitializeParams,
  type RemoteDisplay,
  type RemotePlatform,
} from './link-protocol';

/** How long an input request may take on the computer, and a read of its screen or controls. */
const INPUT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;
/** Extra time a typed text gets per character, up to a cap. */
const TYPE_MS_PER_CHAR = 50;
const TYPE_TIMEOUT_CAP_MS = 120_000;
/** How many pointer positions a drag walks through between press and release. */
const DRAG_STEPS = 10;
/** How long a viewer's movement is gathered before one position goes out. */
const MOVE_FLUSH_MS = 16;
const WHEEL_PIXELS_PER_CLICK = 60;
const MAX_WHEEL_CLICKS = 10;
/** The picture quality the model's screenshots are asked for. */
const CAPTURE_QUALITY = 80;

const CAPABILITY_WORDS: Record<Capability, string> = {
  screen: 'show its screen',
  input: 'take mouse and keyboard input',
  windows: 'list its windows',
  elements: 'read its controls',
  stream: 'stream its screen',
};

/** What the runtime knows about the computer on the other end of a link. */
interface RemoteComputerInfo {
  platform: RemotePlatform;
  clientVersion: string;
  display: ScreenSize;
  capabilities: Capability[];
  problems: CapabilityProblem[];
}

function primary(displays: RemoteDisplay[]): RemoteDisplay {
  return displays.find((display) => display.primary) ?? displays[0];
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

export class RemoteComputer implements Computer {
  private channels = new AsyncLocalStorage<ModelChannel>();
  private tail: Promise<void> = Promise.resolve();
  private display: RemoteDisplay;
  private capabilities: Set<Capability>;
  private problems: CapabilityProblem[];
  /** Where the agent's pointer and a viewer's pointer are, in display pixels. */
  private pointer: { x: number; y: number };
  /** The buttons a viewer holds down, so handing back can let go of them. */
  private held = new Set<MouseButton>();
  private moveTimer: NodeJS.Timeout | null = null;
  private stream: {
    onFrame: (frame: ScreenFrame) => void;
    /**
     * Set when the answer to `stream.start` is read. A frame before it belongs to the
     * stream this one replaced, which a decoder set up for this one cannot read.
     */
    started: boolean;
    size: ScreenSize;
  } | null = null;
  private ocrAvailable: Promise<boolean> | null = null;
  /** The size of the last picture the model saw of this display. */
  private seen: ScreenSize | null = null;
  /** The viewers' frame sink, kept while they watch, whether or not a stream runs. */
  private watcher: ((frame: ScreenFrame) => void) | null = null;

  /** `nameOf` is read on every use, so a rename applies to a computer already connected. */
  constructor(
    private readonly nameOf: () => string,
    private readonly link: ComputerLink,
    private readonly hello: InitializeParams,
    /** Called when what the computer reports about itself changes, for the list to show. */
    private readonly onChange: () => void = () => {},
  ) {
    this.display = primary(hello.displays);
    this.capabilities = new Set(hello.capabilities);
    this.problems = hello.problems;
    this.pointer = { x: Math.floor(this.display.width / 2), y: Math.floor(this.display.height / 2) };
    link.on('notification', (method: string, params: unknown) => this.notified(method, params));
    link.on('binary', (data: Buffer) => this.frame(data));
  }

  info(): RemoteComputerInfo {
    return {
      platform: this.hello.platform,
      clientVersion: this.hello.client.version,
      display: { width: this.display.width, height: this.display.height },
      capabilities: [...this.capabilities],
      problems: this.problems,
    };
  }

  get name(): string {
    return this.nameOf();
  }

  private get channel(): ModelChannel | null {
    return this.channels.getStore() ?? null;
  }

  /** The largest picture the model is shown, which a capture is asked for. */
  private get picture(): ScreenSize {
    return boundedPictureFor({ width: this.display.width, height: this.display.height });
  }

  /** The picture the model's coordinates refer to: the last one it saw, else the one asked for. */
  private get seenPicture(): ScreenSize {
    return this.seen ?? this.picture;
  }

  get width(): number {
    return this.seenPicture.width;
  }

  get height(): number {
    return this.seenPicture.height;
  }

  withModelChannel<T>(channel: ModelChannel, action: () => Promise<T>): Promise<T> {
    return this.channels.run(channel, action);
  }

  // ---------------------------------------------------------------------------
  // The model's tools

  async browse(): Promise<{ success: boolean; message: string }> {
    return {
      success: false,
      message:
        `${this.name} offers no browser control. Use its browser through the desktop tools: ` +
        'computer_screen, computer_click_text, computer_type and computer_key.',
    };
  }

  async lookAtScreen(): Promise<{ success: boolean; message: string }> {
    if (!this.can('screen')) return { success: false, message: this.missing('screen') };
    try {
      const shown = await this.onQueue(() => this.showScreen(this.lookNote()));
      return {
        success: shown,
        message: shown
          ? `This is the whole screen of ${this.name}, as a ${this.width} by ${this.height} picture; ` +
            'the desktop tools take coordinates from it.'
          : `I could not get the picture of ${this.name} through.`,
      };
    } catch (err) {
      logger.info(`[Computer:Remote] ${this.name}: screen capture failed: ${detail(err)}`);
      return { success: false, message: this.failure('I could not get a picture of the screen', err) };
    }
  }

  async lookAtUserScreen(): Promise<DesktopActionResult> {
    return { success: false, message: 'Your user is not sharing their screen right now.' };
  }

  async listElements(input: { filter?: string }): Promise<DesktopActionResult> {
    if (!this.can('elements')) return { success: false, message: this.missing('elements') };
    try {
      const elements = await this.onQueue(() => this.readElements(input.filter));
      return { success: true, message: describeElements(elements, input.filter) };
    } catch (err) {
      return { success: false, message: this.failure("I could not read the computer's controls", err) };
    }
  }

  async listWindows(): Promise<DesktopActionResult> {
    if (!this.can('windows')) return { success: false, message: this.missing('windows') };
    try {
      const windows = await this.readWindows();
      if (windows.length === 0) return { success: true, message: 'No windows are open.' };
      const lines = windows.map(
        (w) => `"${w.title}"${w.app ? ` (${w.app})` : ''} at (${w.x}, ${w.y}), ${w.width} by ${w.height}`,
      );
      return { success: true, message: `${windows.length} window(s):\n${lines.join('\n')}` };
    } catch (err) {
      return { success: false, message: this.failure('I could not list the windows', err) };
    }
  }

  async windowAction(input: { title: string; action: WindowAction }): Promise<DesktopActionResult> {
    if (!this.can('windows')) return { success: false, message: this.missing('windows') };
    let windows;
    try {
      windows = await this.readWindows();
    } catch (err) {
      return { success: false, message: this.failure('I could not list the windows', err) };
    }
    const [window] = findWindows(windows, input.title);
    if (!window) return { success: false, message: `There is no window with "${input.title}" in its title.` };
    return this.act(
      'windows',
      () => this.call('windows.act', { id: window.id, action: input.action }),
      `${WINDOW_ACTION_DONE[input.action]} "${window.title}"`,
    );
  }

  async findText(input: { text: string }): Promise<DesktopActionResult & { matches?: TextLocation[] }> {
    try {
      const matches = await this.locateText(input.text);
      if (matches === null) return { success: false, message: this.cannotRead() };
      if (matches.length === 0) {
        return { success: false, message: `I cannot see the text "${input.text}" on the screen right now.` };
      }
      return {
        success: true,
        message: `"${input.text}" appears ${matches.length === 1 ? 'once' : `${matches.length} times`} on the screen.`,
        matches,
      };
    } catch (err) {
      return { success: false, message: this.failure('I could not read the screen', err) };
    }
  }

  async clickText(input: {
    text: string;
    occurrence?: number;
    button?: MouseButton;
    double?: boolean;
  }): Promise<DesktopActionResult> {
    let matches: TextLocation[] | null;
    try {
      matches = await this.locateText(input.text);
    } catch (err) {
      return { success: false, message: this.failure('I could not read the screen', err) };
    }
    if (matches === null) return { success: false, message: this.cannotRead() };
    if (matches.length === 0) {
      return { success: false, message: `I cannot see the text "${input.text}" on the screen right now.` };
    }
    const index = Math.min(matches.length, Math.max(1, input.occurrence ?? 1)) - 1;
    const target = matches[index];
    const others =
      matches.length > 1 ? ` (${matches.length} matches; clicked number ${index + 1}, in "${target.line}")` : '';
    return this.click({ x: target.x, y: target.y, button: input.button, double: input.double }, (verb) =>
      `${verb} "${target.text}" at (${target.x}, ${target.y})${others}`,
    );
  }

  move(input: { x: number; y: number }): Promise<DesktopActionResult> {
    const at = this.toDisplay(input.x, input.y);
    return this.act(
      'input',
      async () => {
        this.pointer = at;
        await this.call('input.pointer', at);
      },
      `Moved the pointer to (${Math.round(input.x)}, ${Math.round(input.y)})`,
    );
  }

  click(
    input: { x?: number; y?: number; button?: MouseButton; double?: boolean },
    describe?: (verb: string) => string,
  ): Promise<DesktopActionResult> {
    const button = input.button ?? 'left';
    const named = input.x !== undefined && input.y !== undefined;
    const at = named ? this.toDisplay(input.x!, input.y!) : this.pointer;
    const verb = input.double ? 'Double-clicked' : 'Clicked';
    const message = describe
      ? describe(verb)
      : named
        ? `${verb} ${button} at (${Math.round(input.x!)}, ${Math.round(input.y!)})`
        : `${verb} ${button} where the pointer was`;
    return this.act(
      'input',
      async () => {
        this.pointer = at;
        await this.call('input.click', { ...at, button, count: input.double ? 2 : 1 });
      },
      message,
    );
  }

  drag(input: { fromX: number; fromY: number; toX: number; toY: number; button?: MouseButton }): Promise<DesktopActionResult> {
    const button = input.button ?? 'left';
    const from = this.toDisplay(input.fromX, input.fromY);
    const to = this.toDisplay(input.toX, input.toY);
    return this.act(
      'input',
      async () => {
        // Notifications apply in arrival order, so only the release needs an answer.
        this.link.notify('input.pointer', from);
        this.link.notify('input.button', { button, down: true });
        for (let step = 1; step <= DRAG_STEPS; step++) {
          this.link.notify('input.pointer', {
            x: Math.round(from.x + ((to.x - from.x) * step) / DRAG_STEPS),
            y: Math.round(from.y + ((to.y - from.y) * step) / DRAG_STEPS),
          });
        }
        this.pointer = to;
        await this.call('input.button', { button, down: false });
      },
      `Dragged ${button} from (${Math.round(input.fromX)}, ${Math.round(input.fromY)}) to ` +
        `(${Math.round(input.toX)}, ${Math.round(input.toY)})`,
    );
  }

  type(input: { text: string }): Promise<DesktopActionResult> {
    const timeout = Math.min(TYPE_TIMEOUT_CAP_MS, INPUT_TIMEOUT_MS + input.text.length * TYPE_MS_PER_CHAR);
    return this.act(
      'input',
      () => this.call('input.text', { text: input.text }, timeout),
      `Typed ${input.text.length} character${input.text.length === 1 ? '' : 's'}`,
    );
  }

  key(input: { keys: string }): Promise<DesktopActionResult> {
    return this.act('input', () => this.call('input.key', { keys: input.keys }), `Pressed ${input.keys}`);
  }

  scroll(input: { x: number; y: number; direction: ScrollDirection; clicks?: number }): Promise<DesktopActionResult> {
    const at = this.toDisplay(input.x, input.y);
    const clicks = input.clicks ?? 3;
    return this.act(
      'input',
      async () => {
        this.pointer = at;
        await this.call('input.wheel', { ...at, dy: input.direction === 'down' ? clicks : -clicks });
      },
      `Scrolled ${input.direction} at (${Math.round(input.x)}, ${Math.round(input.y)})`,
    );
  }

  // ---------------------------------------------------------------------------
  // Viewers

  startScreenStream(onFrame: (frame: ScreenFrame) => void): void {
    // Kept even when the computer cannot stream yet, so the stream starts once it can.
    this.watcher = onFrame;
    if (!this.can('stream')) return;
    const stream = { onFrame, started: false, size: this.displaySize() };
    this.stream = stream;
    void this.link
      .request(
        'stream.start',
        { display: this.display.id, encodings: ['h264', 'jpeg'], maxWidth: MAX_SCREEN.width, fps: 30 },
        streamStartResult,
        READ_TIMEOUT_MS,
        // The client answers before this stream's first frame, so the answer is where it begins.
        (started) => {
          if (this.stream !== stream) return;
          stream.size = { width: started.width, height: started.height };
          stream.started = true;
          onFrame(
            started.encoding === 'h264'
              ? { kind: 'start', encoding: 'h264', codec: started.codec ?? 'avc1.42E01F' }
              : { kind: 'start', encoding: 'jpeg' },
          );
        },
      )
      .catch((err) => {
        if (this.stream === stream) this.stream = null;
        logger.warn(`[Computer:Remote] ${this.name}: the screen stream did not start: ${detail(err)}`);
      });
  }

  stopScreenStream(): void {
    this.watcher = null;
    if (!this.stream) return;
    this.stream = null;
    void this.link.request('stream.stop', undefined, emptyResult, INPUT_TIMEOUT_MS).catch(() => {});
  }

  /** A viewer's pointer and keyboard while it holds the computer; positions are stream pixels. */
  handleInput(text: string): void {
    if (!this.can('input')) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const frame = inputFrame(value);
    if (!frame) return;
    switch (frame.type) {
      case 'pointer':
        this.pointer = this.fromStream(frame.x, frame.y);
        this.moveNow();
        return;
      case 'pointer_move': {
        const scale = this.streamScale();
        this.pointer = this.clamp(this.pointer.x + frame.dx * scale.x, this.pointer.y + frame.dy * scale.y);
        this.scheduleMove();
        return;
      }
      case 'pointer_button':
        this.flushMove();
        if (frame.down) this.held.add(frame.button);
        else this.held.delete(frame.button);
        this.link.notify('input.button', { button: frame.button, down: frame.down });
        return;
      case 'wheel': {
        const clicks = Math.min(MAX_WHEEL_CLICKS, Math.max(1, Math.round(Math.abs(frame.dy) / WHEEL_PIXELS_PER_CLICK)));
        this.flushMove();
        this.link.notify('input.wheel', { ...this.pointer, dy: frame.dy > 0 ? clicks : -clicks });
        return;
      }
      case 'key': {
        const keys = chordFor(frame, 'super');
        if (keys) this.link.notify('input.key', { keys });
        return;
      }
      case 'text': {
        const typed = pasteText(frame.text);
        if (typed) this.link.notify('input.text', { text: typed });
        return;
      }
    }
  }

  releaseInput(): void {
    this.flushMove();
    for (const button of this.held) this.link.notify('input.button', { button, down: false });
    this.held.clear();
  }

  // ---------------------------------------------------------------------------
  // What only a browser this runtime controls can do

  async clearAfterSecureWindow(): Promise<void> {}

  async tabTarget(): Promise<string | undefined> {
    return undefined;
  }

  async focusTarget(): Promise<void> {}

  async signInForm(): Promise<undefined> {
    return undefined;
  }

  async signIn(): Promise<'no_form'> {
    return 'no_form';
  }

  async stop(): Promise<void> {
    this.stream = null;
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
  }

  // ---------------------------------------------------------------------------

  private notified(method: string, params: unknown): void {
    if (method === 'displays.changed') {
      const parsed = displaysChangedParams.safeParse(params);
      if (!parsed.success) return;
      const before = this.display;
      this.display = primary(parsed.data.displays);
      this.pointer = this.clamp(this.pointer.x, this.pointer.y);
      const moved =
        before.id !== this.display.id || before.width !== this.display.width || before.height !== this.display.height;
      if (!moved) return;
      // The model's last picture and the viewers' stream are of the display that went.
      this.seen = null;
      if (this.stream) this.startScreenStream(this.stream.onFrame);
      this.onChange();
      return;
    }
    if (method === 'capabilities.changed') {
      const parsed = capabilitiesChangedParams.safeParse(params);
      if (!parsed.success) return;
      const couldStream = this.can('stream');
      this.capabilities = new Set(parsed.data.capabilities);
      this.problems = parsed.data.problems;
      if (!couldStream && this.can('stream') && this.watcher) this.startScreenStream(this.watcher);
      // The watcher stays, so the stream starts again when the permission comes back.
      if (couldStream && !this.can('stream')) this.stream = null;
      this.onChange();
    }
  }

  /** A binary frame of the screen stream, passed on as the viewer socket sends it. */
  private frame(data: Buffer): void {
    const stream = this.stream;
    if (!stream?.started || data.length < 2) return;
    const body = data.subarray(2);
    if (data[0] === LINK_VIDEO_FRAME) {
      stream.onFrame({ kind: 'h264', data: body, keyframe: (data[1] & LINK_KEYFRAME_FLAG) !== 0 });
    } else if (data[0] === LINK_JPEG_FRAME) {
      stream.onFrame({ kind: 'jpeg', data: body.toString('base64') });
    }
  }

  private can(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  private missing(capability: Capability): string {
    const problem = this.problems.find((item) => item.capability === capability);
    return `${this.name} cannot ${CAPABILITY_WORDS[capability]}${problem ? `: ${problem.message}` : '.'}`;
  }

  private cannotRead(): string {
    return this.can('elements') ? `I could not read the screen of ${this.name}.` : this.missing('elements');
  }

  /** What the model is told when the computer or the link refused. */
  private failure(what: string, err: unknown): string {
    const message = `${what}: ${detail(err)}`;
    if (!(err instanceof LinkError)) return message;
    if (err.reason === 'permission_denied') {
      const permission = typeof err.data.permission === 'string' ? err.data.permission : 'the permission it needs';
      return `${message} Ask your user to grant ${permission} to the computer client on ${this.name}.`;
    }
    if (err.reason === 'held') return `${message} The person at ${this.name} has control; wait until they hand it back.`;
    return message;
  }

  private lookNote(): string {
    return (
      `This is a picture of the screen of ${this.name}, a computer your user connected, as it looks ` +
      'right now, in answer to your computer_screen call. Your user did not say this.'
    );
  }

  private afterNote(): string {
    return (
      `This is a picture of the screen of ${this.name} right after the desktop action you just took. ` +
      'Your user did not say this.'
    );
  }

  private call(method: string, params: unknown, timeoutMs = INPUT_TIMEOUT_MS): Promise<unknown> {
    return this.link.request(method, params, emptyResult, timeoutMs);
  }

  /** Run one action, wait for the screen to settle, and show the model the result. */
  private act(capability: Capability, action: () => Promise<unknown>, message: string): Promise<DesktopActionResult> {
    if (!this.can(capability)) return Promise.resolve({ success: false, message: this.missing(capability) });
    return this.onQueue(async () => {
      try {
        await action();
      } catch (err) {
        logger.info(`[Computer:Remote] ${this.name}: ${message} failed: ${detail(err)}`);
        return { success: false, message: this.failure('That did not work', err) };
      }
      if (!this.can('screen')) return { success: true, message: `${message}.` };
      await new Promise((resolve) => setTimeout(resolve, ACTION_SETTLE_MS));
      const shown = await this.showScreen(this.afterNote()).catch(() => false);
      return {
        success: true,
        message: shown
          ? `${message}. The picture shows the screen now.`
          : `${message}. I could not get a picture afterwards.`,
      };
    });
  }

  /**
   * One picture of the screen into the session. Its own size is what the model's next
   * coordinates refer to. One larger than asked for is refused: a provider may shrink it
   * before the model sees it, to a scale the runtime cannot know.
   */
  private async showScreen(note: string): Promise<boolean> {
    const asked = this.picture;
    const shot = await this.link.request(
      'screen.capture',
      {
        display: this.display.id,
        format: 'jpeg',
        maxWidth: asked.width,
        maxHeight: asked.height,
        quality: CAPTURE_QUALITY,
      },
      captureResult,
      READ_TIMEOUT_MS,
    );
    // A client that keeps the display's shape may round the height by a pixel or two.
    if (shot.width > asked.width || shot.height > asked.height + 2) {
      throw new LinkError(
        `The computer sent a ${shot.width} by ${shot.height} picture, larger than the ${asked.width} by ${asked.height} it was asked for.`,
        'internal',
      );
    }
    this.seen = { width: shot.width, height: shot.height };
    return this.channel?.showImage(`data:${shot.mediaType};base64,${shot.data}`, note) ?? false;
  }

  /**
   * The computer's controls, in the model's picture coordinates. `filter` lets the client
   * stop early; the callers match names again, so a client may ignore it.
   */
  private async readElements(filter?: string): Promise<ScreenElement[]> {
    const { elements } = await this.link.request(
      'elements.list',
      filter ? { filter } : {},
      elementsResult,
      READ_TIMEOUT_MS,
    );
    return elements.map((e) => {
      const [x, y] = this.toPicture(e.x, e.y);
      const [right, bottom] = this.toPicture(e.x + e.width, e.y + e.height);
      return { ...e, x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
    });
  }

  /** The open windows, in the model's picture coordinates. */
  private async readWindows() {
    const { windows } = await this.link.request('windows.list', {}, windowsResult, READ_TIMEOUT_MS);
    return windows.map((w) => {
      const [x, y] = this.toPicture(w.x, w.y);
      const [right, bottom] = this.toPicture(w.x + w.width, w.y + w.height);
      return { ...w, x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
    });
  }

  /**
   * Find `query` on the screen in picture coordinates: a control of that name first, else
   * words read off a full-size capture. Null when the computer offers neither.
   */
  private async locateText(query: string): Promise<TextLocation[] | null> {
    const ocr = this.can('screen') && (await this.canReadText());
    if (!this.can('elements') && !ocr) return null;
    return this.onQueue(async () => {
      if (this.can('elements')) {
        const widgets = findElements(await this.readElements(query), query);
        if (widgets.length > 0 || !ocr) {
          return widgets.map((e) => ({
            text: e.name,
            line: `${e.role}${e.app ? ` in ${e.app}` : ''}`,
            x: Math.round(e.x + e.width / 2),
            y: Math.round(e.y + e.height / 2),
          }));
        }
      }
      const shot = await this.link.request(
        'screen.capture',
        { display: this.display.id, format: 'png' },
        captureResult,
        READ_TIMEOUT_MS,
      );
      // A high-density screen already draws text large enough to read; a plain one is enlarged.
      const scale = this.display.scale >= 2 ? 1 : 2;
      const raw = Buffer.from(shot.data, 'base64');
      const png = scale > 1 ? await upscaleForOcr(raw, scale) : raw;
      const words = await readScreenWords(png, scale);
      const ratio = this.seenPicture.width / shot.width;
      return findText(words, query).map((m) => ({
        text: m.text,
        line: m.line,
        x: Math.round(m.x * ratio),
        y: Math.round(m.y * ratio),
      }));
    });
  }

  private canReadText(): Promise<boolean> {
    this.ocrAvailable ??= hasBinaries('ffmpeg', 'tesseract');
    return this.ocrAvailable;
  }

  private displaySize(): ScreenSize {
    return { width: this.display.width, height: this.display.height };
  }

  private clamp(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.min(this.display.width - 1, Math.max(0, Math.round(x))),
      y: Math.min(this.display.height - 1, Math.max(0, Math.round(y))),
    };
  }

  private toDisplay(x: number, y: number): { x: number; y: number } {
    const picture = this.seenPicture;
    return this.clamp((x * this.display.width) / picture.width, (y * this.display.height) / picture.height);
  }

  private toPicture(x: number, y: number): [number, number] {
    const picture = this.seenPicture;
    return [(x * picture.width) / this.display.width, (y * picture.height) / this.display.height];
  }

  private streamScale(): { x: number; y: number } {
    const size = this.stream?.size ?? this.displaySize();
    return { x: this.display.width / size.width, y: this.display.height / size.height };
  }

  private fromStream(x: number, y: number): { x: number; y: number } {
    const scale = this.streamScale();
    return this.clamp(x * scale.x, y * scale.y);
  }

  private scheduleMove(): void {
    if (this.moveTimer) return;
    this.moveTimer = setTimeout(() => this.moveNow(), MOVE_FLUSH_MS);
  }

  private flushMove(): void {
    if (this.moveTimer) this.moveNow();
  }

  private moveNow(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.link.notify('input.pointer', this.pointer);
  }

  private onQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}
