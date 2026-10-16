import type { ExecutionEnvironment } from '../../execution-environments/execution-environment';
import { createSubscriptionProvider } from '../subscription-provider';
import { ClaudeSession } from './session';

export function createClaudeSubscriptionProvider(environment?: ExecutionEnvironment) {
  return createSubscriptionProvider('claude-subscription', (target, options, finished) => new ClaudeSession(target, options, finished), environment);
}
