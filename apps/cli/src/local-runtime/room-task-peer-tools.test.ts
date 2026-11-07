import { expect, it, vi } from 'vitest';
import type { RoomTaskStart } from '@runnets/contracts';
import { connectLocalRuntime } from '@runnets/tools-node';
import { roomTaskHostFixture } from '../../test-fixtures/room-task-host.js';
import { startLocalRuntime } from './host.js';

const roomToolNames = ['room_delegate', 'room_send', 'room_state'];
function toolNames(body: string): string[] {
  const request = JSON.parse(body) as { tools?: { function: { name: string } }[] };
  return (request.tools ?? []).map((tool) => tool.function.name).sort();
}

it.each([false, undefined] as const)(
  'runs cloud → local → cloud and replays the exact start after restart (peerTools: %s)',
  async (peerTools) => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
    const f = await roomTaskHostFixture(false, { tools: true });
    const startHost = () =>
      startLocalRuntime({
        profile: f.profile,
        providerHttpClient: f.httpClient,
        roomTaskCapacity: 1,
      });
    let host = await startHost();
    let client = await connectLocalRuntime({ profile: f.profile });
    try {
      const request = (setting: false | undefined): RoomTaskStart => ({
        ...f.input,
        participants: f.input.participants.map((p, i) =>
          i === 1 && setting === false ? { ...p, peerTools: setting } : p,
        ),
      });
      const input = request(peerTools);
      for (const invalid of [
        { peerTools: true },
        { peerTools: null },
        { peerTools: undefined },
        { peerTools: false, unknown: false },
        Object.defineProperty({}, 'peerTools', { value: false }),
      ]) {
        const participant = Object.defineProperties(
          { ...f.input.participants[1]! },
          Object.getOwnPropertyDescriptors(invalid),
        );
        await expect(
          client.roomTaskStart({ ...input, participants: [input.participants[0]!, participant] }),
        ).rejects.toThrow('invalid_params');
      }
      const receipt = await client.roomTaskStart(input);
      const scope = {
        workspaceId: input.workspaceId,
        roomId: input.roomId,
        rootId: receipt.rootId,
      };
      await vi.waitFor(async () => {
        expect((await client.roomTaskGet(scope)).status).toBe('completed');
      });
      const before = await client.roomTaskObserve(scope);
      expect(before.view.counts).toMatchObject({ slices: 3, modelStarts: 3, toolCalls: 1 });
      expect(
        before.view.rows
          .filter((r) => r.type === 'delivery')
          .map((r) => r.kind)
          .sort(),
      ).toEqual(['delegate', 'result', 'start']);
      expect(f.requests).toHaveLength(3);
      const [cloud, local, resumed] = f.requests as [string, string, string];
      expect(toolNames(cloud)).toEqual(roomToolNames);
      expect(toolNames(local)).toEqual(peerTools === false ? [] : roomToolNames);
      if (peerTools === false) expect(JSON.parse(local)).not.toHaveProperty('tools');
      expect(local).toContain('ask B');
      expect(resumed).toContain('B done');
      expect(toolNames(resumed)).toEqual(roomToolNames);

      client.close();
      await host.stop();
      host = await startHost();
      client = await connectLocalRuntime({ profile: f.profile });
      expect(await client.roomTaskStart(input)).toEqual(receipt);
      await expect(
        client.roomTaskStart(request(peerTools === false ? undefined : false)),
      ).rejects.toThrow('request_conflict');
      expect(await client.roomTaskObserve({ ...scope, cursor: before.cursor })).toMatchObject({
        kind: 'resync',
        view: before.view,
      });
      expect(f.requests).toHaveLength(3);
    } finally {
      client.close();
      await host.stop();
      f.dispose();
      vi.unstubAllEnvs();
    }
  },
);
