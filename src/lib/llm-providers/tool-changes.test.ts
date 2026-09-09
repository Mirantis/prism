import { describe, it, expect } from 'vitest';
import { generateText, jsonSchema, type ModelMessage } from 'ai';
import { createBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { supportsToolChanges } from './tool-changes';

describe('tool changes through the SDK', () => {
  it.each([
    ['us.anthropic.claude-opus-4-8', true],
    ['global.anthropic.claude-fable-5-1', true],
    ['us.anthropic.claude-opus-5', false],
  ])('converts the request for %s', async (modelId, supported) => {
    let body: Record<string, any> = {};
    const provider = createBedrockAnthropic({
      region: 'us-east-1',
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        body = JSON.parse(init!.body as string);
        return Response.json({
          id: 'response-1', type: 'message', role: 'assistant', model: modelId,
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        });
      },
    });
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Use the old tool.' },
      { role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'removed', input: {} },
      ] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'call-1', toolName: 'removed', output: { type: 'text', value: 'done' } },
      ] },
      { role: 'user', content: 'Continue.' },
    ];
    if (supportsToolChanges(modelId)) {
      messages.push({
        role: 'system', content: '',
        providerOptions: { anthropic: {
          toolChanges: [
            { type: 'tool_addition', toolName: 'added' },
            { type: 'tool_removal', toolName: 'removed' },
          ],
          cacheControl: { type: 'ephemeral' },
        } },
      });
    }
    const result = await generateText({
      model: provider(modelId),
      system: 'Test assistant.',
      messages,
      ...(supported ? { allowSystemInMessages: true } : {}),
      tools: {
        added: { inputSchema: jsonSchema({ type: 'object', properties: {} }) },
        ...(supported ? {
          removed: { description: 'No longer available.', inputSchema: jsonSchema({ type: 'object', properties: {} }) },
        } : {}),
      },
      maxOutputTokens: 8,
      maxRetries: 0,
    });
    expect(result.text).toBe('done');
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(supported ? ['added', 'removed'] : ['added']);
    expect(body.messages[1].content).toContainEqual({
      type: 'tool_use', id: 'call-1', name: 'removed', input: {},
    });
    if (!supported) {
      expect(body.anthropic_beta ?? []).not.toContain('mid-conversation-tool-changes-2026-07-01');
      expect(body.anthropic_beta ?? []).not.toContain('mid-conversation-system-2026-04-07');
      expect(body.messages.at(-1).role).toBe('user');
      return;
    }
    expect(body.anthropic_beta).toEqual(expect.arrayContaining([
      'mid-conversation-system-2026-04-07',
      'mid-conversation-tool-changes-2026-07-01',
    ]));
    expect(body.messages.at(-1)).toEqual({
      role: 'system',
      content: [
        { type: 'tool_addition', tool: { type: 'tool_reference', name: 'added' } },
        { type: 'tool_removal', tool: { type: 'tool_reference', name: 'removed' } },
      ],
    });
  });
});
