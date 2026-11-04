<script setup lang="ts">
import {
  broadcastBatch as batch,
  broadcastBusy,
  broadcastCode,
  broadcastError,
  broadcastIsPaused,
  broadcastMessage,
  abandonBroadcast,
  continueBroadcast,
} from './broadcast-state.js';
import { broadcastChildText, broadcastSummary } from './broadcast-text.js';
defineProps<{ busy: boolean }>();
</script>
<template>
  <section v-if="batch" class="broadcast-panel" :data-state="batch.state" aria-label="Рассылка">
    <header>
      <small>РАССЫЛКА · ВСЕМ</small
      ><span class="broadcast-revision" :title="batch.messageId">ревизия {{ batch.revision }}</span>
    </header>
    <p role="status">{{ broadcastSummary(batch) }}</p>
    <ul>
      <li
        v-for="child in batch.recipients"
        :key="child.turnId"
        :data-state="child.state"
        :title="child.runId"
      >
        <span class="broadcast-handle">{{ '@' + child.handle }}</span>
        <span
          >{{ broadcastChildText[child.state]
          }}<template v-if="child.refusalCode"> · {{ child.refusalCode }}</template></span
        >
      </li>
    </ul>
    <p v-if="batch.state === 'paused'" class="broadcast-warning">
      Рассылка ждёт решения владельца. «Продолжить» доступно, только когда у всех начатых участников
      известен итог; «Оставить» не отправляет оставшимся ход и не отменяет уже начатые ответы.
    </p>
    <p v-if="batch.state === 'abandoned' || batch.state === 'completed'" class="muted">
      {{
        batch.state === 'abandoned'
          ? 'Неотправленные участники не получат ход. Уже начатые ответы не изменены.'
          : 'Все участники ответили один раз. Дополнительных раундов нет.'
      }}
    </p>
    <p v-if="broadcastMessage" :role="broadcastError ? 'alert' : 'status'">
      {{ broadcastMessage }}
      <span v-if="broadcastCode && broadcastError" class="muted">· {{ broadcastCode }}</span>
    </p>
    <div v-if="broadcastIsPaused" class="form-actions">
      <button :disabled="busy || broadcastBusy" @click="continueBroadcast">Продолжить</button
      ><button :disabled="busy || broadcastBusy" @click="abandonBroadcast">Оставить</button>
    </div>
  </section>
</template>
