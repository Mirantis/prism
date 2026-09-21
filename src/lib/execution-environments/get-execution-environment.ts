/** The one execution environment this deployment runs in. */

import { createLocalEnvironment } from './local/local-environment';
import type { ExecutionEnvironment, ExecutionEnvironmentName } from './execution-environment';

const FACTORIES: Record<ExecutionEnvironmentName, () => ExecutionEnvironment> = {
  local: createLocalEnvironment,
};

/** Which environment serves this deployment. Derived from the host, not configured. */
function detect(): ExecutionEnvironmentName {
  return 'local';
}

let instance: ExecutionEnvironment | null = null;

export function getExecutionEnvironment(): ExecutionEnvironment {
  if (!instance) instance = FACTORIES[detect()]();
  return instance;
}

/** Test-only: stand in a fake environment, or restore the real one with null. */
export function __setExecutionEnvironmentForTests(env: ExecutionEnvironment | null): void {
  instance = env;
}
