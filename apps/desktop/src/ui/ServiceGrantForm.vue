<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Bot, Room } from '../protocol.js';
import type { ServiceSettings } from './service-settings-state.js';
const props = defineProps<{
  state: ServiceSettings;
  room?: Room | undefined;
  bots: readonly Bot[];
}>();
const { current, busy, stale, grants, botId } = props.state;
const tools = ref<string[]>([]),
  policy = ref<'exact' | 'current-set' | 'all-including-future'>('exact'),
  mode = ref<'autonomous' | 'confirm'>('autonomous'),
  acknowledge = ref(false),
  maxCalls = ref(1000),
  maxEffectBytes = ref(1048576),
  expiresAt = ref('');
watch([() => current.value?.id, () => props.room?.id], () => {
  tools.value = [];
  acknowledge.value = false;
});
async function grant() {
  const c = current.value;
  if (!c || !props.room || !acknowledge.value) return;
  await props.state.mutate({
    op: 'service-grant',
    input: {
      requestId: crypto.randomUUID(),
      expectedRevision: null,
      intent: {
        id: crypto.randomUUID(),
        subject: {
          workspaceId: 'ws_ocean',
          roomId: props.room.id,
          botId: botId.value,
          projectId: null,
          taskId: null,
        },
        permissions: [
          {
            kind: 'service',
            connectionId: c.id,
            trustRevision: c.trustRevision,
            tools:
              policy.value === 'all-including-future'
                ? { kind: 'all-including-future', explicitlySelected: true }
                : {
                    kind: policy.value,
                    names: policy.value === 'current-set' ? [...c.tools] : [...tools.value],
                  },
            resources: [{ kind: 'connection', connectionId: c.id }],
          },
        ],
        mode: mode.value,
        limits: {
          maxCalls: maxCalls.value,
          maxEffectBytes: maxEffectBytes.value,
          expiresAt: expiresAt.value || null,
        },
      },
    },
  });
}
function revoke(id: string, revision: number) {
  return props.state.mutate({
    op: 'service-revoke',
    input: { requestId: crypto.randomUUID(), grantId: id, expectedRevision: revision },
  });
}
</script>
<template>
  <h2>Новая область владельца</h2>
  <p v-if="!room">Выберите комнату.</p>
  <fieldset v-else :disabled="busy || stale || !current">
    <legend>{{ room.id }} · {{ room.kind }}</legend>
    <label
      >Бот<select data-testid="service-bot" v-model="botId">
        <option value="">Выберите бота</option>
        <option v-for="b in bots" :key="b.id" :value="b.id">{{ b.handle }}</option>
      </select></label
    >
    <label
      >Инструменты<select data-testid="service-tool-policy" v-model="policy">
        <option value="exact">Точный выбор</option>
        <option value="current-set">Все текущие</option>
        <option value="all-including-future">Все, включая будущие — явный выбор</option>
      </select></label
    >
    <label v-for="tool in current?.tools ?? []" :key="tool"
      ><input
        data-testid="service-tool"
        type="checkbox"
        v-model="tools"
        :value="tool"
        :disabled="policy !== 'exact'"
      />{{ tool }}</label
    >
    <label
      >Режим<select data-testid="service-mode" v-model="mode">
        <option value="autonomous">Автономный</option>
        <option value="confirm">Подтверждать каждый вызов</option>
      </select></label
    >
    <label>maxCalls<input type="number" v-model.number="maxCalls" min="1" /></label
    ><label>maxEffectBytes<input type="number" v-model.number="maxEffectBytes" min="1" /></label
    ><label>expiresAt (ISO или пусто = null)<input v-model="expiresAt" /></label>
    <p data-testid="service-breadth">
      Область: ВСЕ ресурсы подключения {{ current?.id }}. Это шире отдельного аккаунта или
      репозитория. Текст аккаунта/репозитория не является проверенным ограничением. Это НОВОЕ право,
      а не перенос старых разрешений.
    </p>
    <p>
      Ответы видны участникам комнаты{{
        room.kind === 'group' ? ' — всем участникам группового чата' : ''
      }}.
    </p>
    <label
      ><input data-testid="service-grant-ack" type="checkbox" v-model="acknowledge" />Подтверждаю
      область всех ресурсов и видимость</label
    >
    <button data-testid="service-grant" :disabled="!acknowledge || !botId" @click="grant">
      Выдать новое право
    </button>
  </fieldset>
  <section
    v-for="g in grants.filter((g) => g.subject.roomId === room?.id)"
    :key="g.id"
    class="info-card"
    data-testid="service-grant-record"
  >
    <p>{{ g.id }} · {{ g.subject.botId }} · {{ g.mode }} · {{ g.state }} · rev {{ g.revision }}</p>
    <pre>{{ JSON.stringify(g.permissions, null, 2) }}</pre>
    <button
      data-testid="service-revoke"
      :disabled="busy || stale || g.state !== 'active'"
      @click="revoke(g.id, g.revision)"
    >
      Отозвать текущую ревизию
    </button>
  </section>
</template>
<style scoped>
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
