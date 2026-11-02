import type { CodingAgentId } from '@/types';

/** The subscription each coding agent signs in to. */
export const CODING_AGENT_PROVIDER: Record<CodingAgentId, string> = {
  'claude-code': 'Claude',
  codex: 'ChatGPT',
};

/** The company whose page each subscription signs in on. */
export const CODING_AGENT_COMPANY: Record<CodingAgentId, string> = { 'claude-code': 'Anthropic', codex: 'OpenAI' };

/** Each coding agent's name, for where its row from the runtime is not at hand. */
export const CODING_AGENT_NAME: Record<CodingAgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export const CODING_AGENTS_QUERY_KEY = ['coding-agents'] as const;

/** The search of a link that opens a coding agent's sign-in: `?agent=…&sign-in=…`. */
export interface CodingAgentSignInSearch {
  agent?: CodingAgentId;
  'sign-in'?: string;
}

export function codingAgentSignInSearch(search: Record<string, unknown>): CodingAgentSignInSearch {
  const agent = search.agent === 'claude-code' || search.agent === 'codex' ? search.agent : undefined;
  if (!agent) return {};
  const id = search['sign-in'];
  return typeof id === 'string' && id ? { agent, 'sign-in': id } : { agent };
}
