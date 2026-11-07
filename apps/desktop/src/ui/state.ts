import { createRoomTasks } from './room-task-state.js';
import { ref, computed, onMounted } from 'vue';
import type { Bot, Room, Command, Run } from '../protocol.js';
import { pages, useRoomFeed } from './room-feed.js';
import { call, SendFailure, submitDraft } from './bridge.js';
import { explain } from './dom.js';
import { feedbackText } from './runtime-text.js';
import { refreshModelSettings } from './model-support.js';
import type { LocalBotModelBinding } from '../model-protocol.js';
import { unavailableFeedback } from './provider-feedback.js';
import {
  abandonBroadcast,
  broadcastBatch,
  broadcastBlocksSending,
  broadcastBusy,
  continueBroadcast,
  pendingBroadcast,
  readBroadcast,
  sendOwnedBroadcast,
} from './broadcast-state.js';
import { createOceanTeam } from './ocean-team.js';
import { BROADCAST_RECIPIENT } from './broadcast-mode.js';
import { sendBlockedHint } from './broadcast-text.js';
export function useDesktop() {
  const tasks = createRoomTasks();
  const bots = ref<Bot[]>([]),
    rooms = ref<Room[]>([]);
  const sent = ref(0),
    receipt = ref(''),
    receiptAccepted = ref(false),
    admittedRun = ref<string | null>(null),
    uncertain = ref(false);
  const unconfirmed = new Map<string, Extract<Command, { op: 'send' }>>();
  const previews = ref<Record<string, string>>({});
  const { history, runs, readError, active, open } = useRoomFeed(
    (id, latest) => {
      previews.value[id] =
        (latest.author === 'bot' ? label(latest.authorBotId) : 'Вы') +
        ' · ' +
        latest.body.slice(0, 120);
    },
    async (id) => readBroadcast(id),
    tasks.watermark,
  );
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
    bots.value.find((b) => b.id === id)?.handle ?? id ?? 'участник';
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
      feedback.value =
        unavailableFeedback(feedbackCode.value, room.value, recipient.value, bots.value) ??
        explain(error);
      feedbackError.value = true;
    } finally {
      busy.value = false;
    }
  }
  function read(r: Room | undefined) {
    if (r?.id !== room.value?.id) {
      if (room.value) drafts.set(room.value.id, draft.value);
      draft.value = r ? (drafts.get(r.id) ?? '') : '';
      const original = r && unconfirmed.get(r.id);
      const originalBroadcast = r ? pendingBroadcast(r.id) : undefined;
      recipient.value = original?.to ?? (originalBroadcast ? BROADCAST_RECIPIENT : '');
      receiptAccepted.value = false;
      receipt.value = original
        ? 'Квитанция не подтверждена · ' + original.requestId
        : originalBroadcast
          ? 'Квитанция рассылки не подтверждена · ' + originalBroadcast.requestId
          : '';
      admittedRun.value = null;
    }
    room.value = r;
    void tasks.context(r?.id ?? '');
    uncertain.value = r ? unconfirmed.has(r.id) || pendingBroadcast(r.id) !== undefined : false;
    if (r) void readBroadcast(r.id);
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
      await refreshModelSettings();
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
  const team = (choices?: Readonly<Record<string, LocalBotModelBinding>>) =>
    createOceanTeam(
      {
        readBots: loadBots,
        setBots: (next) => {
          bots.value = next;
        },
        currentBots: () => bots.value,
        refresh,
        requestId: uuid,
      },
      choices,
    );
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
      receiptAccepted.value = true;
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
        receiptAccepted.value = false;
        if (original) receipt.value = '';
      } else {
        unconfirmed.set(r.id, command);
        uncertain.value = true;
        receiptAccepted.value = false;
        receipt.value = 'Квитанция не подтверждена · ' + command.requestId;
      }
      throw error;
    }
  }
  async function broadcastTurn(attachments: string[]) {
    const r = room.value;
    if (!r) return;
    const outcome = await sendOwnedBroadcast({
      room: r.id,
      text: draft.value,
      attachments,
    });
    if (outcome.kind === 'unconfirmed') {
      uncertain.value = true;
      receiptAccepted.value = false;
      receipt.value = 'Квитанция рассылки не подтверждена · ' + outcome.requestId;
      throw Error('outcome_unknown');
    }
    if (outcome.kind === 'refused') {
      receiptAccepted.value = false;
      if (outcome.retried) receipt.value = '';
      uncertain.value = false;
      throw Error(outcome.code);
    }
    receiptAccepted.value = true;
    receipt.value =
      'Всем · ' + outcome.batch.recipients.length + ' участников · ' + outcome.batch.messageId;
    uncertain.value = false;
    draft.value = '';
    sent.value++;
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
    tasks,
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
    receiptAccepted,
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
    broadcastBatch,
    broadcastBusy,
    broadcastBlocksSending,
    broadcastBlockedHint: computed(() => sendBlockedHint(broadcastBatch.value, recipient.value)),
    continueBroadcast,
    abandonBroadcast,
    sendBroadcast: async (attachments: string[]) => {
      sending.value = true;
      try {
        await broadcastTurn(attachments);
      } finally {
        sending.value = false;
      }
    },
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
