<script setup lang="ts">
import { onMounted, ref, shallowRef, watch } from 'vue';
import {
  projectWorkspace,
  type OperationKey,
  type OperationStatus,
  type ProjectReplies,
} from '../project-protocol.js';
import type { ProjectRequest } from './project-bridge.js';
import { projectMemory, reserveMemory } from './project-memory.js';
import { projectAdmission, projectError } from './project-state.js';
import ProjectOperation from './ProjectOperation.vue';

const props = defineProps<{ request: ProjectRequest; projectId: string; profileId: string }>();
const emit = defineEmits<{ reserved: [taskId: string] }>();
const workspaceId = projectWorkspace;
const memory = projectMemory(
  localStorage,
  JSON.stringify([props.profileId, props.projectId, 'reserve']),
  reserveMemory.nullable(),
);
const saved = shallowRef<OperationKey | null>(memory.read() ?? null);
const status = shallowRef<OperationStatus | undefined>();
const rooms = shallowRef<ProjectReplies['rooms']>([]);
const devMembers = shallowRef<ProjectReplies['members']>([]);
const reviewMembers = shallowRef<ProjectReplies['members']>([]);
const taskId = ref(''),
  devRoom = ref(''),
  reviewRoom = ref(''),
  devBot = ref(''),
  reviewBot = ref('');
const open = ref(Boolean(saved.value)),
  busy = ref(false),
  error = ref('');
async function refresh() {
  const key = saved.value;
  if (!key || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    status.value = await props.request('operation-status', key);
    if (
      status.value.operation === 'reserve' &&
      status.value.result.status === 'reserved' &&
      status.value.result.task
    ) {
      memory.write(null);
      saved.value = null;
      open.value = false;
      emit('reserved', status.value.result.task.id);
    }
  } catch (e) {
    status.value = undefined;
    error.value = projectError(e);
  } finally {
    busy.value = false;
  }
}
async function openForm() {
  open.value = true;
  if (rooms.value.length || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = [];
    let after: string | undefined;
    for (;;) {
      const page: ProjectReplies['rooms'] = await props.request('rooms', {
        workspaceId,
        limit: 50,
        ...(after ? { after } : {}),
      });
      result.push(...page);
      if (page.length < 50) break;
      const next = page.at(-1)?.id;
      if (!next || next === after) throw Error('invalid_frame');
      after = next;
    }
    rooms.value = result;
  } catch (e) {
    error.value = projectError(e);
  } finally {
    busy.value = false;
  }
}
function loadMembers(room: typeof devRoom, members: typeof devMembers, bot: typeof devBot) {
  watch(room, async (roomId, _previous, cleanup) => {
    let current = true;
    cleanup(() => {
      current = false;
    });
    members.value = [];
    bot.value = '';
    if (!roomId) return;
    try {
      const result = await props.request('members', { workspaceId, roomId, limit: 200 });
      if (current) members.value = result;
    } catch (e) {
      if (current) error.value = projectError(e);
    }
  });
}
loadMembers(devRoom, devMembers, devBot);
loadMembers(reviewRoom, reviewMembers, reviewBot);
async function reserve() {
  if (busy.value || saved.value) return;
  busy.value = true;
  error.value = '';
  const requestId = crypto.randomUUID();
  const input = {
    workspaceId,
    projectId: props.projectId,
    taskId: taskId.value.trim(),
    requestId,
    ownerRoomId: devRoom.value,
    devBotId: devBot.value,
    reviewRoomId: reviewRoom.value,
    reviewBotId: reviewBot.value,
  };
  try {
    const key: OperationKey = {
      workspaceId,
      roomId: input.ownerRoomId,
      taskId: input.taskId,
      requestId,
      operation: 'reserve',
    };
    memory.write(key);
    saved.value = key;
    const result = await projectAdmission(
      () => props.request('reserve', input),
      () => {
        memory.write(null);
        saved.value = null;
      },
    );
    status.value = { operation: 'reserve', result };
  } catch (e) {
    error.value = projectError(e);
  } finally {
    busy.value = false;
  }
}
function dismiss() {
  try {
    memory.write(null);
    saved.value = null;
    status.value = undefined;
    void openForm();
  } catch (e) {
    error.value = projectError(e);
  }
}
onMounted(refresh);
</script>
<template>
  <section v-if="open" class="project-panel" aria-labelledby="reserve-title">
    <h2 id="reserve-title">Резерв задачи</h2>
    <template v-if="saved">
      <ProjectOperation
        :request="request"
        :handle="saved"
        :status="status"
        :disabled="busy"
        @decided="refresh"
      />
      <button type="button" :disabled="busy" @click="refresh">Обновить результат</button>
      <button
        v-if="
          status?.operation === 'reserve' &&
          ['denied', 'expired', 'cancelled', 'invalidated', 'interrupted'].includes(
            status.result.status,
          )
        "
        type="button"
        :disabled="busy"
        @click="dismiss"
      >
        Новый резерв
      </button>
    </template>
    <form v-else class="project-form" @submit.prevent="reserve">
      <label>Идентификатор задачи <input v-model="taskId" required maxlength="128" /></label>
      <label
        >Комната разработки
        <select v-model="devRoom" required>
          <option value="">Выберите комнату</option>
          <option v-for="room in rooms" :key="room.id" :value="room.id">
            {{ room.title ?? room.id }}
          </option>
        </select>
      </label>
      <label
        >Бот разработки
        <select v-model="devBot" required>
          <option value="">Выберите бота</option>
          <option v-for="bot in devMembers" :key="bot.id" :value="bot.id">
            {{ bot.name }} · {{ bot.handle }}
          </option>
        </select>
      </label>
      <label
        >Комната ревью
        <select v-model="reviewRoom" required>
          <option value="">Выберите комнату</option>
          <option v-for="room in rooms" :key="room.id" :value="room.id">
            {{ room.title ?? room.id }}
          </option>
        </select>
      </label>
      <label
        >Бот ревью
        <select v-model="reviewBot" required>
          <option value="">Выберите бота</option>
          <option
            v-for="bot in reviewMembers"
            :key="bot.id"
            :value="bot.id"
            :disabled="bot.id === devBot"
          >
            {{ bot.name }} · {{ bot.handle }}
          </option>
        </select>
      </label>
      <div class="project-row">
        <button
          type="submit"
          class="project-primary"
          :disabled="busy || !taskId.trim() || !devBot || !reviewBot || devBot === reviewBot"
        >
          Запросить резерв
        </button>
        <button type="button" :disabled="busy" @click="open = false">Закрыть</button>
      </div>
      <p v-if="!rooms.length && !busy">
        Создайте комнаты и добавьте ботов через существующий интерфейс Ocean.
      </p>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
  <button v-else type="button" @click="openForm">Зарезервировать задачу</button>
</template>
