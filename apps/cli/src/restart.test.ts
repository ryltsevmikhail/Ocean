import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { taskRunId } from '@runnets/domain';

import { AcpAgent } from './acp/agent.js';
import { JsonRpcPeer } from './acp/transport.js';
import { createService } from './lifecycle.js';
import { TuiSession } from './tui/session.js';

describe('host identity after restarting over retained streams', () => {
  it('creates a fresh ACP run instead of replaying a previous creation receipt', async () => {
    const service = createService();
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer({ input, output });
    try {
      const first = await new AcpAgent(peer, service).newSession({ cwd: '/workspace' });
      const second = await new AcpAgent(peer, service).newSession({ cwd: '/workspace' });
      expect(second.sessionId).not.toBe(first.sessionId);
      expect((await service.state(taskRunId(`tr_${second.sessionId}_t1`))).status).toBe('created');
    } finally {
      input.end();
      output.resume();
    }
  });

  it('creates a fresh TUI run when the previous host left a committed run', async () => {
    const service = createService();
    const first = await new TuiSession({ service, provider: null }).createRun(null);
    const second = await new TuiSession({ service, provider: null }).createRun(null);
    expect(second).not.toBe(first);
    expect(await service.events(first)).toHaveLength(1);
    expect(await service.events(second)).toHaveLength(1);
  });
});
