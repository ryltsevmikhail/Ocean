import { ref, computed } from 'vue';
import type {
  RoomTaskSummary,
  RoomTaskRootView,
  LocalOwnerScopeGrant,
  RoomTaskObservation,
} from '@runnets/contracts';
import type { TaskBinding } from '../room-task-protocol.js';
import { call } from './bridge.js';
import { taskActions } from './room-task-actions.js';
const identity = (b: TaskBinding | null) => b && `${b.profileId}/${b.instanceId}`;
export function createRoomTasks(request: typeof call = call) {
  const room = ref(''),
    binding = ref<TaskBinding | null>(null),
    supported = ref<boolean | null>(null),
    roots = ref<readonly RoomTaskSummary[]>([]),
    view = ref<RoomTaskRootView | null>(null),
    selected = ref(''),
    next = ref<number | null>(null),
    stale = ref(true),
    message = ref(''),
    grants = ref<readonly LocalOwnerScopeGrant[]>([]),
    reading = ref(false),
    grantsUnavailable = ref(true);
  let epoch = 0,
    selection = 0,
    actionSelection = 0,
    listVersion = 0;
  let waiter: Promise<RoomTaskObservation> | null = null;
  const current = computed(
    () => roots.value.find((r) => r.rootId === selected.value)?.authority === 'current',
  );
  const actionEpoch = () => epoch * 1000000 + actionSelection;
  async function verify() {
    const token = actionEpoch(),
      original = identity(binding.value);
    try {
      const fresh = await request({ op: 'task-support' });
      if (token !== actionEpoch()) return false;
      if (!fresh.supported || original !== identity(fresh)) throw Error('task_identity_changed');
      return true;
    } catch (e) {
      if (token === actionEpoch()) {
        stale.value = true;
        message.value = `Область устарела: ${String(e instanceof Error ? e.message : e)}. Перечитайте задачи перед действием.`;
      }
      return false;
    }
  }
  const actions = taskActions({
    room,
    binding,
    stale,
    view,
    current: () => current.value,
    epoch: actionEpoch,
    verify,
    refresh,
    request,
    message,
  });
  async function context(id: string) {
    if (room.value === id) return;
    ++epoch;
    ++selection;
    ++listVersion;
    room.value = id;
    binding.value = null;
    supported.value = null;
    roots.value = [];
    view.value = null;
    selected.value = '';
    next.value = null;
    stale.value = true;
    grants.value = [];
    message.value = '';
    actions.clear();
    if (id) await refresh();
  }
  function close() {
    ++epoch;
    ++selection;
    ++listVersion;
    stale.value = true;
  }
  async function refresh(older = false) {
    if (!room.value || (older && next.value === null)) return;
    const token = epoch,
      version = ++listVersion,
      owningRoom = room.value;
    reading.value = true;
    stale.value = true;
    try {
      const support = await request({ op: 'task-support' });
      if (token !== epoch || version !== listVersion) return;
      if (identity(binding.value) !== identity(support)) {
        ++selection;
        ++actionSelection;
        view.value = null;
        grants.value = [];
        actions.clear();
      }
      const owner = { profileId: support.profileId, instanceId: support.instanceId };
      binding.value = owner;
      supported.value = support.supported;
      actions.restore();
      if (!support.supported) {
        ++selection;
        message.value = 'Задачи команды недоступны у этого runtime. История разговора доступна.';
        return;
      }
      const result = await request({
        op: 'task-list',
        binding: owner,
        input: {
          workspaceId: 'ws_ocean',
          roomId: owningRoom,
          limit: 50,
          ...(older ? { beforeSeq: next.value! } : {}),
        },
      });
      if (token !== epoch || version !== listVersion) return;
      if (result.roomId !== owningRoom) throw Error('invalid_frame');
      const merged = older ? [...roots.value, ...result.roots] : [...result.roots];
      if (new Set(merged.map((r) => r.rootId)).size !== merged.length) throw Error('invalid_frame');
      roots.value = merged;
      next.value = result.nextBeforeSeq;
      try {
        const gs = await request({ op: 'service-grants', binding: owner });
        if (token === epoch && version === listVersion) {
          grants.value = gs;
          grantsUnavailable.value = false;
        }
      } catch (e) {
        if (token === epoch && version === listVersion) {
          grants.value = [];
          grantsUnavailable.value = true;
        }
        if (e instanceof Error && e.message === 'task_identity_changed') throw e;
      }
      if (token !== epoch || version !== listVersion) return;
      stale.value = false;
      const chosen = selected.value || roots.value[0]?.rootId;
      if (chosen) await select(chosen, false);
      else {
        ++selection;
        selected.value = '';
        view.value = null;
      }
    } catch (e) {
      if (token === epoch && version === listVersion) {
        stale.value = true;
        message.value = `Последние прочитанные данные · ${String(e instanceof Error ? e.message : e)}`;
      }
    } finally {
      if (token === epoch && version === listVersion) reading.value = false;
    }
  }
  async function full(rootId: string, token: number, pick: number, owner: TaskBinding) {
    for (let attempt = 0; attempt < 2; ++attempt) {
      if (token !== epoch || pick !== selection) return false;
      try {
        const result = await request({
          op: 'task-get',
          binding: owner,
          input: { workspaceId: 'ws_ocean', roomId: room.value, rootId },
        });
        if (token !== epoch || pick !== selection) return false;
        if (result.roomId !== room.value || result.rootId !== rootId) throw Error('invalid_frame');
        view.value = result;
        return true;
      } catch (e) {
        if (!(e instanceof Error) || e.message !== 'resync_required' || attempt === 1) throw e;
      }
    }
    return false;
  }
  async function select(rootId: string, explicit = true) {
    if (explicit) ++actionSelection;
    if (
      !binding.value ||
      (!roots.value.some((r) => r.rootId === rootId) && selected.value !== rootId)
    )
      return;
    const token = epoch,
      pick = ++selection,
      owner = { ...binding.value };
    selected.value = rootId;
    view.value = null;
    try {
      if (await full(rootId, token, pick, owner)) void observe(rootId, token, pick, owner);
    } catch (e) {
      if (token === epoch && pick === selection) {
        stale.value = true;
        message.value = `Данные задачи устарели · ${String(e instanceof Error ? e.message : e)}`;
      }
    }
  }
  async function observe(rootId: string, token: number, pick: number, owner: TaskBinding) {
    let cursor: string | undefined;
    while (token === epoch && pick === selection) {
      try {
        // Old scopes retire naturally; a new selection reuses the one local wait slot.
        if (waiter) {
          await waiter.catch(() => undefined);
          continue;
        }
        const pending = request({
          op: 'task-observe',
          binding: owner,
          input: {
            workspaceId: 'ws_ocean',
            roomId: room.value,
            rootId,
            ...(cursor ? { cursor } : {}),
            waitMs: 1000,
          },
        });
        waiter = pending;
        let result: RoomTaskObservation;
        try {
          result = await pending;
        } finally {
          if (waiter === pending) waiter = null;
        }
        if (token !== epoch || pick !== selection) return;
        if (
          result.instanceId !== owner.instanceId ||
          result.view.roomId !== room.value ||
          result.view.rootId !== rootId
        )
          throw Error('invalid_frame');
        cursor = result.cursor;
        if (result.kind !== 'timeout') await full(rootId, token, pick, owner);
      } catch (e) {
        if (token === epoch && pick === selection) {
          stale.value = true;
          message.value = `Наблюдение прервано · ${String(e instanceof Error ? e.message : e)}. Перечитайте задачи.`;
        }
        return;
      }
    }
  }
  function watermark(id: string) {
    if (room.value === id) void refresh();
  }
  return {
    watermark,
    room,
    binding,
    supported,
    roots,
    selected,
    view,
    next,
    stale,
    message,
    grants,
    grantsUnavailable,
    reading,
    current,
    context,
    close,
    refresh,
    select,
    verify,
    ...actions,
  };
}
export type RoomTasksState = ReturnType<typeof createRoomTasks>;
