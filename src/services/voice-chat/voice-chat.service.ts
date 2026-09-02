/**
 * A voice chat from the web UI: the browser's microphone in, the agent's speech out,
 * and a web browser the agent works in beside the conversation.
 *
 * The same conversation loop the meeting bot runs (`VoiceConversation`), with the
 * user's browser in place of the meeting platform. One WebSocket on `/api/voice`
 * carries 48 kHz pcm16 mono both ways as binary frames; JSON text frames carry status
 * to the page. There is one person on the other end and the channel is the web UI, so
 * every utterance is answered (`responseMode: 'open'`) and nothing is gated.
 *
 * Each connection is its own session: a Realtime session, and a browser of its own
 * (`BrowserStack`, on its own profile) that `browse` and `see_screen` act on. The page
 * closing the socket ends it; the Realtime session dying ends the socket.
 */

import type { Server as HttpServer, IncomingMessage } from 'http';
import path from 'path';
import type { Page } from 'playwright-core';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from '../../logger';
import { config } from '../../config';
import { resolveDataDir } from '../../lib/data-dir';
import { contextService } from '../context.service';
import { buildSystemPromptParts } from '../../prompts/context-builder';
import { getVoiceChatInstructions } from '../../prompts/voice-chat-prompt';
import { VoiceConversation } from '../meeting/voice-conversation';
import { prepareMeetingTools } from '../meeting/tool-bridge';
import { isRealtimeConfigured } from '../meeting/openai-endpoint';
import { AudioStack, type AudioStackHandles } from '../meeting/audio-stack';
import { BrowserStack } from '../meeting/browser-stack';
import {
  capture,
  normalizeUrl,
  read,
  runBrowserCommand,
  summarizeTabs,
  type BrowserCommand,
  type BrowserReading,
  type BrowserResult,
} from '../meeting/browser-control';
import {
  createVoiceChatTools,
  mergePreparedTools,
  prepareRealtimeTools,
  type VoiceChatBrowser,
} from './voice-chat-tools';
import { ScreenStream } from './screen-stream';

export const VOICE_CHAT_PATH = '/api/voice';

/** Sent to the page as a JSON text frame. Audio goes as binary frames. */
export interface VoiceChatStatus {
  type: 'status';
  state: 'connecting' | 'ready' | 'ended' | 'error';
  message?: string;
}

/** One picture of the agent's browser, as base64 JPEG. */
export interface VoiceChatScreenFrame {
  type: 'screen';
  data: string;
}

export type VoiceChatFrame = VoiceChatStatus | VoiceChatScreenFrame;

/**
 * The first byte of a binary frame to the page says what the pcm16 after it is. The
 * second byte is padding, so the samples start on a 2-byte boundary.
 */
export const VOICE_FRAME = 0x01;
export const BROWSER_AUDIO_FRAME = 0x02;

function tagged(tag: number, pcm48k: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag, 0]), pcm48k]);
}

/** Whether a capture chunk is nothing but silence, which is most of them. */
function isSilent(pcm: Buffer): boolean {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return false;
  return true;
}

/**
 * What the agent's working tab shows before it goes anywhere. A page with content, so
 * the screen stream has a picture from the first second; `about:blank` never repaints
 * and so never produces a frame.
 */
const START_PAGE =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><title>Ready</title>' +
      '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#18181b;color:#a1a1aa;font:24px system-ui,sans-serif">Ready</body>',
  );

/** The label a screenshot carries into the session; see `meeting-bot.service.ts`. */
const SCREEN_LOOK_NOTE =
  'This is a picture of your own browser as it looks right now, in answer to your ' +
  'see_screen call. Your user did not say this.';

/** Everything one connection owns, released together when it ends. */
class VoiceChatSession implements VoiceChatBrowser {
  conversation: VoiceConversation | null = null;
  browser: BrowserStack | null = null;
  /** The first, blank tab `BrowserStack.start()` opens; `browse` works in others. */
  private mainPage: Page | null = null;
  /** A virtual display for the browser on a host without one (the container). */
  private display: AudioStack | null = null;
  /**
   * The virtual display's audio devices. The browser plays into their sink, and its
   * monitor is how the page gets to hear what the browser plays. Null on a host with
   * a real display, where the browser's sound comes out of the host's own speakers.
   */
  private audioHandles: AudioStackHandles | null = null;
  private screen: ScreenStream | null = null;
  /** Everything that moves the front tab runs in arrival order; see the meeting service. */
  private frontTail: Promise<void> = Promise.resolve();

