import { ref, computed, onMounted } from 'vue';
import type { Bot, Room, Message, Run } from '../protocol.js';
import { pageSize } from '../protocol.js';
import { call, cancel } from './bridge.js';
import { explain } from './dom.js';

export function useDesktop() {
  const bots = ref<Bot[]>([]),
    rooms = ref<Room[]>([]),
    history = ref<Message[]>([]);
  const sent = ref(0);
  let lastSend: { signature: string; id: string } | undefined;
  const runs = ref<Run[]>([]);
  const previews = ref<Record<string, string>>({});
  const drafts = new Map<string, string>();
  const room = ref<Room>(),
    recipient = ref(''),
    draft = ref(''),
    feedback = ref(''),
    busy = ref(false),
    pending = ref('');
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
  async function guard(action: () => Promise<void>) {
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
  async function read(r: Room | undefined) {
    if (r?.id !== room.value?.id) {
      if (room.value) drafts.set(room.value.id, draft.value);
      draft.value = r ? (drafts.get(r.id) ?? '') : '';
      recipient.value = '';
    }
    room.value = r;
    history.value = [];
    runs.value = [];
    if (!r) return;
    let after = 0;
    for (;;) {
      const page = await call({ op: 'history', room: r.id, after });
      history.value.push(...page);
      if (page.length < pageSize) break;
      const last = page.at(-1);
      if (!last || last.seq <= after) throw new Error('outcome_unknown');
      after = last.seq;
    }
    const latest = history.value.at(-1);
    if (latest)
      previews.value[r.id] =
        (latest.author === 'bot' ? label(latest.authorBotId) : 'Вы') +
        ' · ' +
        latest.body.slice(0, 120);
    runs.value = await call({ op: 'runs', room: r.id });
  }
  async function refresh(preferred?: string) {
    bots.value = await call({ op: 'bots' });
    rooms.value = await call({ op: 'rooms' });
    await read(rooms.value.find((r) => r.id === (preferred ?? room.value?.id)) ?? rooms.value[0]);
  }
  onMounted(
    () =>
      void guard(async () => {
        await call({ op: 'init' });
        await refresh();
      }),
  );
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
        bots.value = await call({ op: 'bots' });
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
    const signature = JSON.stringify([r.id, draft.value, recipient.value, attachments]);
    lastSend = lastSend?.signature === signature ? lastSend : { signature, id: uuid() };
    pending.value = lastSend.id;
    try {
      const result = await call({
        op: 'send',
        room: r.id,
        text: draft.value,
        attachments,
        to: r.kind === 'group' ? recipient.value || null : null,
        requestId: pending.value,
      });
      feedback.value =
        result.status === 'uncertain'
          ? 'Исход неизвестен (uncertain). Проверьте состояние хода в Ocean CLI.'
          : 'Ответ runtime · ' + result.status;
      draft.value = '';
      sent.value++;
      lastSend = undefined;
      recipient.value = '';
    } catch (error) {
      feedback.value = explain(error);
    } finally {
      pending.value = '';
      await read(r);
    }
  }
  async function stop() {
    const id = pending.value;
    try {
      await cancel(id);
      if (pending.value === id) feedback.value = 'Отмена запрошена. Ожидание runtime…';
    } catch (error) {
      if (pending.value === id) feedback.value = explain(error);
    }
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
    pending,
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
