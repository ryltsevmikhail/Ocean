import { computed, reactive, ref, type Ref } from 'vue';
import type {
  RoomTaskStart,
  RoomTaskReceipt,
  RoomTaskStopReceipt,
  RoomTaskRootView,
} from '@runnets/contracts';
import type { TaskBinding } from '../room-task-protocol.js';
import type { call } from './bridge.js';
type Pending = { profileId: string; input: RoomTaskStart };
export function taskActions(s: {
  room: Ref<string>;
  binding: Ref<TaskBinding | null>;
  stale: Ref<boolean>;
  view: Ref<RoomTaskRootView | null>;
  current: () => boolean;
  epoch: () => number;
  verify: () => Promise<boolean>;
  refresh: () => Promise<void>;
  request: typeof call;
  message: Ref<string>;
}) {
  const pending = ref<Pending | null>(null),
    receipt = ref<RoomTaskReceipt | null>(null),
    stopReceipt = ref<RoomTaskStopReceipt | null>(null),
    busy = ref(false);
  const unknownStops = reactive(new Map<string, string>());
  const stopKey = () => `${key()}/${s.view.value?.rootId}`;
  const stopUnknown = computed(() => unknownStops.has(stopKey()));
  const originals = new Map<string, Pending>();
  const key = () => `${s.binding.value?.profileId}/${s.room.value}`;
  function restore() {
    pending.value = originals.get(key()) ?? null;
  }
  function clear() {
    pending.value = null;
    receipt.value = null;
    stopReceipt.value = null;
    busy.value = false;
  }
  async function submit(input: RoomTaskStart, profileId: string) {
    const token = s.epoch(),
      ownKey = key();
    const replaying = originals.has(ownKey);
    const original = { profileId, input: JSON.parse(JSON.stringify(input)) as RoomTaskStart };
    const retire = () => {
      if (originals.get(ownKey) === original) originals.delete(ownKey);
    };
    originals.set(ownKey, original);
    pending.value = original;
    busy.value = true;
    try {
      const result = await s.request({
        op: 'task-start',
        binding: s.binding.value!,
        input: original.input,
      });
      retire();
      if (token !== s.epoch()) return;
      pending.value = null;
      receipt.value = result;
      s.message.value = `Принято: ${result.rootId} · ${result.messageId} · seq ${result.seq}`;
      busy.value = false;
      await s.refresh();
    } catch (e) {
      const code = e instanceof Error ? e.message : 'outcome_unknown';
      const refused =
        !replaying &&
        [
          'invalid_request',
          'invalid_params',
          'invalid_input',
          'not_member',
          'unknown_room',
          'authority_denied',
          'request_conflict',
          'task_identity_changed',
          'task_runtime_upgrade_required',
          'approval_required',
          'admission_closed',
          'workspace_conflict',
          'recovery_required',
          'batch_open',
          'room_busy',
          'provider_unavailable',
          'model_policy_unavailable',
          'runtime_draining',
        ].includes(code);
      if (refused) retire();
      if (token !== s.epoch()) return;
      if (refused) {
        pending.value = null;
        s.message.value = `Поручение отклонено: ${code}. Перечитайте область и выберите разрешения заново.`;
      } else
        s.message.value = `Квитанция не подтверждена · ${input.requestId}. Только явный повтор исходного запроса. ${code}${replaying ? ' · Ошибка повторной попытки не подтверждает исход первой.' : ''}`;
      s.stale.value = true;
    } finally {
      if (token === s.epoch()) busy.value = false;
    }
  }
  async function start(draft: Omit<RoomTaskStart, 'workspaceId' | 'roomId' | 'requestId'>) {
    if (busy.value || pending.value || s.stale.value) return;
    const token = s.epoch();
    busy.value = true;
    if (!(await s.verify()) || token !== s.epoch()) {
      if (token === s.epoch()) busy.value = false;
      return;
    }
    await submit(
      {
        ...(JSON.parse(JSON.stringify(draft)) as typeof draft),
        workspaceId: 'ws_ocean',
        roomId: s.room.value,
        requestId: crypto.randomUUID(),
      },
      s.binding.value!.profileId,
    );
  }
  async function replay() {
    const original = pending.value;
    if (!original || busy.value || s.stale.value) return;
    const token = s.epoch();
    busy.value = true;
    if (!(await s.verify()) || token !== s.epoch()) {
      if (token === s.epoch()) busy.value = false;
      return;
    }
    if (
      original.profileId !== s.binding.value?.profileId ||
      original.input.roomId !== s.room.value
    ) {
      busy.value = false;
      return;
    }
    await submit(original.input, original.profileId);
  }
  async function stop() {
    const before = s.view.value;
    if (
      !before ||
      !s.current() ||
      busy.value ||
      stopUnknown.value ||
      s.stale.value ||
      !['ready', 'paused'].includes(before.status)
    )
      return;
    const token = s.epoch();
    busy.value = true;
    if (!(await s.verify()) || token !== s.epoch()) {
      if (token === s.epoch()) busy.value = false;
      return;
    }
    let dispatched = false;
    const owningStop = stopKey(),
      requestId = crypto.randomUUID();
    const retireStop = () => {
      if (unknownStops.get(owningStop) === requestId) unknownStops.delete(owningStop);
    };
    try {
      const fresh = await s.request({
        op: 'task-get',
        binding: s.binding.value!,
        input: { workspaceId: 'ws_ocean', roomId: s.room.value, rootId: before.rootId },
      });
      if (token !== s.epoch()) return;
      if (fresh.revision !== before.revision || fresh.status !== before.status)
        throw Error('version_conflict');
      dispatched = true;
      unknownStops.set(owningStop, requestId);
      const result = await s.request({
        op: 'task-stop',
        binding: s.binding.value!,
        input: {
          workspaceId: 'ws_ocean',
          roomId: s.room.value,
          rootId: before.rootId,
          expectedRevision: before.revision,
          requestId,
        },
      });
      retireStop();
      if (token !== s.epoch()) return;
      stopReceipt.value = result;
      s.message.value =
        'Корень ограждён. Квитанция не подтверждает очистку дочерних запусков или отсутствие неизвестных эффектов.';
      busy.value = false;
      await s.refresh();
    } catch (e) {
      const code = e instanceof Error ? e.message : 'outcome_unknown';
      const unknown = ![
        'version_conflict',
        'revision_conflict',
        'task_identity_changed',
        'task_runtime_upgrade_required',
      ].includes(code);
      if (!unknown) retireStop();
      if (token !== s.epoch()) return;
      s.message.value = !dispatched
        ? `Корень не перечитан: ${code}. Остановка не отправлена.`
        : unknown
          ? `Остановка не подтверждена: ${code}. Запрос не повторён.`
          : `Остановка отклонена: ${code}. Перечитайте корень; запрос не повторён.`;
      s.stale.value = true;
    } finally {
      if (token === s.epoch()) busy.value = false;
    }
  }
  return { pending, receipt, stopReceipt, busy, stopUnknown, restore, clear, start, replay, stop };
}
