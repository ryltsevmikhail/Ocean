<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ModelBindingPicker from './ModelBindingPicker.vue';
import { connectionSettings } from './model-connection-state.js';
import { readModelSupport } from './model-support.js';
import type { LocalBotModelBinding } from '../model-protocol.js';
import type { Bot } from '../protocol.js';
import { explain } from './dom.js';
import { teamPending } from './ocean-team.js';
import { createCreationState } from './creation-state.js';
import {
  loadProviderStatus,
  providerDefaultModel,
  providerModels,
  providerStatus,
} from './provider-state.js';
import { providerCapabilitySuffix } from './provider-text.js';

const props = defineProps<{ bots: Bot[]; busy: boolean }>();
const emit = defineEmits<{
  created: [roomId?: string];
  team: [choices: Record<string, LocalBotModelBinding>];
}>();
const manager = ref<HTMLDialogElement>();
const dialog = ref<'' | 'room' | 'bot' | 'team'>('');
const negotiated = ref<boolean | null>(null);
const binding = ref<LocalBotModelBinding>({ connectionId: '', modelId: '' });
const choices = ref<Record<string, LocalBotModelBinding>>({});
const missing = computed(() =>
  ['dev', 'review'].filter((handle) => !props.bots.some((bot) => bot.handle === handle)),
);
const { connections, stale } = connectionSettings;
const selected = ref<string[]>([]);
const title = ref('Ocean Team');
const kind = ref<'group' | 'direct'>('group');
const handle = ref('');
const name = ref('');
const role = ref('');
const model = ref('');
const creation = createCreationState();
const {
  busy: pending,
  pending: original,
  message: creationMessage,
  stale: creationStale,
} = creation;
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
function open(value: 'room' | 'bot' | 'team') {
  dialog.value = value;
  selected.value = [];
  feedback.value = '';
  feedbackError.value = false;
  negotiated.value = null;
  binding.value = { connectionId: '', modelId: '' };
  choices.value = Object.fromEntries(
    missing.value.map((handle) => [handle, { connectionId: '', modelId: '' }]),
  );
  if (value !== 'room')
    void (async () => {
      try {
        negotiated.value = await readModelSupport();
        if (negotiated.value) await connectionSettings.load();
        else {
          await loadProviderStatus();
          model.value = providerDefaultModel.value;
        }
      } catch (error) {
        feedback.value = explain(error);
        feedbackError.value = true;
      }
    })();
}
function close() {
  if (props.busy || pending.value) return;
  dialog.value = '';
}
async function create() {
  if (props.busy || pending.value || original.value) return;
  if (dialog.value === 'team') {
    if (
      negotiated.value !== true ||
      stale.value ||
      (!teamPending.value &&
        missing.value.some(
          (handle) => !choices.value[handle]?.connectionId || !choices.value[handle]?.modelId,
        ))
    )
      return;
    emit('team', choices.value);
    dialog.value = '';
    return;
  }
  if (
    dialog.value === 'bot' &&
    (negotiated.value === null ||
      (negotiated.value && (stale.value || !binding.value.connectionId || !binding.value.modelId)))
  )
    return;
  feedback.value = '';
  feedbackError.value = false;
  try {
    const created = await creation.submit({
      dialog: dialog.value === 'bot' ? 'bot' : 'room',
      kind: kind.value,
      selected: [...selected.value],
      title: title.value,
      handle: handle.value,
      name: name.value,
      role: role.value,
      model: model.value || providerDefaultModel.value,
      ...(negotiated.value ? { binding: { ...binding.value } } : {}),
    });
    if (created) {
      dialog.value = '';
      emit('created', created.roomId ?? undefined);
    }
  } catch (error) {
    feedback.value = explain(error);
    feedbackError.value = true;
  }
}
async function recover() {
  try {
    const result = await creation.recover();
    if (result) {
      dialog.value = '';
      emit('created', result.roomId ?? undefined);
    }
  } catch (error) {
    feedback.value = explain(error);
    feedbackError.value = true;
  }
}
defineExpose({ open });
</script>
<template>
  <Teleport to="body">
    <dialog ref="manager" aria-label="Создание" @cancel.prevent="close">
      <form v-if="dialog" id="fields" @submit.prevent="create">
        <small>{{
          dialog === 'bot' ? 'НОВЫЙ БОТ' : dialog === 'team' ? 'OCEAN TEAM' : 'НОВАЯ КОМНАТА'
        }}</small>
        <h2>
          {{
            dialog === 'bot'
              ? 'Добавить участника'
              : dialog === 'team'
                ? 'Модели новых участников'
                : 'Кто в комнате'
          }}
        </h2>
        <p class="form-copy">
          {{
            dialog === 'bot'
              ? 'Бот получает переписку своей комнаты.'
              : 'В группе вы выбираете, кому передать ход.'
          }}
        </p>
        <p v-if="negotiated && stale" role="status">
          Метаданные подключений не прочитаны. Обновите их в настройках провайдера перед созданием
          ботов.
        </p>
        <template v-if="dialog === 'team'">
          <section v-if="teamPending" class="info-card warning">
            <p>
              Исход неизвестен. Будет прочитано текущее состояние и отправлен точный исходный
              запрос.
            </p>
            <pre>{{ JSON.stringify(teamPending.command, null, 2) }}</pre>
          </section>
          <p>
            Для каждого нового участника явно выберите подключение и модель. Существующие боты
            сохраняют свои привязки.
          </p>
          <section v-for="item in missing" :key="item" class="info-card">
            <strong>@{{ item }}</strong
            ><ModelBindingPicker
              v-model="choices[item]!"
              :connections="connections"
              :disabled="stale || pending || !!teamPending"
            />
          </section>
        </template>
        <template v-else-if="dialog === 'bot'"
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
          ><ModelBindingPicker
            v-if="negotiated"
            v-model="binding"
            :connections="connections"
            :disabled="stale || pending || !!teamPending"
          /><label v-else
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
        <section v-if="original" class="info-card warning">
          <p role="status">{{ creationMessage }}</p>
          <pre>{{ JSON.stringify(original, null, 2) }}</pre>
          <button type="button" :disabled="pending || props.busy" @click="creation.refresh">
            Обновить метаданные</button
          ><button
            type="button"
            :disabled="pending || props.busy || creationStale"
            @click="recover"
          >
            Завершить точный исходный запрос
          </button>
        </section>
        <p v-if="pending || feedback" :role="feedbackError ? 'alert' : 'status'">
          {{ feedback || 'Запрос выполняется…' }}
        </p>
        <button type="button" :disabled="pending || props.busy" @click="close">Закрыть</button
        ><button
          class="primary"
          :disabled="
            pending ||
            !!original ||
            props.busy ||
            (dialog === 'bot' &&
              (invalidHandle ||
                negotiated === null ||
                (negotiated && (stale || !binding.connectionId || !binding.modelId)))) ||
            (dialog === 'team' &&
              (negotiated !== true ||
                stale ||
                (!teamPending &&
                  missing.some(
                    (item) => !choices[item]?.connectionId || !choices[item]?.modelId,
                  )))) ||
            (dialog === 'room' && selected.length < (kind === 'group' ? 2 : 1))
          "
        >
          {{ dialog === 'team' && teamPending ? 'Завершить исходный запрос' : 'Создать' }}
        </button>
      </form>
    </dialog>
  </Teleport>
</template>
