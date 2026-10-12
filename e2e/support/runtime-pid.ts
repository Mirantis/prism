import os from 'node:os';
import path from 'node:path';

/** Where `runtime-supervisor.ts` writes the pid of the runtime it runs. */
export const RUNTIME_PID_FILE = path.join(os.tmpdir(), 'prism-e2e-runtime.pid');
