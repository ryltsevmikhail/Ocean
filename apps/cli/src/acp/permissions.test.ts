import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { JsonRpcPeer } from './transport.js';
import { acpPermissions } from './permissions.js';

const tool = {
  title: 'Edit a.ts',
  kind: 'edit' as const,
  preview: 'before -> after',
  execute: () => Promise.resolve({ output: 'ok', isError: false }),
};
it.each(['allow_once', 'allow_session', 'unknown'])(
  'accepts only recognized permission option %s',
  async (optionId) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer({ input, output });
    output.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString('utf8')) as {
        id: number;
        method: string;
        params: { toolCall: { content: unknown } };
      };
      expect(request.method).toBe('session/request_permission');
      expect(JSON.stringify(request.params.toolCall.content)).toContain('before -> after');
      input.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { outcome: { outcome: 'selected', optionId } },
        }) + '\n',
      );
    });
    try {
      expect(await acpPermissions(peer, 's_1').review(tool, new AbortController().signal)).toBe(
        optionId === 'unknown' ? 'reject' : optionId,
      );
    } finally {
      input.end();
      output.end();
    }
  },
);
it('cancels an outstanding approval without waiting for the client response', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const peer = new JsonRpcPeer({ input, output });
  const controller = new AbortController();
  const result = acpPermissions(peer, 's_1').review(tool, controller.signal);
  controller.abort();
  try {
    expect(await result).toBe('reject');
  } finally {
    input.end();
    output.end();
  }
});
