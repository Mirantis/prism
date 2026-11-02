import { describe, it, expect } from 'vitest';
import type { DeferredToolDefinition } from '../llm-providers/llm-provider';
import { MAX_NAMED_LOADS, QUERY_LOAD_COUNT, ToolIndex } from './tool-index';

const define = (name: string, description: string): DeferredToolDefinition => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
});

const index = new ToolIndex([
  define('nexus__github__create_issue', 'Create a new issue in a GitHub repository.'),
  define('nexus__github__list_pull_requests', 'List pull requests in a repository.'),
  define('nexus__gmail__send_email', 'Send an email message.'),
  define('nexus__gmail__search_threads', 'Search mail threads by query.'),
  define('notes__notion__create_page', 'Create a page in a Notion workspace.'),
]);

describe('ToolIndex.load', () => {
  it('loads an exact name, a different case of one, and a tool by its own name on its server', () => {
    expect(
      index.load({ names: ['nexus__github__create_issue', 'NEXUS__GMAIL__SEND_EMAIL', 'create_page'] }).loaded,
    ).toEqual(['nexus__github__create_issue', 'nexus__gmail__send_email', 'notes__notion__create_page']);
  });

  it('reports an unknown name with the nearest tools', () => {
    const result = index.load({ names: ['send_mail'] });
    expect(result).toMatchObject({ loaded: [], unmatched: ['send_mail'] });
    expect(result.suggestions[0]).toBe('nexus__gmail__send_email');
  });

  it('loads the best matches of a query, best first', () => {
    expect(index.load({ query: 'open an issue on github' }).loaded[0]).toBe('nexus__github__create_issue');
    expect(index.load({ query: 'email' }).loaded).toEqual(['nexus__gmail__send_email']);
  });

  it('caps what one call loads', () => {
    const many = new ToolIndex(
      Array.from({ length: 40 }, (_, i) => define(`s__repo_tool_${i}`, 'Read a repository.')),
    );
    expect(many.load({ query: 'repository' }).loaded).toHaveLength(QUERY_LOAD_COUNT);
    expect(many.load({ names: many.search('repository', 40) }).loaded).toHaveLength(MAX_NAMED_LOADS);
  });

  it('reports a query that matches nothing', () => {
    expect(index.load({ query: 'kubernetes' })).toEqual({ loaded: [], unmatched: ['kubernetes'], suggestions: [] });
  });
});
