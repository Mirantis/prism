import { AsyncLocalStorage } from 'node:async_hooks';
import { tool, type Tool } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { COMPUTER_FIELD, createComputerTools } from '../services/computer/computer-tools';
import { computerService } from '../services/computer/computer.service';
import { ComputerSession, HELD_LOCALLY } from '../services/computer/computer-session';
import type { Computer } from '../services/computer/computer';
import { remoteComputerService } from '../services/computer/remote/remote-computer.service';
import { hasComputer, usesRemoteComputers } from '../services/computer/supported';
import {
  computerHelpService,
  computerLink,
  HELP_ANSWER_WAIT_MS,
  waitsForAnswer,
  type HelpAnswer,
} from '../services/computer/computer-help.service';
import type { ComputerUse } from '../services/computer/computer-access';
import type { ModelChannel } from '../services/computer/agent-computer';
import { DEFAULT_SCREEN, pictureFor } from '../services/computer/screen-size';
import { renderToolResult } from '../lib/tool-output-limiter';

const pictures = new WeakMap<object, string[]>();

const WAIT_MINUTES = HELP_ANSWER_WAIT_MS / 60_000;

/**
 * Added to a new help request's result, where the model decides whether to end its turn, so the
 * model calls a notification tool when it has one. Never another service: a message there may
 * reach other people.
 */
export const ALERT_THE_USER =
  'The user may not be watching this conversation. If you have a notification tool for alerting them, call it now; do not message them through another service.';

/** What a run that waited for its help request is told, by answer. */
const HELP_ANSWERS: Record<HelpAnswer, string> = {
  continued:
    'The user finished helping. Inspect the screen, then continue the work. If something else blocks it, ask for that help now.',
  dismissed:
    'The user dismissed the help request. Finish without the blocked work, and say in your reply what it left undone.',
  unanswered: `The user did not answer within ${WAIT_MINUTES} minutes, and the request stays open. Finish without the blocked work, and say in your reply what is still blocked.`,
};

/** A voice call that finds the computer in another invocation's hands. */
const ANOTHER_INVOCATION =
  'Another invocation is using the computer. Use computer_screen to discuss it, or computer_instruct to relay the user’s instructions.';

/**
 * The `computer` a tool call named, for the dispatch below. It travels beside the call
 * rather than in the computer method's arguments, which a tool need not pass on.
 */
const selection = new AsyncLocalStorage<string | undefined>();

function computerNamed(input: unknown): string | undefined {
  const name = (input as { computer?: unknown } | undefined)?.computer;
  return typeof name === 'string' ? name : undefined;
}

/**
 * The computer a call names, or a refusal the model reads. The user's shared screen
 * arrives on the runtime's own Computer page, so that tool always asks the runtime's own.
 */
