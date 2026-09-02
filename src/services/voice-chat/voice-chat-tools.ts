/**
 * The browser and desktop tools of a voice chat, and how they reach the Realtime model.
 *
 * `browse` and `see_screen` are the meeting's tools (`tools/meeting.ts`) bound to this
 * session's browser instead of the meeting bot's: same names, same schemas, so the
 * prompt text written for a call reads the same here. The meeting's copies, which
 * answer "I am not in a meeting", are dropped from the agent's set in their favour.
 *
 * The `desktop_*` tools exist only where the runtime owns the display: they move the
 * mouse and press keys on it by pixel coordinates read off the picture `see_screen`
 * gives, and each answers with a fresh picture.
 */

import { asSchema, tool, type Tool } from 'ai';
import { z } from 'zod';
import { logger } from '../../logger';
import { MEETING_SCREEN_TOOL_NAMES } from '../../tools/meeting';
import type { BrowserCommand, BrowserReading, BrowserResult } from '../meeting/browser-control';
import type { RealtimeFunctionTool } from '../meeting/realtime-session';
import type { PreparedMeetingTools } from '../meeting/tool-bridge';
import type { MouseButton, ScrollDirection } from './desktop-control';

/** What a session offers the tools: its browser, and the model to show a picture to. */
export interface VoiceChatBrowser {
  browse(command: BrowserCommand): Promise<BrowserResult>;
  lookAtScreen(): Promise<{ success: boolean; message: string } & Partial<BrowserReading>>;
}

export interface DesktopActionResult {
  success: boolean;
  message: string;
}

/** The desktop a session owns, when it owns one. Every action shows the model the result. */
export interface VoiceChatDesktop {
  width: number;
  height: number;
  click(input: { x: number; y: number; button?: MouseButton; double?: boolean }): Promise<DesktopActionResult>;
  type(input: { text: string }): Promise<DesktopActionResult>;
  key(input: { keys: string }): Promise<DesktopActionResult>;
  scroll(input: { x: number; y: number; direction: ScrollDirection; clicks?: number }): Promise<DesktopActionResult>;
}

export function createVoiceChatTools(
  browser: VoiceChatBrowser,
  desktop: VoiceChatDesktop | null,
): Record<string, Tool> {
  const screenDescription = desktop
    ? `See your whole screen right now — a picture of the ${desktop.width} by ${desktop.height} ` +
      'desktop with every window on it, plus the text and controls of the browser tab in front. ' +
      'Use it to find what to click, to check what an action did, or to answer a question ' +
      'about what is on screen. Takes a couple of seconds.'
    : 'See what your browser is showing right now — a picture of the tab in front, plus ' +
      'the text and controls of the page. Use it to check a page `browse` reported oddly, ' +
      'or to answer a question about what is on screen. Takes a couple of seconds.';

  return {
    ...(desktop ? createDesktopTools(desktop) : {}),
    browse: tool({
      description:
        'Use your web browser: open a page, click things, type, scroll, and work in ' +
        'several tabs. Every command answers with where the page is, what it says, the ' +
        'names of the links, buttons and fields on it, and the list of open tabs. Click ' +
        'and type by those names, and switch tabs by those numbers. One command per call.',
      inputSchema: z.object({
        action: z
          .enum([
            'navigate',
            'click',
            'type',
            'press',
            'scroll',
            'read',
            'new_tab',
            'switch_tab',
            'close_tab',
          ])
          .describe(
            '"navigate" opens a URL in the tab you are in, "click" presses something, ' +
              '"type" enters text, "press" sends one key (Enter, Escape, PageDown), ' +
              '"scroll" moves the page, "read" just reports where you are. "new_tab" opens ' +
              'another tab (pass a url to land on a page), "switch_tab" moves to a tab by ' +
              'number, "close_tab" closes one.',
          ),
        url: z
          .string()
          .optional()
          .describe('For "navigate", and for a "new_tab" that should open a page.'),
        tab: z
          .number()
          .optional()
          .describe(
            'For "switch_tab" and "close_tab": the tab number from the last answer. ' +
              '"close_tab" without one closes the tab you are in.',
          ),
        target: z
          .string()
          .optional()
          .describe(
            'For "click", and optionally for "type": the words on the link, button or ' +
              'field, as they came back in the last reading. A CSS selector also works.',
          ),
        text: z.string().optional().describe('For "type": what to enter.'),
        key: z.string().optional().describe('For "press": the key name, e.g. Enter.'),
        amount: z
          .number()
          .optional()
          .describe('For "scroll": pixels to scroll, negative to go up. Defaults to 600.'),
      }),
      execute: async (command) => browser.browse(command),
    }),

    see_screen: tool({
      description: screenDescription,
      inputSchema: z.object({}),
      execute: async () => browser.lookAtScreen(),
    }),
  };
}

