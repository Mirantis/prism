/** Browser, desktop, and shared-screen tools for the agent’s computer. */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { BrowserCommand, BrowserReading, BrowserResult } from '../meeting/browser-control';
import type { MouseButton, ScrollDirection } from './desktop-control';

/** What a session offers the tools: its browser, and the model to show a picture to. */
export interface ComputerBrowser {
  browse(command: BrowserCommand): Promise<BrowserResult>;
  lookAtScreen(): Promise<{ success: boolean; message: string } & Partial<BrowserReading>>;
}

export interface DesktopActionResult {
  success: boolean;
  message: string;
}

/** Where a control or some words were found on the screen, in picture coordinates. */
export interface TextLocation {
  text: string;
  /** For a control, its role and program; for words, the line they sit in. */
  line: string;
  x: number;
  y: number;
}

export type WindowAction = 'focus' | 'close' | 'maximize' | 'restore' | 'minimize';

/** What the user is sharing from their own screen, when they are. */
export interface ComputerUserScreen {
  /** The picture into the session, plus the words on it as `text` where the host can read them. */
  lookAtUserScreen(): Promise<DesktopActionResult & { text?: string }>;
}

/**
 * The desktop a session owns, when it owns one. Every action shows the model the result.
 * `width` and `height` are the model's picture, which its coordinates refer to.
 */
export interface ComputerDesktop {
  width: number;
  height: number;
  listElements(input: { filter?: string }): Promise<DesktopActionResult>;
  listWindows(): Promise<DesktopActionResult>;
  windowAction(input: { title: string; action: WindowAction }): Promise<DesktopActionResult>;
  findText(input: { text: string }): Promise<DesktopActionResult & { matches?: TextLocation[] }>;
  clickText(input: { text: string; occurrence?: number; button?: MouseButton; double?: boolean }): Promise<DesktopActionResult>;
  move(input: { x: number; y: number }): Promise<DesktopActionResult>;
  click(input: { x?: number; y?: number; button?: MouseButton; double?: boolean }): Promise<DesktopActionResult>;
  drag(input: { fromX: number; fromY: number; toX: number; toY: number; button?: MouseButton }): Promise<DesktopActionResult>;
  type(input: { text: string }): Promise<DesktopActionResult>;
  key(input: { keys: string }): Promise<DesktopActionResult>;
  scroll(input: { x: number; y: number; direction: ScrollDirection; clicks?: number }): Promise<DesktopActionResult>;
}

