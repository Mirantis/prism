import { tool, type Tool } from 'ai';
import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { createComputerTools } from '../services/computer/computer-tools';
import { computerService } from '../services/computer/computer.service';
import {
  computerHelpService,
  computerLink,
  HELP_ANSWER_WAIT_MS,
  waitsForAnswer,
  type HelpAnswer,
} from '../services/computer/computer-help.service';
import type { ComputerUse } from '../services/computer/computer-access';
import type { AgentComputer, ModelChannel } from '../services/computer/agent-computer';
import { DEFAULT_SCREEN, pictureFor } from '../services/computer/screen-size';
import { renderToolResult } from '../lib/tool-output-limiter';

const pictures = new WeakMap<object, string[]>();

const WAIT_MINUTES = HELP_ANSWER_WAIT_MS / 60_000;

/** What a run that waited for its help request is told, by answer. */
const HELP_ANSWERS: Record<HelpAnswer, string> = {
  continued:
    'The user finished helping. Inspect the screen, then continue the work. If something else blocks it, ask for that help now.',
  dismissed:
    'The user dismissed the help request. Finish without the blocked work, and say in your reply what it left undone.',
  unanswered: `The user did not answer within ${WAIT_MINUTES} minutes, and the request stays open. Finish without the blocked work, and say in your reply what is still blocked.`,
};

/** Schemas stay fixed for a mode; the calling invocation supplies its ownership and image sink. */
export function getComputerTools(
  use?: ComputerUse,
  voiceChannel?: () => ModelChannel | null,
): Record<string, Tool> {
  const desktop = new Proxy(
    pictureFor(DEFAULT_SCREEN),
    {
      get(target, property) {
        if (property === 'width' || property === 'height') return target[property];
        return async (...args: unknown[]) => {
          if (!use) throw new Error('Computer tools require an active invocation.');
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
            async (computer) => {
              const fn = computer[property as keyof AgentComputer] as (
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
  ) as unknown as AgentComputer;
  const base = createComputerTools(desktop, desktop, voiceChannel ? desktop : null);
  const result: Record<string, Tool> = {};
  for (const [name, original] of Object.entries(base)) {
    result[name] = {
      ...original,
      execute: async (input, options) => {
        if (
          use?.mode === 'voice' &&
          computerService.access.owner &&
          computerService.access.owner !== use
        ) {
          return {
            success: false,
            message:
              'Another invocation is using the computer. Use computer_screen to discuss it, or computer_instruct to relay the user’s instructions.',
          };
        }
        return original.execute!(input, options);
      },
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
              mediaType: 'image/jpeg',
            })),
          ],
        };
      },
    } as Tool;
  }
  const screenOutput = result.computer_screen.toModelOutput;
  result.computer_screen = tool({
    description:
      'Inspect your current desktop and browser. During human takeover, set userRequested only when the user explicitly asks you to inspect the screen. Automatic inspection waits for hand-back. While the user completes a help request, every inspection waits for hand-back.',
    inputSchema: z.object({ userRequested: z.boolean().default(false) }),
    execute: async ({ userRequested }) => {
      if (!use) throw new Error('Screen inspection requires an active invocation.');
      const images: string[] = [];
      const output = await computerService.act(
        use,
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
        !computerService.access.secure &&
          (userRequested || (use.mode === 'voice' && !computerService.access.paused)),
      );
      if (images.length) pictures.set(output, images);
      return output;
    },
    toModelOutput: screenOutput,
  });
  result.computer_help = tool({
    description:
      'When computer work is blocked by a step only the user can complete, ask them for help, such as signing in, solving a CAPTCHA, or approving a device. Set credentials for any sign-in screen — one asking for a username and a password, for the username alone, or for the password alone — and the user is asked for their username and password where they are, and the runtime types both in, screen by screen. Never ask for either in chat and never offer to try one. A CAPTCHA, a device approval, or a second factor leaves credentials false. Preserves this help request and releases the computer for independent work. Explain what the user needs to do. ' +
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
      const { help, repeated, answer } = await computerService.access.run(use, () =>
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
        url: computerLink(help.id),
        credentials: help.credentials ?? false,
        message: repeated
          ? `A help request is already waiting for the user, so nothing new was sent. It asks: ${JSON.stringify(help.reason)}. If something else blocks this run, say what in your reply. Continue independent work or finish this turn while waiting for the user.`
          : desktop
            ? 'No sign-in form was found, so the user is asked to take over the desktop instead. Continue independent work or finish this turn while waiting for the user.'
            : 'Help requested. Continue independent work or finish this turn while waiting for the user.',
      };
    },
  });
  result.computer_continue = tool({
    description:
      'Resolve a computer help request after the user explicitly says they finished helping, or dismiss it at their request. Then inspect the screen before continuing. Use the help ID from computer_help.',
    inputSchema: z.object({ helpId: z.string(), dismiss: z.boolean().default(false) }),
    execute: async ({ helpId, dismiss }) => {
      if (!use) throw new Error('Computer help requires an active invocation.');
      const resolved = await computerHelpService.resolve(
        use.agentId,
        use.userId,
        helpId,
        dismiss ? 'dismissed' : 'continued',
      );
      if (!resolved) return { success: false, message: 'This help request is already closed.' };
      if (!dismiss && computerService.access.paused) await computerService.continueFromChat();
      if (resolved.answeredRuns)
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
        const owner = computerService.access.owner;
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