function createDesktopTools(desktop: VoiceChatDesktop): Record<string, Tool> {
  const where =
    `Pixel coordinates on the ${desktop.width} by ${desktop.height} screen, as seen in the ` +
    'picture from `see_screen`: x from the left edge, y from the top.';

  return {
    desktop_click: tool({
      description:
        'Click somewhere on your desktop: a menu, a button, a window, a text field to focus. ' +
        `${where} Answers with a fresh picture of the screen after the click.`,
      inputSchema: z.object({
        x: z.number().describe('Pixels from the left edge.'),
        y: z.number().describe('Pixels from the top edge.'),
        button: z.enum(['left', 'middle', 'right']).optional().describe('Defaults to left.'),
        double: z.boolean().optional().describe('True for a double-click.'),
      }),
      execute: async (input) => desktop.click(input),
    }),

    desktop_type: tool({
      description:
        'Type text on your desktop, into whatever has the keyboard focus — click a field or a ' +
        'terminal first. Answers with a fresh picture of the screen.',
      inputSchema: z.object({ text: z.string().min(1).describe('The text to type, as is.') }),
      execute: async (input) => desktop.type(input),
    }),

    desktop_key: tool({
      description:
        'Press one key or a chord on your desktop, such as "Return", "Escape", "Tab", ' +
        '"ctrl+l", "alt+F4" or "super". Answers with a fresh picture of the screen.',
      inputSchema: z.object({
        keys: z.string().describe('A key name, or names joined with "+", in X11 keysym spelling.'),
      }),
      execute: async (input) => desktop.key(input),
    }),

    desktop_scroll: tool({
      description:
        `Scroll the mouse wheel over a point on your desktop. ${where} Answers with a fresh ` +
        'picture of the screen.',
      inputSchema: z.object({
        x: z.number().describe('Pixels from the left edge.'),
        y: z.number().describe('Pixels from the top edge.'),
        direction: z.enum(['up', 'down']),
        clicks: z.number().int().min(1).max(20).optional().describe('Wheel clicks; defaults to 3.'),
      }),
      execute: async (input) => desktop.scroll(input),
    }),
  };
}

/**
 * Adapt AI SDK tools for the Realtime API, the way `prepareMeetingTools` does for the
 * agent's own set. Results are rendered as JSON; a rejected tool comes back as text.
 */
export function prepareRealtimeTools(tools: Record<string, Tool>): PreparedMeetingTools {
  const declarations: RealtimeFunctionTool[] = Object.entries(tools).map(([name, t]) => ({
    name,
    description: (typeof t.description === 'function'
      ? t.description({ context: undefined })
      : t.description) ?? name,
    parameters: asSchema(t.inputSchema).jsonSchema as Record<string, unknown>,
  }));

  const execute = async (name: string, argumentsJson: string): Promise<string> => {
    const t = tools[name];
    if (!t || typeof t.execute !== 'function') {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    let args: unknown;
    try {
      args = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
    } catch {
      return JSON.stringify({ error: `Invalid JSON arguments for ${name}` });
    }
    try {
      logger.info(`[VoiceChat] Executing tool ${name}`);
      const result = await t.execute(args, {
        toolCallId: `voice-${Date.now()}`,
        messages: [],
        abortSignal: new AbortController().signal,
        context: undefined,
      });
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[VoiceChat] Tool ${name} failed: ${message}`);
      return JSON.stringify({ error: message });
    }
  };

  return { declarations, execute, count: declarations.length };
}

/**
 * The agent's set with this session's browser tools in place of the meeting's screen
 * tools. A name in `extra` wins; the meeting's screen tools go even when `extra` has
 * no replacement, since sharing a screen into a call has no meaning here.
 */
export function mergePreparedTools(
  base: PreparedMeetingTools,
  extra: PreparedMeetingTools,
): PreparedMeetingTools {
  const replaced = new Set<string>([
    ...MEETING_SCREEN_TOOL_NAMES,
    ...extra.declarations.map((d) => d.name),
  ]);
  const declarations = [
    ...base.declarations.filter((d) => !replaced.has(d.name)),
    ...extra.declarations,
  ];
  const extraNames = new Set(extra.declarations.map((d) => d.name));
  return {
    declarations,
    count: declarations.length,
    execute: (name, argumentsJson) =>
      extraNames.has(name) ? extra.execute(name, argumentsJson) : base.execute(name, argumentsJson),
  };
}
