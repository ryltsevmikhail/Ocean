/**
 * `runne acp` — expose the runtime to an external desktop client.
 *
 * The client spawns this process and speaks newline-delimited JSON-RPC over
 * stdio (Agent Client Protocol v1). The process exits when the client closes
 * stdin, which also ends every turn it owns. `DEEPSEEK_API_KEY` enables real
 * model turns; without it a turn stays deterministic. `RUNNE_DB` keeps the
 * committed streams in SQLite instead of process memory.
 */

import { createTools } from '../tools.js';
import { acpPermissions } from './permissions.js';
import { JsonRpcPeer } from './transport.js';
import { AcpAgent } from './agent.js';
import { createProviderFromEnv } from '../engine/provider.js';
import { createRuntimeFromEnv } from '../runtime.js';

export async function runAcp(): Promise<number> {
  const runtime = createRuntimeFromEnv();
  try {
    const recovery = await runtime.ready;
    const peer = new JsonRpcPeer({ input: process.stdin, output: process.stdout });
    const agent = new AcpAgent(peer, runtime.service, {
      provider: createProviderFromEnv(process.env),
      recovery,
      createTools: (cwd, sessionId) =>
        createTools(cwd, acpPermissions(peer, sessionId), runtime.toolJournal),
    });
    agent.attach();

    await new Promise<void>((resolve) => {
      process.stdin.once('end', resolve);
      process.stdin.once('close', resolve);
    });
    agent.shutdown();
    await peer.drain();
    return 0;
  } finally {
    runtime.close();
  }
}
