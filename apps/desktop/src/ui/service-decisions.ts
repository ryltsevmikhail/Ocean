import { computed, ref } from 'vue';
import type { LocalDecision, LocalDecisionRef } from '@runnets/contracts';
import { call } from './bridge.js';
export const decisionStatusText: Record<LocalDecision['status'], string> = {
  pending: 'Ожидает решения',
  allowed: 'Разрешено один раз',
  denied: 'Отказано',
  cancelled: 'Отменено',
  expired: 'Срок истёк',
  invalidated: 'Утратило силу',
  interrupted: 'Прервано',
};
const reference = (c: LocalDecision): LocalDecisionRef => ({
  workspaceId: c.workspaceId,
  roomId: c.roomId,
  runId: c.runId,
  decisionId: c.decisionId,
});
const same = (a: LocalDecision, b: LocalDecision) =>
  JSON.stringify(reference(a)) === JSON.stringify(reference(b)) &&
  a.version === b.version &&
  a.bindingDigest === b.bindingDigest &&
  a.previewLength === b.previewLength &&
  a.status === b.status;
export function createServiceDecisions(request: typeof call = call) {
  const cards = ref<readonly LocalDecision[]>([]),
    current = ref<LocalDecision | null>(null),
    preview = ref(''),
    message = ref(''),
    busy = ref(false),
    room = ref(''),
    verified = ref(false);
  const now = ref(Date.now());
  const tick = () => {
    now.value = Date.now();
  };
  const cursor = ref<string | null>(null),
    exhausted = ref(false),
    reading = ref(false);
  let epoch = 0,
    listVersion = 0;
  function close() {
    ++epoch;
    ++listVersion;
    reading.value = false;
    current.value = null;
    preview.value = '';
    verified.value = false;
    message.value = '';
  }
  function context(id: string) {
    close();
    room.value = id;
    cards.value = [];
    cursor.value = null;
    exhausted.value = false;
  }
  const canResolve = computed(
    () =>
      !busy.value &&
      verified.value &&
      current.value?.status === 'pending' &&
      current.value.roomId === room.value &&
      current.value.expiresAt > now.value,
  );
  const load = () => read(true);
  const loadMore = () => read(false);
  async function read(reset: boolean) {
    const token = epoch,
      owningRoom = room.value,
      version = ++listVersion;
    if (!owningRoom || (!reset && exhausted.value)) return;
    reading.value = true;
    try {
      const rows: LocalDecision[] = reset ? [] : [...cards.value];
      let after = reset ? undefined : (cursor.value ?? undefined),
        ended = false;
      for (let page = 0; page < 20; ++page) {
        if (token !== epoch || version !== listVersion) return;
        const items = await request({
          op: 'service-decisions',
          input: {
            workspaceId: 'ws_ocean',
            roomId: owningRoom,
            limit: 50,
            ...(after ? { after } : {}),
          },
        });
        rows.push(...items.filter((x) => x.kind === 'service-call'));
        if (items.length < 50) {
          ended = true;
          break;
        }
        const next = items.at(-1)!.decisionId;
        if (next === after) throw Error('invalid_frame');
        after = next;
      }
      if (token !== epoch || version !== listVersion) return;
      cursor.value = ended ? null : (after ?? null);
      exhausted.value = ended;
      cards.value = rows;
      const updated = rows.find((c) => c.decisionId === current.value?.decisionId);
      if (current.value && (!updated || !same(current.value, updated))) {
        verified.value = false;
        current.value = updated ?? null;
        preview.value = '';
      }
    } catch (e) {
      if (token === epoch && version === listVersion)
        message.value = String(e instanceof Error ? e.message : e);
    } finally {
      if (version === listVersion) reading.value = false;
    }
  }
  async function inspect(card: LocalDecision) {
    close();
    const token = epoch;
    busy.value = true;
    try {
      if (card.roomId !== room.value) throw Error('decision_context_changed');
      const before = await request({ op: 'service-decision', input: reference(card) });
      const text = await request({ op: 'service-preview', input: reference(before) });
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const digest = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      const after = await request({ op: 'service-decision', input: reference(before) });
      if (
        !same(before, after) ||
        text.length !== after.previewLength ||
        digest !== after.bindingDigest ||
        after.kind !== 'service-call'
      )
        throw Error('invalid_frame');
      if (token !== epoch) return;
      current.value = after;
      preview.value = text;
      verified.value = true;
    } catch (e) {
      if (token === epoch) message.value = String(e instanceof Error ? e.message : e);
    } finally {
      busy.value = false;
    }
  }
  async function resolve(choice: 'allow-once' | 'deny') {
    if (!canResolve.value || !current.value) return;
    const c = current.value,
      token = epoch;
    verified.value = false;
    busy.value = true;
    try {
      const result = await request({
        op: 'service-resolve',
        input: {
          ...reference(c),
          choice,
          expectedVersion: c.version,
          bindingDigest: c.bindingDigest,
        },
      });
      if (token !== epoch) return;
      current.value = result;
      message.value = `Решение: ${decisionStatusText[result.status]}. Разрешение не доказывает завершение эффекта.`;
    } catch (e) {
      if (token === epoch) message.value = String(e instanceof Error ? e.message : e);
    } finally {
      busy.value = false;
      if (token === epoch) await load();
    }
  }
  return {
    cards,
    current,
    preview,
    message,
    busy,
    canResolve,
    tick,
    context,
    close,
    load,
    loadMore,
    cursor,
    exhausted,
    reading,
    inspect,
    resolve,
  };
}
