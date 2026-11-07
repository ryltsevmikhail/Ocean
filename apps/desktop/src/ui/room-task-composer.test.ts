import { afterEach, expect, it, vi } from 'vitest';
import type * as Vue from 'vue';
import { commands } from '../protocol.js';
import { attachmentCommands } from '../attachments.js';
import { useDesktop } from './state.js';
import { useAttachments } from './composer-attachments.js';
vi.mock('vue', async (original) => ({
  ...(await original<typeof Vue>()),
  onMounted() {},
  onBeforeUnmount() {},
}));
afterEach(() => vi.unstubAllGlobals());
it('keeps the ordinary draft and imported chips through task refresh, abandoned form and confirmed text-only start', async () => {
  const room = { kind: 'direct' as const, id: 'composer_room', botId: 'a' };
  const binding = {
    profileId: 'a'.repeat(64),
    instanceId: '11111111-1111-4111-8111-111111111111',
    supported: true,
  };
  const chip = {
    id: crypto.randomUUID(),
    name: 'test.png',
    bytes: 3,
    sha256: 'b'.repeat(64),
    kind: 'image',
    mime: 'image/png',
  };
  const writes: unknown[] = [];
  vi.stubGlobal('window', {
    ocean: {
      async request(raw: unknown) {
        const asset = attachmentCommands.safeParse(raw);
        if (asset.success) return { version: 1, ok: true, data: chip };
        const c = commands.parse(raw);
        let data: unknown;
        if (c.op === 'observe' || c.op === 'task-observe') return new Promise(() => {});
        if (c.op === 'task-support') data = binding;
        else if (c.op === 'broadcast-list' || c.op === 'service-grants') data = [];
        else if (c.op === 'task-list')
          data = { workspaceId: 'ws_ocean', roomId: room.id, roots: [], nextBeforeSeq: null };
        else if (c.op === 'task-start') {
          writes.push(c.input);
          data = {
            version: 1,
            workspaceId: 'ws_ocean',
            roomId: room.id,
            rootId: 'root',
            messageId: 'm',
            seq: 1,
            deliveries: [{ botId: 'a', taskId: 'root', deliveryId: 'delivery' }],
          };
        } else throw Error('unexpected_' + c.op);
        return { version: 1, ok: true, data };
      },
    },
  });
  const desktop = useDesktop();
  desktop.read(room);
  desktop.draft.value = 'ordinary text';
  const attachments = useAttachments(() => room.id);
  await attachments.add([new File([new Uint8Array([1, 2, 3])], 'test.png', { type: 'image/png' })]);
  await desktop.tasks.refresh();
  const separate = {
    text: 'abandoned task',
    participants: [{ botId: 'a', grantReferences: [] }],
    initialBotIds: ['a'],
    mandate: { projectId: null, codingTaskId: null, permissions: [] },
  };
  expect(desktop.draft.value).toBe('ordinary text');
  expect(attachments.files.value).toEqual([chip]);
  separate.text = 'submitted text-only task';
  await desktop.tasks.start(separate);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ text: separate.text });
  expect(writes[0]).not.toHaveProperty('attachments');
  expect(desktop.draft.value).toBe('ordinary text');
  expect(attachments.files.value).toEqual([chip]);
  expect(desktop.sent.value).toBe(0);
  desktop.tasks.close();
  attachments.clear();
});
