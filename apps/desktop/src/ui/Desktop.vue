<script setup lang="ts">
import { ref, watch } from 'vue';
import { useDesktop } from './state.js';
const {
  bots,
  rooms,
  room,
  history,
  runs,
  members,
  recipient,
  draft,
  feedback,
  busy,
  pending,
  dialog,
  selected,
  title,
  kind,
  handle,
  name,
  role,
  model,
  label,
  roomName,
  guard,
  read,
  refresh,
  team,
  create,
  send,
  stop,
} = useDesktop();
const manager = ref<HTMLDialogElement>();
watch(
  dialog,
  (value) => {
    if (value) manager.value?.showModal();
    else manager.value?.close();
  },
  { flush: 'post' },
);
</script>
<template>
  <aside class="rail">
    <header class="brand"><span class="mark">≈</span>Ocean</header>
    <div class="section">
      <h2>Комнаты</h2>
      <button
        aria-label="Создать комнату"
        :disabled="busy"
        @click="
          dialog = 'room';
          selected = [];
        "
      >
        ＋
      </button>
    </div>
    <nav>
      <button
        v-for="r in rooms"
        :key="r.id"
        :aria-current="room?.id === r.id"
        :disabled="busy"
        @click="guard(() => read(r))"
      >
        {{ roomName(r) }}
      </button>
    </nav>
    <footer><button :disabled="busy" @click="dialog = 'bot'">Профили ботов</button></footer>
  </aside>
  <main>
    <header class="top">
      <div>
        <small>{{ room?.kind === 'direct' ? 'Личная комната' : 'Рабочее пространство' }}</small>
        <h1>{{ room ? roomName(room) : 'Ocean Desktop' }}</h1>
      </div>
      <button :disabled="busy" @click="guard(() => refresh())">Обновить</button>
    </header>
    <section v-if="!rooms.some((r) => r.kind === 'group' && r.title === 'Ocean Team')" id="welcome">
      <h2>Разработка и разбор в одной комнате</h2>
      <button :disabled="busy" @click="guard(team)">Создать Ocean Team</button>
    </section>
    <section v-if="room" id="history" aria-label="История комнаты">
      <article v-for="m in history" :key="m.id" class="post">
        <header>
          {{ m.author === 'bot' ? '@' + label(m.authorBotId) : 'Вы' }}
          <span v-if="m.author === 'user' && m.targetBotId">→ @{{ label(m.targetBotId) }}</span>
        </header>
        <p>{{ m.body }}</p>
      </article>
    </section>
    <div id="feedback" role="status">{{ feedback }}</div>
    <form v-if="room" id="composer" @submit.prevent="guard(send)">
      <label v-if="room.kind === 'group'"
        >Кому
        <select v-model="recipient" :disabled="busy">
          <option value="">Всем · без ответа</option>
          <option v-for="b in members" :key="b.id" :value="b.handle">@{{ b.handle }}</option>
        </select></label
      >
      <textarea
        id="draft"
        v-model="draft"
        :disabled="busy"
        aria-label="Сообщение"
        placeholder="Сообщение в комнату…"
        maxlength="16384"
      ></textarea>
      <div class="actions">
        <button v-if="pending" type="button" @click="stop">Запросить отмену</button
        ><button class="primary" :disabled="busy || !draft.trim()">Отправить</button>
      </div>
    </form>
  </main>
  <aside class="details">
    <small>КОНТЕКСТ</small>
    <h2>Участники</h2>
    <div v-for="b in members" :key="b.id" class="person">@{{ b.handle }} · {{ b.name }}</div>
    <h2 v-if="runs.length">Ходы комнаты</h2>
    <p v-for="run in runs" :key="run.taskRunId">{{ run.turnStatus ?? run.taskStatus }}</p>
    <hr />
    <h2>Работа с кодом</h2>
    <p>
      Changeset, тесты, подтверждения и review кода недоступны. Для них ещё нет проверенного
      интерфейса задач Ocean 1.1 в Desktop.
    </p>
  </aside>
  <dialog ref="manager" aria-label="Создание" @cancel.prevent="!busy && (dialog = '')">
    <form v-if="dialog" id="fields" @submit.prevent="guard(create)">
      <h2>{{ dialog === 'bot' ? 'Новый профиль' : 'Новая комната' }}</h2>
      <template v-if="dialog === 'bot'"
        ><p>{{ bots.map((b) => '@' + b.handle).join(' · ') }}</p>
        <label
          >Идентификатор<input v-model="handle" required pattern="[a-z][a-z0-9_\-]{0,31}" /></label
        ><label>Имя<input v-model="name" required /></label
        ><label>Роль<textarea v-model="role" required></textarea></label
        ><label>Модель<input v-model="model" required /></label
      ></template>
      <template v-else
        ><label
          >Тип<select v-model="kind" @change="selected = []">
            <option value="group">Группа</option>
            <option value="direct">Личная</option>
          </select></label
        ><label v-if="kind === 'group'">Название<input v-model="title" required /></label>
        <fieldset>
          <legend>Участники</legend>
          <label v-for="b in bots" :key="b.id"
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
      <p role="alert">{{ feedback }}</p>
      <button type="button" :disabled="busy" @click="dialog = ''">Закрыть</button
      ><button
        class="primary"
        :disabled="busy || (dialog === 'room' && selected.length < (kind === 'group' ? 2 : 1))"
      >
        Создать
      </button>
    </form>
  </dialog>
</template>
