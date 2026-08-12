import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGenerateText, mockGetGateRequest, mockUpdateThreadTitle } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGetGateRequest: vi.fn(() => ({ model: 'haiku-model', providerOptions: {} })),
  mockUpdateThreadTitle: vi.fn(),
}));

vi.mock('ai', () => ({ generateText: mockGenerateText }));
vi.mock('../lib/classification', () => ({ getGateRequest: mockGetGateRequest }));
vi.mock('../lib/langfuse', () => ({ isLangfuseEnabled: () => false }));
vi.mock('./conversation.service', () => ({
  conversationService: { updateThreadTitle: mockUpdateThreadTitle },
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { threadTitleService, type ThreadTitleChange } from './thread-title.service';

const flush = () => new Promise((r) => setImmediate(r));

describe('threadTitleService.generateAndSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGateRequest.mockReturnValue({ model: 'haiku-model', providerOptions: {} });
    mockUpdateThreadTitle.mockResolvedValue(undefined);
  });

  it('generates a short title (clamped to 3 words) and saves it', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Database Schema Migration Plan' });

    const title = await threadTitleService.generateAndSave('a1', 'u1', 't1', 'migrate the authentication layer');

    expect(title).toBe('Database Schema Migration');
    expect(mockUpdateThreadTitle).toHaveBeenCalledWith('a1', 'u1', 't1', 'Database Schema Migration');
    // Direct inference on the cheap model — no tools, no invoke.
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.model).toBe('haiku-model');
    expect(call.tools).toBeUndefined();
  });

  it('strips wrapping quotes and trailing punctuation', async () => {
    mockGenerateText.mockResolvedValue({ text: '"Staging Deploy."' });

    const title = await threadTitleService.generateAndSave('a1', 'u1', 't1', 'deploy staging');

    expect(title).toBe('Staging Deploy');
  });

  it('returns null without calling the model for an empty message', async () => {
    const title = await threadTitleService.generateAndSave('a1', 'u1', 't1', '   ');

    expect(title).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockUpdateThreadTitle).not.toHaveBeenCalled();
  });

  it('returns null and does not save when the model errors (fail-open)', async () => {
    mockGenerateText.mockRejectedValue(new Error('bedrock down'));

    const title = await threadTitleService.generateAndSave('a1', 'u1', 't1', 'hello there');

    expect(title).toBeNull();
    expect(mockUpdateThreadTitle).not.toHaveBeenCalled();
  });

  it('returns null when the model yields only punctuation/whitespace', async () => {
    mockGenerateText.mockResolvedValue({ text: '  "."  ' });

    const title = await threadTitleService.generateAndSave('a1', 'u1', 't1', 'hello there');

    expect(title).toBeNull();
    expect(mockUpdateThreadTitle).not.toHaveBeenCalled();
  });
});

describe('threadTitleService.onFirstUserMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGateRequest.mockReturnValue({ model: 'haiku-model', providerOptions: {} });
    mockUpdateThreadTitle.mockResolvedValue(undefined);
    threadTitleService.events.removeAllListeners();
  });

  it('announces the placeholder immediately, then the upgraded title', async () => {
    mockGenerateText.mockResolvedValue({ text: 'Database Schema Migration Plan' });
    const changes: ThreadTitleChange[] = [];
    threadTitleService.events.on('change', (c: ThreadTitleChange) => changes.push(c));

    threadTitleService.onFirstUserMessage(
      'a1', 'u1', 't1', 'migrate the authentication layer', 'migrate the authentic...',
    );

    // Placeholder fires synchronously (it is already persisted by addMessage).
    expect(changes).toEqual([{ userId: 'u1', threadId: 't1', title: 'migrate the authentic...' }]);

    // Let the fire-and-forget upgrade resolve, then assert the second announce.
    await flush();
    await flush();
    expect(changes).toContainEqual({ userId: 'u1', threadId: 't1', title: 'Database Schema Migration' });
    expect(mockUpdateThreadTitle).toHaveBeenCalledWith('a1', 'u1', 't1', 'Database Schema Migration');
  });

  it('announces only the placeholder when the upgrade yields nothing (fail-open)', async () => {
    mockGenerateText.mockRejectedValue(new Error('bedrock down'));
    const changes: ThreadTitleChange[] = [];
    threadTitleService.events.on('change', (c: ThreadTitleChange) => changes.push(c));

    threadTitleService.onFirstUserMessage('a1', 'u1', 't1', 'hello there', 'hello there');
    await flush();
    await flush();

    expect(changes).toEqual([{ userId: 'u1', threadId: 't1', title: 'hello there' }]);
    expect(mockUpdateThreadTitle).not.toHaveBeenCalled();
  });
});
