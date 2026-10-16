import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenario = process.argv[2];
if (process.env.FIXTURE_PID_FILE) appendFileSync(process.env.FIXTURE_PID_FILE, `${process.pid}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const event = (method, params) => send({ method, params });
const finish = (text) => {
  event('item/agentMessage/delta', { itemId: 'answer', delta: text });
  event('thread/tokenUsage/updated', {
    tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 1 } },
  });
  event('turn/completed', { turn: { id: 'turn', status: 'completed', error: null } });
};

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (scenario === 'exit') process.exit(7);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'account/read') {
    if (message.params.refreshToken !== false) process.exit(6);
    send({ id: message.id, result: { account: { type: scenario === 'api' ? 'apiKey' : 'chatgpt' } } });
  }
  if (message.method === 'thread/start') {
    if (message.params.modelProvider !== 'openai' || message.params.approvalPolicy !== 'never') process.exit(2);
    send({ id: message.id, result: { thread: { id: 'thread' } } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    if (scenario === 'hang') continue;
    if (scenario === 'failed') {
      event('turn/completed', { turn: { status: 'failed', error: { message: 'Subscription limit reached' } } });
    } else if (scenario === 'tool' || scenario === 'tool-added') {
      send({ id: 100, method: 'item/tool/call', params: {
        threadId: 'thread', turnId: 'turn', callId: 'call-1', namespace: 'prism', tool: 'echo', arguments: { value: 'test' },
      } });
    } else {
      event('item/agentMessage/delta', { itemId: 'answer', delta: 'Hello ' });
      finish('from Codex');
    }
  }
  if (message.id === 100 && message.result) {
    if (!message.result.success || !message.result.contentItems[0].text.includes('result:test')) process.exit(3);
    const texts = message.result.contentItems.map((item) => item.text ?? '');
    if (scenario === 'tool-added' && !(texts.some((text) => text.includes('MARKER')) && texts.some((text) => text.includes('report.pdf')))) process.exit(4);
    // Recorded from Codex 0.162.1: a call's usage arrives after its tool reply.
    event('thread/tokenUsage/updated', {
      tokenUsage: { last: { inputTokens: 30, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 } },
    });
    finish('Tool result received');
  }
}
