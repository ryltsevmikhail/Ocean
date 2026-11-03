import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { captureDesktopAssets, desktopRootIdentity } from './desktop-assets.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it.each([
  'outside',
  'wrong-room',
  'wrong-request',
  'no-operation',
  'duplicate-operation',
  'completed',
  'wrong-binding',
  'third-alias',
  'message-already-sent',
])('refuses %s preparation aliases before any source body read', async (kind) => {
  const actual = await vi.importActual<typeof fs>('node:fs'),
    parent = fs.mkdtempSync(join(tmpdir(), 'ocean-desktop-alias-'));
  roots.push(parent);
  const root = join(parent, 'source'),
    room = 'room',
    requestId = '12345678-1234-4123-8123-123456789abc',
    other = '22345678-1234-4123-8123-123456789abc',
    temporary = requestId + '.json.' + other + '.tmp';
  fs.mkdirSync(join(root, room), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(root, 'other'), { mode: 0o700 });
  const canonical = join(root, room, requestId + '.json');
  fs.writeFileSync(canonical, 'must-not-read', { mode: 0o600 });
  fs.linkSync(
    canonical,
    kind === 'outside'
      ? join(parent, temporary)
      : join(
          root,
          kind === 'wrong-room' ? 'other' : room,
          kind === 'wrong-request' ? other + '.json.' + other + '.tmp' : temporary,
        ),
  );
  if (kind === 'third-alias') fs.linkSync(canonical, join(parent, 'third'));
  const operation = {
    id: 'prepare:' + room + ':' + requestId,
    binding: JSON.stringify({
      room,
      requestId: kind === 'wrong-binding' ? other : requestId,
      body: 'caption',
      to: null,
      ids: [other],
    }),
    state: kind === 'completed' ? ('completed' as const) : ('started' as const),
    result: kind === 'completed' ? '{}' : null,
  };
  const inventory = {
    format: 1 as const,
    binding: {
      profileId: 'a'.repeat(64),
      root,
      originalRoot: root,
      identity: desktopRootIdentity(root),
    },
    rooms: [room, 'other'],
    messages:
      kind === 'message-already-sent'
        ? [{ id: 'sent', roomId: room, requestId, body: '', requestBinding: '', requestReply: '' }]
        : [],
    operations:
      kind === 'no-operation'
        ? []
        : kind === 'duplicate-operation'
          ? [operation, operation]
          : [operation],
    uploads: [],
  };
  let bodies = 0;
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (actual.realpathSync('/proc/self/fd/' + args[0]).startsWith(root + '/')) bodies++;
    return actual.readSync(...args);
  }) as typeof fs.readSync);
  expect(() => captureDesktopAssets(inventory)).toThrow();
  expect(bodies).toBe(0);
});
