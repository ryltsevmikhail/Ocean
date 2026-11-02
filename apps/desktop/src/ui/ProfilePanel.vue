<script setup lang="ts">
import { ref } from 'vue';
import Glyph from './Glyph.vue';
import type { ProfileReport } from '../protocol.js';
import { call } from './bridge.js';
import { explain } from './dom.js';
defineProps<{ busy: boolean }>();
const emit = defineEmits<{ bot: [] }>();
const panel = ref<HTMLDialogElement>(),
  pending = ref(false),
  error = ref('');
const report = ref<ProfileReport>();
async function check() {
  if (pending.value) return;
  pending.value = true;
  error.value = '';
  report.value = undefined;
  try {
    report.value = await call({ op: 'doctor' });
  } catch (e) {
    error.value = explain(e);
  } finally {
    pending.value = false;
  }
}
function open() {
  panel.value?.showModal();
  void check();
}
defineExpose({ open });
</script>
<template>
  <button aria-label="Локальный профиль" @click="open" :disabled="busy">
    <Glyph name="profile" /> Локальный профиль
  </button>
  <Teleport to="body"
    ><dialog ref="panel" class="profile-panel" aria-label="Локальный профиль">
      <header>
        <small>ЛОКАЛЬНЫЙ ПРОФИЛЬ</small
        ><button class="round" aria-label="Закрыть профиль" @click="panel?.close()">
          <Glyph name="close" />
        </button>
      </header>
      <h2>Профиль и данные</h2>
      <p>Комнаты, участники и переписка хранятся на этом устройстве.</p>
      <section class="info-card" role="status">
        <strong>{{
          pending
            ? 'Проверяем профиль…'
            : error
              ? 'Проверка недоступна'
              : report?.restored
                ? 'Профиль восстановлен'
                : 'Проверка завершена'
        }}</strong>
        <p v-if="report">
          Ключ DeepSeek
          {{ report.providerKeyPresent ? 'найден в окружении' : 'не найден в окружении' }}.
        </p>
        <p v-if="report?.restorationState === 'incomplete'">
          Восстановление из копии не завершено.
        </p>
        <p v-else-if="report?.restored">Для нового внешнего хода требуется подтверждение в CLI.</p>
        <p v-if="error">{{ error }}</p>
      </section>
      <dl v-if="report" class="runtime-facts">
        <dt>Версия CLI</dt>
        <dd>{{ report.cli }}</dd>
        <dt>Node</dt>
        <dd>{{ report.node }}</dd>
        <dt>Права профиля</dt>
        <dd>{{ report.permissions ? 'Приватные' : 'Требуют проверки' }}</dd>
        <dt>База SQLite</dt>
        <dd>{{ report.database.status }}</dd>
      </dl>
      <div class="form-actions">
        <button :disabled="pending || busy" @click="check">Проверить состояние</button
        ><button
          class="primary"
          :disabled="pending || busy"
          @click="
            panel?.close();
            emit('bot');
          "
        >
          Профили ботов
        </button>
      </div>
    </dialog></Teleport
  >
</template>
