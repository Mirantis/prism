import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { createSubscriptionProvider } from '../subscription-provider';
import { CodexSession } from './app-server';

export function createCodexSubscriptionProvider(environment?: ExecutionEnvironment) {
  return createSubscriptionProvider('codex-subscription', (target, options, finished) => new CodexSession(target, options, finished), environment);
}
