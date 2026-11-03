import { ref, computed, onMounted } from 'vue';
import type { Bot, Room, Command, Run } from '../protocol.js';
import { pages, useRoomFeed } from './room-feed.js';
import { call, SendFailure, submitDraft } from './bridge.js';
import { explain } from './dom.js';

export function useDesktop() {
  const bots = ref<Bot[]>([]),
    rooms = ref<Room[]>([]);
  const sent = ref(0),
    receipt = ref(''),
    admittedRun = ref<string | null>(null),
    uncertain = ref(false);
  const unconfirmed = new Map<string, Extract<Command, { op: 'send' }>>();
  const previews = ref<Record<string, string>>({});
  const { history, runs, readError, active, open } = useRoomFeed((id, latest) => {
    previews.value[id] =
      (latest.author === 'bot' ? label(latest.authorBotId) : 'Вы') +
      ' · ' +
      latest.body.slice(0, 120);
  });
  const drafts = new Map<string, string>();
  const room = ref<Room>(),
    recipient = ref(''),
    draft = ref(''),
    feedback = ref(''),
    busy = ref(false);
  const dialog = ref<'' | 'room' | 'bot'>(''),
    selected = ref<string[]>([]),
    title = ref('Ocean Team'),
    kind = ref<'group' | 'direct'>('group');
  const handle = ref(''),
    name = ref(''),
    role = ref(''),
    model = ref('deepseek-flash');
  const memberIds = computed(() =>
    room.value?.kind === 'group' ? room.value.botIds : [room.value?.botId],
  );
  const members = computed(() => bots.value.filter((b) => memberIds.value.includes(b.id)));
  const label = (id: string | undefined) =>
    bots.value.find((b) => b.id === id)?.handle ?? id ?? '?';
  const roomName = (r: Room) => (r.kind === 'group' ? r.title : '@' + label(r.botId));
  const roomPreview = (r: Room) =>
    previews.value[r.id] ??
    (r.kind === 'group'
      ? r.botIds.map(label).join(' · ')
      : bots.value.find((b) => b.id === r.botId)?.name);
  async function guard(action: () => Promise<void> | void) {
    if (busy.value) return;
    busy.value = true;
    feedback.value = '';
    try {
      await action();
    } catch (error) {
      feedback.value = explain(error);
    } finally {
      busy.value = false;
    }
  }
  function read(r: Room | undefined) {
    if (r?.id !== room.value?.id) {
      if (room.value) drafts.set(room.value.id, draft.value);
      draft.value = r ? (drafts.get(r.id) ?? '') : '';
      const original = r && unconfirmed.get(r.id);
      recipient.value = original?.to ?? '';
      receipt.value = original ? 'Квитанция не подтверждена · ' + original.requestId : '';
      admittedRun.value = null;
    }
    room.value = r;
    uncertain.value = r ? unconfirmed.has(r.id) : false;
    open(r?.id);
  }
  const loadBots = () =>
    pages(
      (after: string | undefined) => call({ op: 'bots', after }),
      (b) => b.id,
    );
  async function refresh(preferred?: string) {
    bots.value = await loadBots();
    rooms.value = await pages(
      (after: string | undefined) => call({ op: 'rooms', after }),
      (r) => r.id,
    );
    read(rooms.value.find((r) => r.id === (preferred ?? room.value?.id)) ?? rooms.value[0]);
  }
  onMounted(() => void guard(() => refresh()));
  const uuid = () => crypto.randomUUID();
  async function team() {
    for (const h of ['dev', 'review']) {
      if (!bots.value.some((b) => b.handle === h)) {
        await call({
          op: 'bot',
          requestId: uuid(),
          handle: h,
          name: h,
          role: h === 'dev' ? 'Разработчик' : 'Ревьюер',
          model: 'deepseek-flash',
        });
        bots.value = await loadBots();
      }
    }
    const group = await call({
      op: 'group',
      requestId: uuid(),
      title: 'Ocean Team',
      bots: bots.value.filter((b) => ['dev', 'review'].includes(b.handle)).map((b) => b.id),
    });
    await refresh(group.data.id);
  }
  async function create() {
    if (dialog.value === 'bot') {
      await call({
        op: 'bot',
        requestId: uuid(),
        handle: handle.value,
        name: name.value,
        role: role.value,
        model: model.value,
      });
      await refresh();
    } else {
      const item =
        kind.value === 'direct'
          ? await call({ op: 'direct', requestId: uuid(), bot: selected.value[0] ?? '' })
          : await call({
              op: 'group',
              requestId: uuid(),
              title: title.value,
              bots: [...selected.value],
            });
      await refresh(item.data.id);
    }
    dialog.value = '';
  }
  async function send(attachments: string[] = []) {
    const r = room.value;
    if (!r) return;
    const original = unconfirmed.get(r.id);
    const command = original ?? {
      op: 'send',
      room: r.id,
      text: draft.value,
      attachments: [...attachments],
      to: r.kind === 'group' ? recipient.value || null : null,
      requestId: uuid(),
    };

    try {
      const result = await submitDraft(command, original !== undefined);
      admittedRun.value = result.runId;
      receipt.value = 'Принято · ' + result.messageId + ' · ' + (result.runId ?? 'recorded');
      unconfirmed.delete(r.id);
      uncertain.value = false;
      draft.value = '';
      recipient.value = '';
      sent.value++;
    } catch (error) {
      if (
        error instanceof SendFailure &&
        (!original || (error.stage === 'refused' && error.message !== 'request_conflict'))
      ) {
        unconfirmed.delete(r.id);
        uncertain.value = false;
        if (original) receipt.value = '';
      } else {
        unconfirmed.set(r.id, command);
        uncertain.value = true;
        receipt.value = 'Квитанция не подтверждена · ' + command.requestId;
      }
      throw error;
    }
  }
  async function stop(r: Run) {
    await guard(async () => {
      const ack = await call({
        op: 'cancel',
        room: r.roomId,
        runId: r.runId,
        expectedVersion: r.version,
        requestId: uuid(),
      });
      feedback.value = 'Отмена запрошена · ' + r.runId + ' [v' + ack.version + ']';
    });
  }
  return {
    bots,
    roomPreview,
    rooms,
    room,
    history,
    runs,
    members,
    recipient,
    draft,
    feedback,
    busy,
    active,
    receipt,
    readError,
    uncertain,
    shownRun: computed(() => {
      if (admittedRun.value) return runs.value.find((r) => r.runId === admittedRun.value);
      if (active.value) return active.value;
      const byMessage = new Map(runs.value.map((r) => [r.messageId, r]));
      const latest = history.value.findLast((m) => byMessage.has(m.id));
      return latest && byMessage.get(latest.id);
    }),
    sent,
    dialog,
    selected,
    title,
    kind,
    handle,
    name,
    role,
    model,
    label,
    roomName,
    guard,
    read,
    refresh,
    team,
    create,
    send,
    stop,
  };
}
