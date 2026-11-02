<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import Avatar from './Avatar.vue';
import Appearance from './Appearance.vue';
import RoomDetails from './RoomDetails.vue';
import Glyph from './Glyph.vue';
import ProfilePanel from './ProfilePanel.vue';
import RoomHistory from './RoomHistory.vue';
import RoomComposer from './RoomComposer.vue';
import { useDesktop } from './state.js';
const {
  bots,
  rooms,
  room,
  history,
  runs,
  members,
  roomPreview,
  recipient,
  draft,
  feedback,
  busy,
  pending,
  sent,
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
const wide = matchMedia('(min-width:1080px)');
const oneColumn = matchMedia('(max-width:800px)');
function adapt() {
  details.value = wide.matches;
  roomList.value = false;
}
onMounted(() => {
  wide.addEventListener('change', adapt);
  oneColumn.addEventListener('change', adapt);
});
onBeforeUnmount(() => {
  wide.removeEventListener('change', adapt);
  oneColumn.removeEventListener('change', adapt);
});
const invalidHandle = computed(
  () => !!handle.value && !/^[a-z][a-z0-9_-]{0,31}$/.test(handle.value),
);
const sections = computed(() =>
  [
    { title: 'Групповые комнаты', items: rooms.value.filter((r) => r.kind === 'group') },
    { title: 'Личные комнаты', items: rooms.value.filter((r) => r.kind === 'direct') },
  ].filter((s) => s.items.length),
);
const roomHandle = computed(() =>
  room.value?.kind === 'direct' ? label(room.value.botId) : undefined,
);
const profile = ref<InstanceType<typeof ProfilePanel>>();
const manager = ref<HTMLDialogElement>();
watch(
  dialog,
  (value) => {
    if (value) {
      feedback.value = '';
      manager.value?.showModal();
    } else manager.value?.close();
  },
  { flush: 'post' },
);
</script>
<template>
  <div class="shell" :class="{ 'with-details': details && room, 'show-rooms': roomList }">
    <aside class="rail">
      <header class="brand">
        <Avatar /><span>Ocean</span
        ><button
          class="round rail-close"
          aria-label="Закрыть список комнат"
          @click="roomList = false"
        >
          ×
        </button>

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
          <Glyph name="plus" />
        </button>
      </header>
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
            <span v-if="r.kind === 'group'" class="team-glyph"><Glyph name="group" /></span
            ><Avatar v-else :handle="label(r.botId)" /><span
              ><strong>{{ roomName(r) }}</strong
              ><small>{{ roomPreview(r) }}</small></span
            >
          </button>
        </section>
        <p v-if="!rooms.length" class="muted">Здесь появятся ваши диалоги.</p>
      </nav>
      <footer>
        <ProfilePanel ref="profile" :busy="busy" @bot="dialog = 'bot'" /><Appearance />
      </footer>
    </aside>
    <main>
      <header class="top">
        <button class="round rooms-toggle" aria-label="Список комнат" @click="roomList = true">
          <Glyph name="rooms" /> Комнаты
        </button>
        <div v-if="room" class="room-chip">
          <Glyph v-if="room.kind === 'group'" name="group" /><Avatar v-else :handle="roomHandle" />
          <h1>{{ roomName(room) }}</h1>
        </div>
        <div class="top-tools">
          <button
            class="round"
            title="Обновить"
            aria-label="Обновить"
            :disabled="busy"
            @click="guard(() => refresh())"
          >
            <Glyph name="refresh" /></button
          ><button
            class="round"
            v-if="room"
            title="Сведения"
            aria-label="Сведения"
            :aria-expanded="details"
            @click="details = !details"
          >
            <Glyph name="panel" />
          </button>
        </div>
      </header>
      <section v-if="!room" id="welcome">
        <Avatar />
        <small>ЛОКАЛЬНЫЙ ПРОФИЛЬ</small>
        <h2>Начните с Ocean Team</h2>
        <p>Обсудите задачу с dev, затем передайте результат review в той же комнате.</p>
        <dl class="runtime-facts">
          <dt>Провайдер</dt>
          <dd>DeepSeek</dd>
          <dt>История</dt>
          <dd>Локально · SQLite</dd>
        </dl>
        <div class="form-actions">
          <button :disabled="busy" @click="profile?.open()">Проверить профиль</button
          ><button class="primary" :disabled="busy" @click="guard(team)">Создать Ocean Team</button>
        </div>
      </section>
      <button
        v-else-if="!rooms.some((r) => r.kind === 'group' && r.title === 'Ocean Team')"
        class="team-link"
        :disabled="busy"
        @click="guard(team)"
      >
        Создать Ocean Team
      </button>
      <RoomHistory
        v-if="room"
        :room-id="room.id"
        :group="room.kind === 'group'"
        :handle="roomHandle"
        :label="label"
        :busy="busy"
        :history="history"
      />
      <div id="feedback" role="status">
        {{ feedback }}
        <button
          v-if="feedback.startsWith('Провайдер недоступен')"
          :disabled="busy"
          @click="profile?.open()"
        >
          Проверить профиль
        </button>
      </div>
      <RoomComposer
        :sent="sent"
        :room-id="room.id"
        :key="room.id"
        v-if="room"
        v-model:draft="draft"
        v-model:recipient="recipient"
        :group="room.kind === 'group'"
        :members="members"
        :busy="busy"
        :pending="pending"
        @send="(ids) => guard(() => send(ids))"
        @stop="stop"
      />
    </main>
    <RoomDetails
      v-if="details && room"
      :room="room"
      :room-handle="roomHandle"
      :name="roomName(room)"
      :members="members"
      :runs="runs"
      @close="details = false"
    />
  </div>
  <dialog ref="manager" aria-label="Создание" @cancel.prevent="!busy && (dialog = '')">
    <form v-if="dialog" id="fields" @submit.prevent="guard(create)">
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
        ><p>{{ bots.map((b) => '@' + b.handle).join(' · ') }}</p>
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
      <p v-if="busy || feedback" :role="feedback ? 'alert' : 'status'">
        {{ feedback || 'Запрос выполняется…' }}
      </p>
      <button type="button" :disabled="busy" @click="dialog = ''">Закрыть</button
      ><button
        class="primary"
        :disabled="
          busy ||
          (dialog === 'bot' && invalidHandle) ||
          (dialog === 'room' && selected.length < (kind === 'group' ? 2 : 1))
        "
      >
        Создать
      </button>
    </form>
  </dialog>
</template>
