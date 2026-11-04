<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import Avatar from './Avatar.vue';
import Appearance from './Appearance.vue';
import RoomDetails from './RoomDetails.vue';
import Glyph from './Glyph.vue';
import RuntimeWelcome from './RuntimeWelcome.vue';
import RuntimeFeedback from './RuntimeFeedback.vue';
import ProfilePanel from './ProfilePanel.vue';
import RoomHistory from './RoomHistory.vue';
import RoomComposer from './RoomComposer.vue';
import RoomManager from './RoomManager.vue';
import ProviderSettings from './ProviderSettings.vue';
import { useDesktop } from './state.js';
const {
  runtimeReady,
  loading,
  sending,
  feedbackError,
  roomHandle,
  sections,
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
  active,
  receipt,
  readError,
  uncertain,
  shownRun,
  sent,
  label,
  roomName,
  guard,
  read,
  refresh,
  team,
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
const profile = ref<InstanceType<typeof ProfilePanel>>();
const roomManager = ref<InstanceType<typeof RoomManager>>();
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
          :disabled="busy || !runtimeReady"
          @click="roomManager?.open('room')"
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
        <ProfilePanel
          ref="profile"
          :busy="busy || !runtimeReady"
          @bot="roomManager?.open('bot')"
        /><Appearance />
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
          <ProviderSettings :busy="busy || !runtimeReady" />
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
      <RuntimeWelcome
        v-if="!room"
        :busy="busy"
        :ready="runtimeReady"
        :loading="loading"
        @refresh="guard(() => refresh())"
        @profile="profile?.open()"
        @team="guard(team)"
      />
      <button
        v-else-if="!rooms.some((r) => r.kind === 'group' && r.title === 'Ocean Team')"
        class="team-link"
        :disabled="busy || !runtimeReady"
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
        :read-error="readError"
        @refresh="guard(() => read(room))"
      />
      <RuntimeFeedback
        :feedback="feedback"
        :receipt="receipt"
        :error="feedbackError"
        @refresh="guard(() => refresh())"
        :run="shownRun"
        :label="label"
      />
      <RoomComposer
        :sent="sent"
        :sending="sending"
        :room-id="room.id"
        :key="room.id"
        v-if="room"
        v-model:draft="draft"
        v-model:recipient="recipient"
        :group="room.kind === 'group'"
        :members="members"
        :busy="busy"
        :active="active"
        :uncertain="uncertain"
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
  <RoomManager ref="roomManager" :bots="bots" :busy="busy" @created="guard(() => refresh())" />
</template>
