<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Avatar from './Avatar.vue';
import Appearance from './Appearance.vue';
import Member from './Member.vue';
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
const details = ref(window.innerWidth >= 1080);
const roomList = ref(false);
const historyView = ref<HTMLElement>();
watch(
  () => history.value.length,
  async () => {
    await nextTick();
    if (historyView.value) historyView.value.scrollTop = historyView.value.scrollHeight;
  },
);
const sections = computed(() =>
  [
    { title: 'Команды', items: rooms.value.filter((r) => r.kind === 'group') },
    { title: 'Личные комнаты', items: rooms.value.filter((r) => r.kind === 'direct') },
  ].filter((s) => s.items.length),
);
const roomHandle = computed(() =>
  room.value?.kind === 'direct' ? label(room.value.botId) : undefined,
);
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
  <div class="shell" :class="{ 'with-details': details && room, 'show-rooms': roomList }">
    <aside class="rail">
      <header class="brand">
        <Avatar />Ocean<button
          class="round rail-close"
          aria-label="Закрыть список комнат"
          @click="roomList = false"
        >
          ×
        </button>
      </header>
      <div class="section">
        <h2>Комнаты</h2>
        <button
          class="round"
          aria-label="Создать комнату"
          title="Создать комнату"
          :disabled="busy"
          @click="
            dialog = 'room';
            selected = [];
          "
        >
          +
        </button>
      </div>
      <nav>
        <section v-for="section in sections" :key="section.title">
          <h3>{{ section.title }}</h3>
          <button
            v-for="r in section.items"
            :key="r.id"
            :aria-label="roomName(r)"
            :aria-current="room?.id === r.id"
            :disabled="busy"
            @click="
              roomList = false;
              guard(() => read(r));
            "
          >
            <Avatar :handle="r.kind === 'direct' ? label(r.botId) : undefined" /><span
              ><strong>{{ roomName(r) }}</strong
              ><small>{{
                r.kind === 'group'
                  ? r.botIds.map(label).join(' · ')
                  : bots.find((b) => b.id === r.botId)?.name
              }}</small></span
            >
          </button>
        </section>
        <p v-if="!rooms.length" class="muted">Здесь появятся ваши диалоги.</p>
      </nav>
      <footer>
        <button :disabled="busy" @click="dialog = 'bot'">Профили ботов</button><Appearance />
      </footer>
    </aside>
    <main>
      <header class="top">
        <button class="round rooms-toggle" aria-label="Список комнат" @click="roomList = true">
          ☰
        </button>
        <div v-if="room" class="room-chip">
          <Avatar :handle="roomHandle" />
          <h1>{{ room ? roomName(room) : 'Ocean Desktop' }}</h1>
        </div>
        <div class="top-tools">
          <button
            class="round"
            title="Обновить"
            aria-label="Обновить"
            :disabled="busy"
            @click="guard(() => refresh())"
          >
            ↻</button
          ><button
            class="round"
            v-if="room"
            title="Сведения"
            aria-label="Сведения"
            :aria-expanded="details"
            @click="details = !details"
          >
            ⓘ
          </button>
        </div>
      </header>
      <section v-if="!room" id="welcome">
        <Avatar />
        <h2>Ваша команда в Ocean</h2>
        <p>Обсудите задачу с dev, затем передайте результат review в той же комнате.</p>
        <button class="primary" :disabled="busy" @click="guard(team)">Создать Ocean Team</button>
      </section>
      <button
        v-else-if="!rooms.some((r) => r.kind === 'group' && r.title === 'Ocean Team')"
        class="team-link"
        :disabled="busy"
        @click="guard(team)"
      >
        Создать Ocean Team
      </button>
      <section v-if="room" ref="historyView" id="history" aria-label="История комнаты">
        <div v-if="!history.length && !busy" class="empty-chat">
          <Avatar :handle="roomHandle" />
          <h2>Начало разговора</h2>
          <p>
            {{
              room.kind === 'group'
                ? 'Выберите участника и отправьте первое сообщение.'
                : 'Отправьте первое сообщение в личную комнату.'
            }}
          </p>
        </div>
        <article v-for="m in history" :key="m.id" class="post" :class="m.author">
          <header>
            <Avatar v-if="m.author === 'bot'" :handle="label(m.authorBotId)" />{{
              m.author === 'bot' ? '@' + label(m.authorBotId) : 'Вы'
            }}<span v-if="m.author === 'user' && m.targetBotId">
              → @{{ label(m.targetBotId) }}</span
            >
          </header>
          <p>{{ m.body }}</p>
        </article>
      </section>
      <div id="feedback" role="status">{{ feedback }}</div>
      <form v-if="room" id="composer" @submit.prevent="guard(send)">
        <label v-if="room.kind === 'group'" class="recipient"
          >Кому
          <select v-model="recipient" :disabled="busy">
            <option value="">Всем · без ответа</option>
            <option v-for="b in members" :key="b.id" :value="b.handle">@{{ b.handle }}</option>
          </select></label
        >
        <div class="compose-line">
          <textarea
            id="draft"
            v-model="draft"
            rows="1"
            :disabled="busy"
            aria-label="Сообщение"
            :placeholder="recipient ? 'Сообщение для @' + recipient + '…' : 'Сообщение в комнату…'"
            maxlength="16384"
          ></textarea
          ><button v-if="pending" type="button" @click="stop">Запросить отмену</button
          ><button
            class="send"
            aria-label="Отправить"
            title="Отправить"
            :disabled="busy || !draft.trim()"
          >
            ↑
          </button>
        </div>
      </form>
    </main>
    <aside v-if="details && room" class="details">
      <header>
        <small>Сведения</small
        ><button class="round" aria-label="Закрыть сведения" @click="details = false">×</button>
      </header>
      <div class="identity">
        <Avatar :handle="roomHandle" /><strong>{{ room ? roomName(room) : 'Ocean' }}</strong
        ><small>{{
          room?.kind === 'group'
            ? 'Групповая комната'
            : room
              ? 'Личная комната'
              : 'Локальный профиль'
        }}</small>
      </div>
      <template v-if="members.length"
        ><h3>Участники · {{ members.length }}</h3>
        <Member v-for="b in members" :key="b.id" :bot="b" />
      </template>
      <template v-if="runs.length"
        ><h3>Ходы комнаты</h3>
        <p v-for="run in runs" :key="run.taskRunId">
          {{ run.turnStatus ?? run.taskStatus }}
        </p></template
      >
      <h3>Работа с кодом</h3>
      <p class="info-card">
        Changeset, тесты, подтверждения и review кода станут доступны после подключения API задач
        Ocean 1.1.
      </p>
    </aside>
  </div>
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
