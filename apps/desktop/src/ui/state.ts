import { ref, computed, onMounted } from 'vue';
import type { Bot, Room, Command, Run } from '../protocol.js';
import { pages, useRoomFeed } from './room-feed.js';
import { call, SendFailure, submitDraft } from './bridge.js';
import { explain } from './dom.js';
import { feedbackText } from './runtime-text.js';
import {
  loadProviderStatus,
  providerModels,
  requireProviderDefaultModel,
} from './provider-state.js';
import { retiredModelHint } from './provider-text.js';

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
  const runtimeReady = ref(false),
    loading = ref(true),
    sending = ref(false),
    feedbackError = ref(false);
  const feedbackCode = ref('');
  const memberIds = computed(() =>
    room.value?.kind === 'group' ? room.value.botIds : [room.value?.botId],
  );
  const members = computed(() => bots.value.filter((b) => memberIds.value.includes(b.id)));
  const label = (id: string | undefined) =>
    bots.value.find((b) => b.id === id)?.handle ?? 'участник';
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
    feedbackError.value = false;
    feedbackCode.value = '';
    try {
      await action();
    } catch (error) {
      feedbackCode.value = error instanceof Error ? error.message : String(error);
      feedback.value = unavailableFeedback(feedbackCode.value) ?? explain(error);
      feedbackError.value = true;
    } finally {
      busy.value = false;
    }
  }
  /** A retired bot model is a different owner problem from a missing provider configuration. */
  function unavailableFeedback(code: string): string | null {
    if (code !== 'provider_unavailable' || !room.value) return null;
    const r = room.value;
    const candidates =
      r.kind === 'direct' ? [r.botId] : recipient.value !== '' ? [recipient.value] : r.botIds;
    for (const id of candidates) {
      const hint = retiredModelHint(
        bots.value.find((bot) => bot.id === id)?.model ?? null,
        providerModels.value,
      );
      if (hint !== null) return hint;
    }
    return null;
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
    try {
      bots.value = await loadBots();
      runtimeReady.value = true;
      await loadProviderStatus();
    } catch (error) {
      runtimeReady.value = false;
      throw error;
    } finally {
      loading.value = false;
    }
    rooms.value = await pages(
      (after: string | undefined) => call({ op: 'rooms', after }),
      (r) => r.id,
    );
    read(rooms.value.find((r) => r.id === (preferred ?? room.value?.id)) ?? rooms.value[0]);
  }
  onMounted(() => void guard(() => refresh()));
  const uuid = () => crypto.randomUUID();
  async function team() {
    const model = requireProviderDefaultModel();
    for (const h of ['dev', 'review']) {
      if (!bots.value.some((b) => b.handle === h)) {
        await call({
          op: 'bot',
          requestId: uuid(),
          handle: h,
          name: h,
          role: h === 'dev' ? 'Разработчик' : 'Ревьюер',
          model,
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
      const result = await submitDraft(command);
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
      await call({
        op: 'cancel',
        room: r.roomId,
        runId: r.runId,
        expectedVersion: r.version,
        requestId: uuid(),
      });
      feedback.value = 'Остановка запрошена. Ожидаем подтверждения.';
    });
  }
  const sections = computed(() =>
    [
      { title: 'Групповые комнаты', items: rooms.value.filter((r) => r.kind === 'group') },
      { title: 'Личные комнаты', items: rooms.value.filter((r) => r.kind === 'direct') },
    ].filter((s) => s.items.length),
  );
  const roomHandle = computed(() =>
    room.value?.kind === 'direct' ? label(room.value.botId) : undefined,
  );
  return {
    roomHandle,
    sections,
    runtimeReady,
    loading,
    sending,
    feedbackError,
    bots,
    roomPreview,
    rooms,
    room,
    history,
    runs,
    members,
    recipient,
    draft,
    feedback: computed({
      get: () => feedbackText(feedback.value, feedbackCode.value, !room.value),
      set: (value: string) => {
        feedback.value = value;
      },
    }),
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
    label,
    roomName,
    guard,
    read,
    refresh,
    team,
    send: async (attachments: string[]) => {
      sending.value = true;
      try {
        await send(attachments);
      } finally {
        sending.value = false;
      }
    },
    stop,
  };
}