export function createComputerTools(
  browser: ComputerBrowser,
  desktop: ComputerDesktop | null,
  userScreen: ComputerUserScreen | null,
): Record<string, Tool> {
  const screenDescription = desktop
    ? `See your whole screen right now — a ${desktop.width} by ${desktop.height} picture of the ` +
      'desktop with every window on it, plus the text and controls of the browser tab in front. ' +
      'Use it to find what to click, to check what an action did, or to answer a question about ' +
      'what is on screen. Takes a couple of seconds.'
    : 'See what your browser is showing right now — a picture of the tab in front, plus ' +
      'the text and controls of the page. Use it to check a page `computer_browse` reported oddly, ' +
      'or to answer a question about what is on screen. Takes a couple of seconds.';

  return {
    ...(userScreen
      ? {
          computer_user_screen: tool({
            description:
              "Look at what your user is sharing from their own screen — a window, a tab or their " +
              'whole screen, as it looks right now. You get the picture and, read off it, the exact ' +
              'words on it, so trust the text for an error message, a name or a number and the picture ' +
              'for where things are. Use it when they point at something on their side: "look at ' +
              'this", "this error", "my dashboard". Says so if they are not sharing.',
            inputSchema: z.object({}),
            execute: async () => userScreen.lookAtUserScreen(),
          }),
        }
      : {}),

    ...(desktop ? createDesktopTools(desktop) : {}),
    computer_browse: tool({
      description:
        'Use your web browser: open a page, click things, type, scroll, and work in ' +
        'several tabs. Every command answers with where the page is, what it says, the ' +
        'names of the links, buttons and fields on it, and the list of open tabs. Click ' +
        'and type by those names, and switch tabs by those numbers. Use it for labeled page ' +
        'controls in a web page. To only read a page, use web_fetch, which is faster. One ' +
        'command per call.',
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

    computer_screen: tool({
      description: screenDescription,
      inputSchema: z.object({}),
      execute: async () => browser.lookAtScreen(),
    }),
  };
}

function createDesktopTools(desktop: ComputerDesktop): Record<string, Tool> {
  const where =
    `Pixel coordinates in the ${desktop.width} by ${desktop.height} picture from \`computer_screen\`: ` +
    'x from the left edge, y from the top. Aim at the middle of the button or row.';

  return {
    computer_elements: tool({
      description:
        'Read the desktop the way `computer_browse` reads a page: every visible control by name and ' +
        'position — menu items, buttons, tabs, fields, windows — grouped by program. Use the ' +
        'names with `computer_click_text`. Pass `filter` to list only names containing some ' +
        'words. A program that does not describe itself shows nothing here; use `computer_screen` ' +
        'for those.',
      inputSchema: z.object({
        filter: z.string().optional().describe('Only controls whose name contains this.'),
      }),
      execute: async (input) => desktop.listElements(input),
    }),

    computer_windows: tool({
      description: 'List the open windows on your desktop by title, with their position and size.',
      inputSchema: z.object({}),
      execute: async () => desktop.listWindows(),
    }),

    computer_window: tool({
      description:
        'Manage a window by its title: bring it to the front, close it, maximise it, restore ' +
        'it, or minimise it. Use this instead of aiming at the small buttons in a title bar. ' +
        'Answers with a fresh picture.',
      inputSchema: z.object({
        title: z.string().min(1).describe('The window title, or a distinctive part of it.'),
        action: z.enum(['focus', 'close', 'maximize', 'restore', 'minimize']),
      }),
      execute: async (input) => desktop.windowAction(input),
    }),

    computer_click_text: tool({
      description:
        'Click a control or some words by name — a menu row, a button, a tab, a link, a file ' +
        'name. Give the name as it appears; the desktop\'s own controls are looked up first and ' +
        'clicked at their exact centre, and words with no control behind them are read off the ' +
        'screen. Prefer this over `computer_click` with coordinates whenever the target has a ' +
        'name, since it does not miss. If the name appears more than once, `occurrence` picks ' +
        'which, counted from the top. Answers with a fresh picture after the click, or says the ' +
        'name is not on screen.',
      inputSchema: z.object({
        text: z.string().min(1).describe('The words on the target, as they appear on screen.'),
        occurrence: z.number().int().min(1).optional().describe('Which match to click when there are several, 1 being the topmost. Defaults to 1.'),
        button: z.enum(['left', 'middle', 'right']).optional().describe('Defaults to left.'),
        double: z.boolean().optional().describe('True for a double-click.'),
      }),
      execute: async (input) => desktop.clickText(input),
    }),

    computer_find_text: tool({
      description:
        'Find a control or some words on your desktop by name and get their exact coordinates, ' +
        'without clicking. Use it to check whether something is on screen, to tell apart several ' +
        'places the same name appears, or to get a precise point for `computer_move`, ' +
        '`computer_drag` or `computer_scroll`.',
      inputSchema: z.object({
        text: z.string().min(1).describe('The words to look for, as they appear on screen.'),
      }),
      execute: async (input) => desktop.findText(input),
    }),

    computer_move: tool({
      description:
        'Put the pointer somewhere on your desktop without clicking, and see it there. Use it ' +
        'before clicking a small target such as a menu row: the picture that comes back shows ' +
        'the pointer, so you can check it sits on the target and then call `computer_click` ' +
        `with no coordinates to click right there. ${where}`,
      inputSchema: z.object({
        x: z.number().describe('Pixels from the left edge.'),
        y: z.number().describe('Pixels from the top edge.'),
      }),
      execute: async (input) => desktop.move(input),
    }),

    computer_click: tool({
      description:
        'Click on your desktop: a menu, a button, a window, a text field to focus. With ' +
        'coordinates it clicks there; without, it clicks where the pointer already is, which ' +
        `is how to commit a spot you checked with \`computer_move\`. ${where} Answers with a ` +
        'fresh picture of the screen after the click; the pointer in it shows where the click landed.',
      inputSchema: z.object({
        x: z.number().optional().describe('Pixels from the left edge. Omit to click where the pointer is.'),
        y: z.number().optional().describe('Pixels from the top edge. Omit to click where the pointer is.'),
        button: z.enum(['left', 'middle', 'right']).optional().describe('Defaults to left.'),
        double: z.boolean().optional().describe('True for a double-click.'),
      }),
      execute: async (input) => desktop.click(input),
    }),

    computer_drag: tool({
      description:
        'Drag on your desktop: press at one point, move to another, release. This is how to ' +
        'move a window or a slider, or to select text. It walks the path in steps so ' +
        `the program sees the motion. ${where} Answers with a fresh picture after the release.`,
      inputSchema: z.object({
        fromX: z.number().describe('Where to press: pixels from the left edge.'),
        fromY: z.number().describe('Where to press: pixels from the top edge.'),
        toX: z.number().describe('Where to release: pixels from the left edge.'),
        toY: z.number().describe('Where to release: pixels from the top edge.'),
        button: z.enum(['left', 'middle', 'right']).optional().describe('Defaults to left.'),
      }),
      execute: async (input) => desktop.drag(input),
    }),

    computer_type: tool({
      description:
        'Type text on your desktop, into whatever has the keyboard focus — click a field or a ' +
        'terminal first. Answers with a fresh picture of the screen.',
      inputSchema: z.object({ text: z.string().min(1).describe('The text to type, as is.') }),
      execute: async (input) => desktop.type(input),
    }),

    computer_key: tool({
      description:
        'Press one key or a chord on your desktop, such as "Return", "Escape", "Tab", ' +
        '"ctrl+l", "alt+F4" or "super". Answers with a fresh picture of the screen.',
      inputSchema: z.object({
        keys: z.string().describe('A key name, or names joined with "+", in X11 keysym spelling.'),
      }),
      execute: async (input) => desktop.key(input),
    }),

    computer_scroll: tool({
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