  /**
   * Open the browser. Every voice chat has one, so a browser that cannot start ends
   * the chat before it begins: the error names the reason for the page.
   */
  async openBrowser(): Promise<void> {
    const browser = new BrowserStack();
    let display: AudioStack | null = null;
    try {
      let env: Record<string, string> = {};
      let handles: AudioStackHandles | null = null;
      if (process.platform === 'linux' && !process.env.DISPLAY) {
        display = new AudioStack();
        handles = await display.start();
        env = handles.browserEnv;
        // A meeting ends on this; here the browser's sound just stops reaching the page.
        handles.onLost((reason) =>
          logger.warn(`[VoiceChat] Browser audio capture lost: ${reason}`),
        );
      }
      this.mainPage = await browser.start({
        env,
        profileDir: path.join(resolveDataDir(), 'voice-chat-browser-profile'),
      });
      // The agent's working tab, open from the start so the page has something to show
      // and the agent's first navigation lands in it rather than opening a second one.
      const tab = await browser.openTab();
      await tab
        .goto(START_PAGE, { waitUntil: 'domcontentloaded', timeout: 10_000 })
        .catch((err) => logger.warn({ err }, '[VoiceChat] Start page did not load'));
      this.browser = browser;
      this.display = display;
      this.audioHandles = handles;
    } catch (err) {
      await browser.stop().catch(() => undefined);
      await display?.stop().catch(() => undefined);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not open the browser: ${reason}`);
    }
  }

  /** Start sending pictures of the tab in front; `openBrowser()` has to have run. */
  startScreenStream(onFrame: (jpegBase64: string) => void): void {
    this.screen = new ScreenStream(() => this.browser?.front() ?? null, onFrame);
    this.screen.start();
  }

  /**
   * Start handing on what the browser plays, 48 kHz pcm16 mono, silence left out.
   *
   * Returns false on a host with a real display: there the browser's sound already
   * comes out of the host's speakers, and there is no device to record it from.
   */
  startBrowserAudio(onPcm: (pcm48k: Buffer) => void): boolean {
    if (!this.audioHandles) return false;
    this.audioHandles.onCapture((pcm) => {
      if (!isSilent(pcm)) onPcm(pcm);
    });
    return true;
  }

  async browse(command: BrowserCommand): Promise<BrowserResult> {
    const browser = this.browser;
    if (!browser) return { success: false, message: 'There is no browser in this voice chat.' };

    return this.onFrontQueue(async () => {
      try {
        const result = await this.runBrowseCommand(browser, command);
        return { ...result, tabs: await summarizeTabs(browser.listTabs(), browser.front()) };
      } catch (err) {
        logger.error({ err }, '[VoiceChat] Browser command failed');
        return { success: false, message: 'I could not reach the browser.' };
      }
    });
  }

  async lookAtScreen(): Promise<{ success: boolean; message: string } & Partial<BrowserReading>> {
    const page = this.browser?.front();
    if (!page) return { success: false, message: 'There is no browser window open.' };

    try {
      const { imageUrl, reading } = await capture(page);
      const shown = this.conversation?.showImage(imageUrl, SCREEN_LOOK_NOTE) ?? false;
      return {
        success: true,
        message: shown
          ? 'This is what my browser is showing.'
          : 'Here is what the page says. I could not get the picture through.',
        ...reading,
      };
    } catch (err) {
      logger.error({ err }, '[VoiceChat] Screen capture failed');
      return { success: false, message: 'I could not get a picture of the browser.' };
    }
  }

  /** Release everything. Safe to call more than once. */
  async stop(): Promise<void> {
    this.conversation?.stop();
    this.conversation = null;
    const screen = this.screen;
    this.screen = null;
    await screen?.stop();
    const browser = this.browser;
    const display = this.display;
    this.browser = null;
    this.display = null;
    this.mainPage = null;
    this.audioHandles = null;
    await browser?.stop().catch(() => undefined);
    await display?.stop().catch(() => undefined);
  }

  private async onFrontQueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.frontTail.then(fn);
    this.frontTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** The tab commands are answered here; the rest go to the page. Same shape as the meeting's. */
  private async runBrowseCommand(
    browser: BrowserStack,
    command: BrowserCommand,
  ): Promise<BrowserResult> {
    switch (command.action) {
      case 'new_tab': {
        if (command.url && !normalizeUrl(command.url)) {
          return { success: false, message: `"${command.url}" is not a web address I can open.` };
        }
        const page = await browser.openTab();
        if (command.url) return runBrowserCommand(page, { action: 'navigate', url: command.url });
        return { success: true, message: 'Opened a new tab.', ...(await read(page)) };
      }

      case 'switch_tab': {
        const page = command.tab === undefined ? null : await browser.selectTab(command.tab - 1);
        if (!page) {
          return { success: false, message: `There is no tab ${command.tab ?? 'of that number'}.` };
        }
        return { success: true, message: `Switched to tab ${command.tab}.`, ...(await read(page)) };
      }

      case 'close_tab': {
        const tabs = browser.listTabs();
        const index =
          command.tab === undefined ? tabs.indexOf(browser.front() as Page) : command.tab - 1;
        if (index < 0 || !(await browser.closeTab(index))) {
          return { success: false, message: 'There is no such tab to close.' };
        }
        const page = browser.front();
        if (!page || page === this.mainPage) {
          return { success: true, message: 'Closed the last tab. Nothing is open now.' };
        }
        return { success: true, message: 'Closed the tab.', ...(await read(page)) };
      }

      default:
        return runBrowserCommand(await browser.workbench(), command);
    }
  }
}

class VoiceChatService {
  private wss: WebSocketServer | null = null;
  private readonly live = new Set<VoiceChatSession>();

  /**
   * Pick this endpoint's upgrades off the shared HTTP server.
   *
   * `noServer` because a `ws` server bound with `path` answers every other path's
   * upgrade with a 400, and `/api/ws` already lives on the same server.
   */
  initialize(server: HttpServer): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on('upgrade', (req, socket, head) => {
      if (pathnameOf(req) !== VOICE_CHAT_PATH) return;
      wss.handleUpgrade(req, socket, head, (ws) => void this.handleConnection(ws));
    });
    logger.info(`Voice chat gateway initialized on ${VOICE_CHAT_PATH}`);
  }

  private async handleConnection(ws: WebSocket): Promise<void> {
    const send = (frame: VoiceChatFrame): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const sendAudio = (tag: number, pcm48k: Buffer): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(tagged(tag, pcm48k), { binary: true });
    };

    const agentId = config.agentId;
    if (!isRealtimeConfigured() || !agentId) {
      send({
        type: 'status',
        state: 'error',
        message: 'Voice chat needs OPENAI_API_KEY set in the runtime environment.',
      });
      ws.close(1011, 'voice chat not configured');
      return;
    }
    send({ type: 'status', state: 'connecting' });

    // The runtime serves one agent and trusts the inbound network, the same as the
    // chat gateway: the connection is the owner's.
    const userId = config.ownerUserId;
    const session = new VoiceChatSession();
    this.live.add(session);
    let closed = false;

    const end = (reason: string): void => {
      if (closed) return;
      closed = true;
      logger.info(`[VoiceChat] Ended: ${reason}`);
      this.live.delete(session);
      void session.stop();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, reason);
      }
    };

    ws.on('close', () => end('page closed the socket'));
    ws.on('error', (err) => {
      logger.warn({ err }, '[VoiceChat] Socket error');
      end('socket error');
    });

    try {
      // The browser first: a voice chat always has one, and its absence is the one
      // failure worth reporting before anything else is built.
      await session.openBrowser();
      if (closed) return;
      // The page sees and hears the browser from the start, before the model is ready.
      session.startScreenStream((data) => send({ type: 'screen', data }));
      const browserAudio = session.startBrowserAudio((pcm) => sendAudio(BROWSER_AUDIO_FRAME, pcm));
      logger.info(
        browserAudio
          ? '[VoiceChat] Browser audio streams to the page'
          : '[VoiceChat] Browser audio plays on this host, not through the page',
      );

      const { instructions, agentName, lockedIn } = await this.buildInstructions(userId, agentId);
      const agentTools = await prepareMeetingTools({ userId, agentId, lockedIn });
      const tools = mergePreparedTools(
        agentTools,
        prepareRealtimeTools(createVoiceChatTools(session)),
      );
      if (closed) return;

      const conversation = new VoiceConversation({
        instructions,
        tools,
        // 48 kHz pcm16 straight to the page, paced by `AudioPlayback` exactly as it
        // would be into `pacat`, so an interruption drops what it always dropped.
        sink: { write: (chunk) => sendAudio(VOICE_FRAME, chunk) },
        responseMode: 'open',
        agentName,
        voice: config.openaiRealtimeVoice,
        onSessionLost: (reason) => {
          send({ type: 'status', state: 'ended', message: `Voice session lost: ${reason}` });
          end(`realtime session lost: ${reason}`);
        },
      });
      session.conversation = conversation;
      await conversation.start();
      if (closed) return;

      ws.on('message', (data, isBinary) => {
        // Text frames are reserved for control; the page sends none today.
        if (!isBinary) return;
        conversation.pushMeetingAudio(
          Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
        );
      });

      conversation.notify(
        'Your user just opened the voice chat in the web UI and can hear you. ' +
          'Greet them in one short sentence.',
      );
      conversation.speakNow();
      send({ type: 'status', state: 'ready' });
      logger.info(`[VoiceChat] Ready with ${tools.count} tool(s) and a browser`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, '[VoiceChat] Failed to start');
      send({ type: 'status', state: 'error', message });
      end('start failed');
    }
  }

  /**
   * The agent's own system prompt plus how to behave on voice — the meeting bot's
   * recipe with the voice-chat prompt in place of the meeting one.
   */
  private async buildInstructions(
    userId: string,
    agentId: string,
  ): Promise<{ instructions: string; agentName: string; lockedIn: boolean }> {
    const context = await contextService.getAgentContext(userId, {
      agentId,
      includeConversation: false,
    });
    const parts = await buildSystemPromptParts(context, 'meeting');
    const instructions = [
      parts.map((p) => p.text).join('\n\n---\n\n'),
      getVoiceChatInstructions({ agentName: context.agentName }),
    ].join('\n\n---\n\n');
    return { instructions, agentName: context.agentName, lockedIn: context.lockedIn };
  }

  /** Stop every live session; called from the process shutdown path. */
  closeAll(): void {
    for (const session of this.live) void session.stop();
    this.live.clear();
    this.wss?.close();
  }
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}

export const voiceChatService = new VoiceChatService();
