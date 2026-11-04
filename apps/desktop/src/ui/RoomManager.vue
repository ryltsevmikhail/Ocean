<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Bot } from '../protocol.js';
import { call } from './bridge.js';
import { explain } from './dom.js';
import { submitCreation } from './room-create.js';
import {
  loadProviderStatus,
  providerDefaultModel,
  providerModels,
  providerStatus,
} from './provider-state.js';
import { providerCapabilitySuffix } from './provider-text.js';

const props = defineProps<{ bots: Bot[]; busy: boolean }>();
const emit = defineEmits<{ created: [roomId?: string] }>();
const manager = ref<HTMLDialogElement>();
const dialog = ref<'' | 'room' | 'bot'>('');
const selected = ref<string[]>([]);
const title = ref('Ocean Team');
const kind = ref<'group' | 'direct'>('group');
const handle = ref('');
const name = ref('');
const role = ref('');
const model = ref('');
const pending = ref(false);
const feedback = ref('');
const feedbackError = ref(false);
const invalidHandle = computed(
  () => !!handle.value && !/^[a-z][a-z0-9_-]{0,31}$/.test(handle.value),
);
watch(
  dialog,
  (value) => {
    if (value) manager.value?.showModal();
    else manager.value?.close();
  },
  { flush: 'post' },
);
function capabilities(id: string): string {
  const entry = providerStatus.value?.modelCapabilities.find((item) => item.model === id);
  return providerCapabilitySuffix(entry?.imageInput ?? false);
}
function open(value: 'room' | 'bot') {
  dialog.value = value;
  selected.value = [];
  feedback.value = '';
  feedbackError.value = false;
  if (value === 'bot') {
    void loadProviderStatus().then(() => {
      model.value = providerDefaultModel.value;
    });
  }
}
function close() {
  if (props.busy || pending.value) return;
  dialog.value = '';
}
async function create() {
  if (props.busy || pending.value) return;
  pending.value = true;
  feedback.value = '';
  feedbackError.value = false;
  try {
    const created = await submitCreation(
      {
        dialog: dialog.value === 'bot' ? 'bot' : 'room',
        kind: kind.value,
        selected: [...selected.value],
        title: title.value,
        handle: handle.value,
        name: name.value,
        role: role.value,
        model: model.value || providerDefaultModel.value,
      },
      call,
    );
    dialog.value = '';
    emit('created', created ?? undefined);
  } catch (error) {
    feedback.value = explain(error);
    feedbackError.value = true;
  } finally {
    pending.value = false;
  }
}
defineExpose({ open });
</script>
<template>
  <Teleport to="body">
    <dialog ref="manager" aria-label="Создание" @cancel.prevent="close">
      <form v-if="dialog" id="fields" @submit.prevent="create">
        <small>{{ dialog === 'bot' ? 'НОВЫЙ БОТ' : 'НОВАЯ КОМНАТА' }}</small>
        <h2>{{ dialog === 'bot' ? 'Добавить участника' : 'Кто в комнате' }}</h2>
        <p class="form-copy">
          {{
            dialog === 'bot'
              ? 'Бот получает переписку своей комнаты.'
              : 'В группе вы выбираете, кому передать ход.'
          }}
        </p>
        <template v-if="dialog === 'bot'"
          ><p>{{ props.bots.map((b) => '@' + b.handle).join(' · ') }}</p>
          <label
            >Идентификатор<input
              v-model="handle"
              :aria-invalid="invalidHandle"
              aria-describedby="handle-tip"
              required
              pattern="[a-z][a-z0-9_\-]{0,31}" /></label
          ><small id="handle-tip" :class="{ warning: invalidHandle }"
            >Начните с латинской буквы. Далее — строчные буквы, цифры, «-» или «_». Например,
            dev-team.</small
          ><label>Имя<input v-model="name" required /></label
          ><label>Роль<textarea v-model="role" required></textarea></label
          ><label
            >Модель<select v-model="model" required>
              <option v-for="item in providerModels" :key="item" :value="item">
                {{ item }}{{ capabilities(item) }}
              </option>
            </select></label
          ></template
        >
        <template v-else
          ><label
            >Тип<select v-model="kind" @change="selected = []">
              <option value="group">Группа</option>
              <option value="direct">Личная</option>
            </select></label
          ><label v-if="kind === 'group'">Название<input v-model="title" required /></label>
          <fieldset>
            <legend>Участники</legend>
            <label v-for="b in props.bots" :key="b.id"
              ><input
                v-if="kind === 'group'"
                v-model="selected"
                type="checkbox"
                :value="b.id"
              /><input v-else type="radio" name="direct" @change="selected = [b.id]" />@{{
                b.handle
              }}</label
            >
          </fieldset></template
        >
        <p v-if="pending || feedback" :role="feedbackError ? 'alert' : 'status'">
          {{ feedback || 'Запрос выполняется…' }}
        </p>
        <button type="button" :disabled="pending || props.busy" @click="close">Закрыть</button
        ><button
          class="primary"
          :disabled="
            pending ||
            props.busy ||
            (dialog === 'bot' && invalidHandle) ||
            (dialog === 'room' && selected.length < (kind === 'group' ? 2 : 1))
          "
        >
          Создать
        </button>
      </form>
    </dialog>
  </Teleport>
</template>
