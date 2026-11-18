/**
 * `prism acp`: serve the Agent Client Protocol on stdio, for an editor or any
 * other ACP client that starts this process. stdout is the protocol's alone.
 */

import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { loadConfig } from '../config.js';
import { UPDATE_REQUIRED_NOTICE } from '../tui-adapter.js';
import { acpAgent } from './acp-agent.js';
import { HttpRuntime } from './runtime.js';

export function runAcpCommand(): void {
  const version = process.env.PRISM_VERSION ?? '0.0.0-dev';
  const runtime = new HttpRuntime(loadConfig().httpUrl, version);
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = acpAgent(runtime, version).connect(stream);

  runtime.events.on('unsupported', () => {
    process.stderr.write(`prism acp: ${UPDATE_REQUIRED_NOTICE}\n`);
    process.exitCode = 1;
    connection.close();
  });
  // The client closing stdin ends the session. Closing the socket leaves nothing to keep the process alive.
  void connection.closed.then(() => runtime.close());
}
