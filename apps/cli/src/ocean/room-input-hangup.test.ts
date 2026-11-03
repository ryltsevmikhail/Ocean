import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { runDirectTui } from './tui.js';
import { roomProfileFixture } from '../../test-fixtures/remote-terminal.test.js';
it.each(['read', 'signal-first', 'late-close'])(
  'detaches on PTY read EIO with %s ordering',
  async (order) => {
    const cleanup: (() => void | Promise<void>)[] = [];
    try {
      const f = await roomProfileFixture(cleanup);
      let screen = '';
      let finish!: () => void;
      const input = new PassThrough({
          destroy(error, done) {
            if (order === 'late-close') finish = () => done(error);
            else done(error);
          },
        }),
        output = new PassThrough();
      output.on('data', (b) => {
        screen += b;
      });
      const session = runDirectTui({ profile: f.profile, roomId: f.scope.roomId, input, output });
      try {
        await vi.waitFor(() => expect(screen).toContain('@dev / test'));
        const error = Object.assign(Error('read EIO'), { code: 'EIO', syscall: 'read' });
        if (order === 'signal-first') process.emit('SIGHUP', 'SIGHUP');
        expect(() =>
          input.emit('error', Object.assign(Error('other I/O'), { code: 'EIO', syscall: 'write' })),
        ).toThrow('other I/O');
        if (order === 'late-close') {
          process.emit('SIGTERM', 'SIGTERM');
          input.destroy(error);
          await expect(session).resolves.toBe(0);
          const closed = new Promise<void>((r) => input.once('close', r));
          finish();
          await closed;
          expect(input.listenerCount('error')).toBe(0);
        } else expect(() => input.emit('error', error)).not.toThrow();
        await expect(session).resolves.toBe(0);
        expect((await f.peer.status()).state).toBe('ready');
      } finally {
        input.end();
        await session;
      }
    } finally {
      for (const f of cleanup.reverse()) await f();
      vi.unstubAllEnvs();
    }
  },
);
