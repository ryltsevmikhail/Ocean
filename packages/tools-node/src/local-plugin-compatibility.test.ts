import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { localRuntimePaths, prepareLocalRuntimePaths } from './local-runtime-paths.js';
import { LocalRuntimeFrames, writeLocalRuntimeFrame } from './local-runtime-framing.js';
import { connectPublishedRuntime } from './local-runtime-client.js';

it.each([
  { label: 'old plugin owner', capabilities: ['plugin.connection-discover'], accepted: false },
  {
    label: 'repaired plugin owner',
    capabilities: ['plugin.connection-discover', 'plugin.session-authority-v1'],
    accepted: true,
  },
  { label: 'minimal non-plugin peer', capabilities: [], accepted: true },
])(
  'checks $label during hello before any command or effect',
  async ({ capabilities, accepted }) => {
    const root = mkdtempSync(join(tmpdir(), 'opc-'));
    const profile = join(root, 'profile');
    mkdirSync(profile, { mode: 0o700 });
    const paths = localRuntimePaths(profile);
    prepareLocalRuntimePaths(paths);
    const descriptor = {
      protocol: 1,
      profileId: paths.profileId,
      instanceId: '11111111-1111-1111-1111-111111111111',
      endpoint: paths.endpoint,
      capability: 'a'.repeat(64),
    };
    const methods: string[] = [];
    const hellos: unknown[] = [];
    const server = createServer((socket) => {
      const frames = new LocalRuntimeFrames((raw) => {
        const request = raw as { id: string; method: string; params: unknown };
        hellos.push(request.params);
        methods.push(request.method);
        writeLocalRuntimeFrame(socket, {
          id: request.id,
          result: {
            ...descriptor,
            capabilities: ['status', 'stop', ...capabilities],
          },
        });
      });
      socket.on('data', (bytes) => frames.push(bytes));
    });
    await new Promise<void>((resolve) => server.listen(paths.endpoint, resolve));
    chmodSync(paths.endpoint, 0o600);
    writeFileSync(paths.descriptor, JSON.stringify(descriptor), { mode: 0o600 });
    try {
      const connected = connectPublishedRuntime(profile);
      // Close the old implementation's unexpected successful peer so RED never hangs.
      void connected?.then(
        (peer) => peer.close(),
        () => {},
      );
      if (accepted) {
        const peer = await connected;
        expect(peer).not.toBeNull();
        await expect(peer?.listModelConnections()).rejects.toThrow(
          'model_runtime_upgrade_required',
        );
        peer?.close();
      } else await expect(connected).rejects.toThrow('plugin_runtime_upgrade_required');
      expect(methods).toEqual(['hello']);
      expect(hellos).toEqual([
        {
          ...descriptor,
          clientFeatures: [
            'plugin.session-authority-v1',
            'model.connections-v1',
            'decisions.service-v1',
            'service.authority-v2',
          ],
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(paths.directory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