function sessionFor(
  use: ComputerUse,
  name: string | undefined,
  property: string | symbol,
): ComputerSession | { success: false; message: string } {
  if (property === 'lookAtUserScreen') return computerService.local;
  try {
    return computerService.resolve(use, typeof name === 'string' ? name : undefined);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Schemas stay fixed for a mode and for the set of computers; the calling invocation
 * supplies its ownership and image sink. A run that may use a remote computer names it
 * in each call's `computer` once one exists. `mode` is the invocation's, and a request
 * that has none, such as a compaction, passes the mode whose tools block it repeats.
 */
export function getComputerTools(
  use?: ComputerUse,
  voiceChannel?: () => ModelChannel | null,
  mode = use?.mode,
): Record<string, Tool> {
  const named = mode !== undefined && usesRemoteComputers(mode) && remoteComputerService.count > 0;
  const desktop = new Proxy(
    pictureFor(DEFAULT_SCREEN),
    {
      get(target, property) {
        if (property === 'width' || property === 'height') return target[property];
        return async (...args: unknown[]) => {
          if (!use) throw new Error('Computer tools require an active invocation.');
          const session = sessionFor(use, selection.getStore(), property);
          if (!(session instanceof ComputerSession)) return session;
          if (use.mode === 'voice' && session.access.owner && session.access.owner !== use) {
            return { success: false, message: ANOTHER_INVOCATION };
          }
          const imageUrls: string[] = [];
          const channel: ModelChannel = {
            showImage(url, note) {
              if (voiceChannel) return voiceChannel()?.showImage(url, note) ?? false;
              imageUrls.push(url);
              return true;
            },
            notify(text) {
              voiceChannel?.()?.notify(text);
            },
          };
          const output = await computerService.act(
            use,
            session,
            async (computer) => {
              const fn = computer[property as keyof Computer] as (
                ...input: unknown[]
              ) => Promise<object>;
              return fn.apply(computer, args);
            },
            channel,
          );
          if (imageUrls.length && output && typeof output === 'object')
            pictures.set(output, imageUrls);
          return output;
        };
      },
    },
  ) as unknown as Computer;
  const base = createComputerTools(desktop, desktop, voiceChannel ? desktop : null, named);
  const result: Record<string, Tool> = {};
  for (const [name, original] of Object.entries(base)) {
    // The browser tool is the runtime's own browser. A run on a runtime that has only remote
    // computers uses a computer's browser through its desktop.
    if (name === 'computer_browse' && named && !hasComputer()) continue;
    result[name] = {
      ...original,
      execute: (input, options) => selection.run(computerNamed(input), () => original.execute!(input, options)),
      toModelOutput: async ({ output }: { output: unknown }): Promise<ToolResultOutput> => {
        const text = renderToolResult(output);
        const images = output && typeof output === 'object' ? pictures.get(output) : undefined;
        if (!images?.length) return { type: 'text', value: text };
        return {
          type: 'content',
          value: [
            { type: 'text', text },
            ...images.map((url) => ({
              type: 'image-data' as const,
              data: url.split(',')[1],
              // A data URL names its own type: `data:image/png;base64,…`.
              mediaType: url.slice('data:'.length, url.indexOf(';')),
            })),
          ],
        };
      },
    } as Tool;
  }
  const screenOutput = result.computer_screen.toModelOutput;
  result.computer_screen = tool({
    description:
      'Inspect your current desktop and browser. Inspect it again after navigation or user help. During human takeover, set userRequested only when the user explicitly asks you to inspect the screen. Automatic inspection waits for hand-back. While the user completes a help request, every inspection waits for hand-back.',
    inputSchema: z.object({
      userRequested: z.boolean().default(false),
      ...(named ? COMPUTER_FIELD : {}),
    }),
    execute: async (input) => {
      if (!use) throw new Error('Screen inspection requires an active invocation.');
      const session = sessionFor(use, computerNamed(input), 'lookAtScreen');
      if (!(session instanceof ComputerSession)) return session;
      const images: string[] = [];
      const output = await computerService.act(
        use,
        session,
        (computer) => computer.lookAtScreen(),
        {
          showImage(url, note) {
            if (voiceChannel) return voiceChannel()?.showImage(url, note) ?? false;
            images.push(url);
            return true;
          },
          notify() {},
        },
        // An inspection is the one look that outruns the desktop's queue, so a
        // secure takeover withdraws it: the user's own screen is theirs alone
        // until they hand back.
        !session.access.secure &&
          (input.userRequested || (use.mode === 'voice' && !session.access.paused)),
      );
      if (images.length) pictures.set(output, images);
      return output;
    },
    toModelOutput: screenOutput,
  });
  result.computer_help = tool({
    description:
      'When computer work is blocked by a step only the user can complete, ask them for help, such as signing in, solving a CAPTCHA, or approving a device. Call it immediately; do not wait for the user to ask you to request help, and pass tab for the tab that needs help. Set credentials for any sign-in screen — one asking for a username and a password, for the username alone, or for the password alone — and the user is asked for their username and password where they are, and the runtime types both in, screen by screen. Never ask for either in chat, never offer to try one, and never report the sign-in and stop for instructions: make the call. A CAPTCHA, a device approval, or a second factor leaves credentials false. Preserves this help request and releases the computer for independent work. Explain what the user needs to do. ' +
      (use && waitsForAnswer(use.mode)
        ? `This call waits up to ${WAIT_MINUTES} minutes for the user's answer, so do independent work first.`
        : 'Continue independent tasks; when only blocked work remains, end this turn and wait for the user.'),
    inputSchema: z.object({
      reason: z.string().min(1).max(2000),
      tab: z.number().int().positive().optional(),
      credentials: z.boolean().default(false),
    }),
    execute: async ({ reason, tab, credentials }) => {
      if (!use) throw new Error('Computer help requires an active invocation.');
      const { help, repeated, answer } = await computerService.current(use).access.run(use, () =>
        computerHelpService.request(use, reason, tab, credentials),
      );
      if (answer) {
        const answered = use.idle ? await use.idle(() => answer) : await answer;
        return {
          success: true,
          helpId: help.id,
          answer: answered,
          message: `${repeated ? `A help request was already waiting for the user, so nothing new was sent. It asks: ${JSON.stringify(help.reason)}. ` : ''}${HELP_ANSWERS[answered]}`,
        };
      }
      // Asked for credentials and offered the desktop: the tab held no sign-in form.
      const desktop = !repeated && credentials && !help.credentials;
      return {
        success: true,
        helpId: help.id,
        url: computerLink(help.id, help.computerId),
        credentials: help.credentials ?? false,
        message: repeated
          ? `A help request is already waiting for the user, so nothing new was sent. It asks: ${JSON.stringify(help.reason)}. If something else blocks this run, say what in your reply. Continue independent work or finish this turn while waiting for the user.`
          : desktop
            ? `No sign-in form was found, so the user is asked to take over the desktop instead. ${ALERT_THE_USER} Continue independent work or finish this turn while waiting for the user.`
            : `Help requested. ${ALERT_THE_USER} Continue independent work or finish this turn while waiting for the user.`,
      };
    },
  });
  result.computer_continue = tool({
    description:
      'Resolve a computer help request after the user explicitly says they finished helping, or dismiss it at their request. Then inspect the screen before continuing. The commands you started are paused while the user takes over the computer to help, so also check whatever you left running. Use the help ID from computer_help.',
    inputSchema: z.object({ helpId: z.string(), dismiss: z.boolean().default(false) }),
    execute: async ({ helpId, dismiss }) => {
      if (!use) throw new Error('Computer help requires an active invocation.');
      // Refused before the request is resolved, so a request is never closed on a computer
      // that is still in the hands of the person at it.
      const asked = (await computerHelpService.list(use.agentId, use.userId)).find((help) => help.id === helpId);
      if (!dismiss && computerHelpService.sessionOf(asked).controller === 'local') {
        return { success: false, message: HELD_LOCALLY };
      }
      const resolved = await computerHelpService.resolve(
        use.agentId,
        use.userId,
        helpId,
        dismiss ? 'dismissed' : 'continued',
      );
      if (!resolved) return { success: false, message: 'This help request is already closed.' };
      const session = computerHelpService.sessionOf(resolved.help);
      if (!dismiss && session.access.paused) await session.continueFromChat();
      if (resolved.answeredRuns && resolved.help.requesterWaits)
        return {
          success: true,
          message:
            'The run that asked for this help has the answer and continues by itself. Leave its work to it.',
        };
      const goalResumed =
        !dismiss
          ? await computerHelpService.resumeGoal(use.agentId, use.userId, resolved.help)
          : false;
      return {
        success: true,
        message: goalResumed
          ? 'The goal has resumed and will continue the original work.'
          : 'Help resolved. Inspect the screen before continuing.',
      };
    },
  });
  if (voiceChannel)
    result.computer_instruct = tool({
      description:
        'Relay your user’s spoken instructions to the chat invocation currently using the computer. Use this instead of competing with it for input. The instructions appear in that conversation.',
      inputSchema: z.object({ instruction: z.string().min(1).max(4000) }),
      execute: async ({ instruction }) => {
        // A voice call is held on the runtime's own computer, so that is the one it relays to.
        const owner = computerService.local.access.owner;
        if (!owner?.threadId || owner.mode !== 'chat')
          return {
            success: false,
            message:
              'No active chat invocation is using the computer. Use the computer tools when it is available.',
          };
        const { messageDeliveryService } = await import('../services/message-delivery.service');
        const { conversationEngineService } =
          await import('../services/conversation-engine.service');
        const context = await messageDeliveryService.threadContext(
          owner.threadId,
          owner.originChannel,
          owner.originChannelId,
        );
        const response = await conversationEngineService.chat({
          agentId: owner.agentId,
          userId: owner.userId,
          threadId: owner.threadId,
          message: instruction,
          steerOnly: true,
          metadata: {
            channel: context.channel,
            channelId: context.channelId,
            channelThreadId: context.channelThreadId,
            channelLabel: context.channelLabel,
          },
        });
        return {
          success: response.steered === true,
          message: response.steered
            ? 'Instructions sent to the active conversation.'
            : 'That invocation has finished. You can use the computer now.',
        };
      },
    });
  return result;
}
