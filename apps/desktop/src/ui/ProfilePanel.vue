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
    report.value = await call({ op: 'status' });
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
          pending ? 'Проверяем профиль…' : error ? 'Проверка недоступна' : 'Проверка завершена'
        }}</strong>
        <p v-if="error">{{ error }}</p>
      </section>
      <dl v-if="report" class="runtime-facts">
        <dt>Протокол runtime</dt>
        <dd>{{ report.protocol }}</dd>
        <dt>Профиль</dt>
        <dd>{{ report.profileId }}</dd>
        <dt>Экземпляр runtime</dt>
        <dd>{{ report.instanceId }}</dd>
        <dt>Состояние</dt>
        <dd>{{ report.state }}</dd>
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
