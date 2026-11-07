<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import type { ProjectRequest } from './project-bridge.js';
import { taskMemory } from './project-memory.js';
import { createProjectWork } from './project-work.js';
import { projectStatus } from './project-state.js';
import ProjectOperation from './ProjectOperation.vue';
import ProjectDecision from './ProjectDecision.vue';
const props = defineProps<{
  request: ProjectRequest;
  profileId: string;
  projectId: string;
  taskId: string;
  roomId: string;
}>();
const work = createProjectWork(
  props.request,
  taskMemory(localStorage, props.profileId, props.projectId, props.taskId),
  props.taskId,
  props.roomId,
);
const {
  local,
  task,
  receipt,
  run,
  diff,
  tests,
  history,
  operations,
  moreHistory,
  text,
  error,
  busy,
  active,
  unknownTurn,
  unknownRun,
  can,
  canPrepare,
  cancelRequested,
  review,
  recoveryReady,
  refresh,
  send,
  cancel,
  capture,
  begin,
  savedTurn,
  nextHistory,
} = work;
const timer = setInterval(work.observeCurrent, 2500);
onMounted(refresh);
onBeforeUnmount(() => {
  clearInterval(timer);
  work.close();
});
const testText = {
  missing: 'нет записи',
  different: 'не совпадает со снимком',
  passed: 'пройден',
  failed: 'не пройден',
};
const reviewTests = {
  none: 'нет данных',
  matches_snapshot: 'соответствуют снимку',
  different_snapshot: 'другой снимок',
  changed: 'изменились',
};
const verdicts = {
  approve: 'Одобрено',
  changes_requested: 'Запрошены изменения',
  insufficient_context: 'Недостаточно контекста',
};
</script>
<template>
  <div class="project-work">
    <section class="project-panel" aria-labelledby="task-heading">
      <div class="project-row">
        <h2 id="task-heading">{{ taskId }}</h2>
        <button type="button" :disabled="busy" @click="refresh">
          {{ busy ? 'Чтение…' : 'Обновить состояние задачи' }}
        </button>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="task">
        <p>
          {{ projectStatus(task.status) }} ·
          {{ task.worktreeReady ? 'Рабочая копия подготовлена' : 'Рабочая копия не подготовлена' }}
        </p>
        <dl class="project-assignments">
          <div>
            <dt>Разработка</dt>
            <dd>{{ task.ownerRoomId }} · {{ task.devBotId }}</dd>
          </div>
          <div>
            <dt>Ревью</dt>
            <dd>{{ task.reviewRoomId }} · {{ task.reviewBotId }}</dd>
          </div>
        </dl>
      </template>
      <button
        v-if="canPrepare"
        type="button"
        class="project-primary"
        :disabled="busy"
        @click="begin('prepare')"
      >
        Запросить подготовку
      </button>
      <ProjectOperation
        v-if="local.prepare"
        :request="request"
        :handle="local.prepare"
        :status="operations.prepare"
        :disabled="busy"
        @decided="refresh"
      />
    </section>
    <section class="project-panel" aria-labelledby="dev-heading">
      <h2 id="dev-heading">Разработка</h2>
      <div role="status" class="project-run-status">
        <p v-if="receipt">Квитанция приёма {{ receipt.requestId }}</p>
        <p v-if="unknownTurn">
          Приём сообщения не подтверждён. Обновите состояние или введите тот же текст для проверки
          тем же запросом.
        </p>
        <p v-if="unknownRun">Статус принятого запуска неизвестен. Обновите состояние.</p>
        <p v-if="run">Запуск: {{ projectStatus(run.turnStatus) }} · {{ run.runId }}</p>
        <p v-if="cancelRequested && active">
          Попытка отмены записана в окне. Проверяйте подтверждённый статус запуска.
        </p>
      </div>
      <button v-if="active" type="button" :disabled="busy || cancelRequested" @click="cancel">
        Запросить отмену
      </button>
      <template v-if="savedTurn()">
        <ProjectDecision
          v-for="id in run?.pendingDecisionIds ?? []"
          :key="id"
          title="Решение по запуску"
          :disabled="busy"
          :inspect="() => request('dev-card', { ...savedTurn()!, decisionId: id })"
          :resolve="(choice) => request('dev-vote', { ...savedTurn()!, decisionId: id, ...choice })"
          @decided="refresh"
        />
      </template>
      <h3>История комнаты разработки</h3>
      <div
        v-if="history.length"
        class="project-history"
        aria-label="История комнаты разработки"
        tabindex="0"
      >
        <article v-for="message in history" :key="message.id">
          <strong>{{
            message.author === 'user' ? 'Владелец' : (message.authorBotId ?? 'Бот')
          }}</strong>
          <p>{{ message.body }}</p>
        </article>
      </div>
      <p v-else class="muted">Пока нет сообщений в этой комнате.</p>
      <button v-if="moreHistory" type="button" :disabled="busy" @click="nextHistory">
        Ещё сообщения
      </button>
      <form class="project-form" @submit.prevent="send(false)">
        <label
          >Сообщение боту разработки
          <textarea
            v-model="text"
            rows="3"
            maxlength="16384"
            :disabled="busy || (!can.send && !unknownTurn)"
          />
        </label>
        <div class="project-row">
          <button
            type="submit"
            class="project-primary"
            :disabled="busy || !can.send || !text.trim()"
          >
            Отправить
          </button>
          <button
            v-if="unknownTurn"
            type="button"
            :disabled="busy || !recoveryReady || !text.trim()"
            @click="send(true)"
          >
            Повторить исходный запрос
          </button>
        </div>
      </form>
    </section>
    <section class="project-panel" aria-labelledby="diff-heading">
      <div class="project-row">
        <h2 id="diff-heading">Снимок и тесты</h2>
        <button type="button" :disabled="busy || !can.capture" @click="capture(false)">
          Зафиксировать изменения
        </button>
      </div>
      <template v-if="local.capture && !local.capture.hash">
        <p role="status">
          Снимок не подтверждён. Можно явно повторить запрос снимка с тем же идентификатором.
        </p>
        <button type="button" :disabled="busy || !recoveryReady" @click="capture(true)">
          Повторить запрос снимка
        </button>
      </template>
      <template v-if="diff">
        <p class="project-hash">Снимок {{ diff.hash }}</p>
        <p class="muted project-hash">База {{ diff.baseCommit }} · файлов {{ diff.fileCount }}</p>
        <pre tabindex="0">{{ diff.diff || 'Изменений в снимке нет.' }}</pre>
        <p v-if="!tests">Тестовые данные не загружены.</p>
        <p v-else-if="!tests.length">Тестовые пресеты не зарегистрированы.</p>
        <ul v-else>
          <li v-for="(test, index) in tests" :key="index">
            {{ test.presetId ?? 'Пресет' }} · {{ testText[test.state] }}
            <span v-if="test.hash" class="muted project-hash"> · {{ test.hash }}</span>
          </li>
        </ul>
      </template>
      <p v-else-if="!local.capture" class="muted">Сохраните снимок рабочей копии после запуска.</p>
    </section>
    <section class="project-panel" aria-labelledby="review-heading">
      <div class="project-row">
        <h2 id="review-heading">Ревью</h2>
        <button type="button" :disabled="busy || !can.review" @click="begin('review')">
          Запросить ревью снимка
        </button>
      </div>
      <ProjectOperation
        v-if="local.review"
        :request="request"
        :handle="local.review"
        :status="operations.review"
        :disabled="busy"
        @decided="refresh"
      />
      <template v-if="review">
        <p>Тестовые записи: {{ reviewTests[review.tests] }}</p>
        <p
          v-if="
            review.stale || (review.verdict && review.verdict.binding.changesetHash !== diff?.hash)
          "
          role="status"
        >
          Ревью устарело для выбранного снимка.
        </p>
        <template v-if="review.verdict">
          <p>{{ verdicts[review.verdict.verdict] }}</p>
          <pre>{{ review.verdict.summary }}</pre>
          <ul v-if="review.verdict.findings.length">
            <li v-for="(finding, index) in review.verdict.findings" :key="index">
              {{ finding.path }}:{{ finding.line }} · {{ finding.explanation }}
            </li>
          </ul>
        </template>
      </template>
    </section>
    <section class="project-panel" aria-labelledby="apply-heading">
      <div class="project-row">
        <h2 id="apply-heading">Применение</h2>
        <button
          type="button"
          class="project-primary"
          :disabled="busy || !can.apply"
          @click="begin('apply')"
        >
          Запросить применение
        </button>
      </div>
      <p v-if="!can.apply && !local.apply" class="muted">
        Нужны актуальное одобрение снимка и совпадающие тестовые записи.
      </p>
      <ProjectOperation
        v-if="local.apply"
        :request="request"
        :handle="local.apply"
        :status="operations.apply"
        :disabled="busy"
        @decided="refresh"
      />
    </section>
  </div>
</template>
