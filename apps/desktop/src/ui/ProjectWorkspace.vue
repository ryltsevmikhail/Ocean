<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import { projectWorkspace, type ProjectBinding, type ProjectReplies } from '../project-protocol.js';
import { projectRequest, projectSupport, type ProjectRequest } from './project-bridge.js';
import { projectMemory, selectionMemory } from './project-memory.js';
import { projectError, projectStatus } from './project-state.js';
import ProjectReserve from './ProjectReserve.vue';
import ProjectWork from './ProjectWork.vue';

const workspaceId = projectWorkspace;
const binding = shallowRef<ProjectBinding | null>(null);
const request = shallowRef<ProjectRequest | null>(null);
const projects = shallowRef<ProjectReplies['projects']['projects']>([]);
const tasks = shallowRef<ProjectReplies['tasks']['tasks']>([]);
const projectId = ref(''),
  taskId = ref(''),
  error = ref(''),
  loading = ref(false),
  unsupported = ref(false);
const nextProject = ref<string | null>(null),
  nextTask = ref<string | null>(null);
const project = computed(() => projects.value.find((item) => item.id === projectId.value));
const task = computed(() => tasks.value.find((item) => item.id === taskId.value));
function selection(profileId: string) {
  return projectMemory(localStorage, JSON.stringify([profileId, 'selection']), selectionMemory);
}
function saveSelection() {
  if (binding.value)
    selection(binding.value.profileId).write({ projectId: projectId.value, taskId: taskId.value });
}
async function perform(action: () => Promise<void>) {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    await action();
  } catch (e) {
    error.value = projectError(e);
  } finally {
    loading.value = false;
  }
}
async function projectPage(after?: string) {
  const page = await request.value!('projects', { workspaceId, ...(after ? { after } : {}) });
  projects.value = after ? [...projects.value, ...page.projects] : page.projects;
  nextProject.value = page.nextAfter;
}
async function taskPage(after?: string) {
  const page = await request.value!('tasks', {
    workspaceId,
    projectId: projectId.value,
    ...(after ? { after } : {}),
  });
  tasks.value = after ? [...tasks.value, ...page.tasks] : page.tasks;
  nextTask.value = page.nextAfter;
}
async function loadTasks(preferred = '') {
  await taskPage();
  while (preferred && nextTask.value && !tasks.value.some((item) => item.id === preferred))
    await taskPage(nextTask.value);
  taskId.value =
    (tasks.value.some((item) => item.id === preferred) ? preferred : tasks.value[0]?.id) ?? '';
  saveSelection();
}
const connect = () =>
  perform(async () => {
    request.value = null;
    binding.value = null;
    unsupported.value = false;
    projects.value = [];
    tasks.value = [];
    projectId.value = '';
    taskId.value = '';
    const support = await projectSupport();
    if (!support.supported) {
      unsupported.value = true;
      return;
    }
    binding.value = { profileId: support.profileId, instanceId: support.instanceId };
    request.value = projectRequest(binding.value);
    const previous = selection(support.profileId).read();
    await projectPage();
    while (
      previous?.projectId &&
      nextProject.value &&
      !projects.value.some((item) => item.id === previous.projectId)
    )
      await projectPage(nextProject.value);
    projectId.value =
      (projects.value.some((item) => item.id === previous?.projectId)
        ? previous?.projectId
        : projects.value[0]?.id) ?? '';
    if (projectId.value)
      await loadTasks(previous?.projectId === projectId.value ? previous.taskId : '');
  });
const chooseProject = () =>
  perform(async () => {
    taskId.value = '';
    tasks.value = [];
    nextTask.value = null;
    await loadTasks();
  });
const chooseTask = () =>
  perform(async () => {
    saveSelection();
  });
const refreshTasks = (preferred = taskId.value) => perform(() => loadTasks(preferred));
const moreProjects = () => perform(() => projectPage(nextProject.value ?? undefined));
const moreTasks = () => perform(() => taskPage(nextTask.value ?? undefined));
onMounted(connect);
</script>
<template>
  <div class="shell project-shell">
    <aside class="rail project-rail" aria-label="Навигация по проектам">
      <div class="brand">
        <img src="/marks/ocean.svg" alt="" width="30" height="30" />
        <span>Ocean · Проекты</span>
      </div>
      <button type="button" :disabled="loading" @click="connect">Подключиться заново</button>
      <nav v-if="request && projects.length">
        <label
          >Проект
          <select v-model="projectId" :disabled="loading" @change="chooseProject">
            <option v-for="item in projects" :key="item.id" :value="item.id">{{ item.id }}</option>
          </select>
        </label>
        <button v-if="nextProject" type="button" :disabled="loading" @click="moreProjects">
          Ещё проекты
        </button>
        <label v-if="tasks.length"
          >Задача
          <select v-model="taskId" :disabled="loading" @change="chooseTask">
            <option v-for="item in tasks" :key="item.id" :value="item.id">
              {{ item.id }} · {{ projectStatus(item.status) }}
            </option>
          </select>
        </label>
        <button v-if="nextTask" type="button" :disabled="loading" @click="moreTasks">
          Ещё задачи
        </button>
      </nav>
    </aside>
    <main class="project-main">
      <header>
        <p class="project-eyebrow">Рабочая область</p>
        <h1>{{ project?.id ?? 'Проекты' }}</h1>
        <p v-if="project" class="muted project-hash">{{ project.root }}</p>
      </header>
      <p v-if="loading" role="status">Чтение состояния Ocean…</p>
      <p v-if="unsupported" role="alert">
        {{ projectError(Error('project_runtime_upgrade_required')) }}
      </p>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="request && !loading && !error && !projects.length" class="project-panel">
        Нет зарегистрированных проектов. Добавьте проект через CLI владельца Ocean и подключитесь
        заново.
      </p>
      <template v-if="request && binding && project">
        <ProjectReserve
          :key="JSON.stringify([binding.instanceId, project.id])"
          :request="request"
          :project-id="project.id"
          :profile-id="binding.profileId"
          @reserved="refreshTasks"
        />
        <ProjectWork
          v-if="task"
          :key="JSON.stringify([binding.instanceId, project.id, task.id, task.ownerRoomId])"
          :request="request"
          :project-id="project.id"
          :profile-id="binding.profileId"
          :task-id="task.id"
          :room-id="task.ownerRoomId"
        />
        <p v-else-if="!loading" class="project-panel">Выберите или зарезервируйте задачу.</p>
      </template>
    </main>
  </div>
</template>
