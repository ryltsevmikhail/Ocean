import { mkdirSync, mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import {
  readLocalRuntimeDescriptor,
  localRuntimePaths,
  connectLocalRuntime,
} from '@runnets/tools-node';
import { openOceanProfile } from './profile.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { child } from '../../test-fixtures/profile-cli.test.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
it.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['disconnect', 3],
] as const)(
  'detaches on %s with the exact ID after the owner commits but before acknowledgement',
  async (signal, code) => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-sig-')),
      profile = join(root, 'p'),
      run = join(root, 'r'),
      shadow = join(root, 's');
    mkdirSync(run, { mode: 0o700 });
    mkdirSync(shadow, { mode: 0o700 });
    vi.stubEnv('XDG_RUNTIME_DIR', run);
    const r = openOceanProfile(profile, true);
    await r.ready;
    const { groupId: roomId, workspaceId } = rooms(r.conversations);
    r.close();
    const owner = await startLocalRuntime({ profile, provider: null }),
      desc = readLocalRuntimeDescriptor(profile),
      observer = await connectLocalRuntime({ profile });
    vi.stubEnv('XDG_RUNTIME_DIR', shadow);
    const paths = localRuntimePaths(profile);
    mkdirSync(paths.directory, { mode: 0o700 });
    const sockets: Socket[] = [],
      methods: string[] = [];
    let committed = false;
    const server = createServer((down) => {
      const up = connect(desc.endpoint);
      sockets.push(up, down);
      let downBuf = '',
        upBuf = '';
      down.on('data', (b: Buffer) => {
        downBuf += b.toString();
        let end;
        while ((end = downBuf.indexOf('\n')) >= 0) {
          const line = downBuf.slice(0, end + 1);
          downBuf = downBuf.slice(end + 1);
          methods.push(JSON.parse(line).method);
          up.write(line);
        }
      });
      up.on('data', (b: Buffer) => {
        upBuf += b.toString();
        let end;
        while ((end = upBuf.indexOf('\n')) >= 0) {
          const line = upBuf.slice(0, end + 1);
          upBuf = upBuf.slice(end + 1);
          if (JSON.parse(line).result?.requestId === 'original') {
            committed = true;
          } else down.write(line);
        }
      });
    });
    await new Promise<void>((r) => server.listen(paths.endpoint, r));
    chmodSync(paths.endpoint, 0o600);
    writeFileSync(paths.descriptor, JSON.stringify({ ...desc, endpoint: paths.endpoint }), {
      mode: 0o600,
    });
    const cli = child(
      [
        'send',
        roomId,
        '--profile',
        profile,
        '--json',
        '--text',
        'message',
        '--request-id',
        'original',
      ],
      { XDG_RUNTIME_DIR: shadow },
    );
    try {
      await vi.waitFor(() => expect(committed).toBe(true), { timeout: 2000 });
      if (signal === 'disconnect') for (const s of sockets) s.destroy();
      else cli.proc.kill(signal);
      expect(await cli.exit).toBe(code);
      expect(JSON.parse(cli.out())).toMatchObject({
        version: 1,
        ok: false,
        error: { code: 'receipt_unknown', requestId: 'original' },
      });
      expect(methods).toEqual(['hello', 'turns.submit']);
      expect(
        await observer.getReceipt({ workspaceId, roomId, requestId: 'original' }),
      ).toMatchObject({ runId: null });
    } finally {
      cli.proc.kill('SIGKILL');
      await cli.exit;
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      observer.close();
      await owner.stop();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
  8000,
);
