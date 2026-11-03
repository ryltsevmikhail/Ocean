import { ref, computed, onBeforeUnmount } from 'vue';
import type { Message, Run } from '../protocol.js';
import { call } from './bridge.js';
import { explain } from './dom.js';

// A short frame can contain fewer rows than requested. Only an empty page ends a scan.
export async function pages<T, K extends number | string>(
  read: (after: K | undefined) => Promise<T[]>,
  key: (item: T) => K,
  from?: K,
) {
  const rows: T[] = [];
  let after = from;
  for (;;) {
    const part = await read(after);
    if (!part.length) return rows;
    const next = key(part[part.length - 1]!);
    if (after !== undefined && next <= after) throw Error('invalid_frame');
    rows.push(...part);
    after = next;
  }
}
export function readRoomRuns(room: string) {
  return pages(
    (after: string | undefined) => call({ op: 'runs', room, after }),
    (r) => r.turnId,
  );
}
export function useRoomFeed(preview: (roomId: string, message: Message) => void) {
  const history = ref<Message[]>([]),
    runs = ref<Run[]>([]),
    readError = ref('');
  const active = computed(() =>
    runs.value.find((r) => ['accepted', 'dispatching', 'prepared'].includes(r.turnStatus)),
  );
  let epoch = 0;
  onBeforeUnmount(() => epoch++);
  function open(room?: string) {
    const token = ++epoch;
    history.value = [];
    runs.value = [];
    readError.value = '';
    if (room) void observe(room, token);
  }
  async function observe(room: string, token: number) {
    let cursor: string | undefined, tracked: string | undefined;
    while (token === epoch) {
      try {
        // Establish the watermark before reading history. A later commit wakes the next wait.
        const notice = await call({ op: 'observe', room, cursor, runId: tracked });
        if (token !== epoch) return;
        cursor = notice.cursor;
        if (notice.kind === 'timeout') continue;
        const reset = notice.kind === 'resync' || notice.kind === 'snapshot';
        const messages = await pages(
          (after) => call({ op: 'history', room, after: after ?? 0 }),
          (m) => m.seq,
          reset ? 0 : (history.value.at(-1)?.seq ?? 0),
        );
        const snapshots = await readRoomRuns(room);
        if (token !== epoch) return;
        if (reset) history.value = messages;
        else history.value = history.value.concat(messages);
        runs.value = snapshots;
        const latest = history.value.at(-1);
        if (latest) preview(room, latest);
        readError.value = '';
        if (tracked !== active.value?.runId) {
          tracked = active.value?.runId;
          cursor = undefined;
        }
      } catch (e) {
        if (token !== epoch) return;
        readError.value = 'Чтение runtime · ' + explain(e);
        cursor = undefined;
        if (e instanceof Error && e.message === 'resync_required') history.value = [];
        if (e instanceof Error && e.message === 'unknown_run') tracked = undefined;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
  }
  return { history, runs, readError, active, open };
}
