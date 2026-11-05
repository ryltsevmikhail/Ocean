<script setup lang="ts">
import type { Bot, Room, Run } from '../protocol.js';
import Avatar from './Avatar.vue';
import Glyph from './Glyph.vue';
import RoomWork from './RoomWork.vue';
import Member from './Member.vue';
defineProps<{
  room: Room;
  roomHandle?: string | undefined;
  name: string;
  members: Bot[];
  runs: Run[];
}>();
defineEmits<{ close: [] }>();
</script>
<template>
  <aside class="details">
    <header>
      <small>Сведения</small
      ><button class="round" aria-label="Закрыть сведения" @click="$emit('close')">×</button>
    </header>
    <div class="identity">
      <span v-if="room.kind === 'group'" class="team-glyph"><Glyph name="group" /></span
      ><Avatar v-else :handle="roomHandle" /><strong>{{ name }}</strong
      ><small>{{ room.kind === 'group' ? 'Групповая комната' : 'Личная комната' }}</small>
    </div>
    <template v-if="members.length"
      ><h3>Боты · {{ members.length }}</h3>
      <Member v-for="b in members" :key="b.id" :bot="b" />
    </template>
    <div v-if="room.kind === 'group'" class="info-card">
      <strong>Вы управляете диалогом</strong>
      <p>Выберите адресата перед отправкой. В группе ход передаёте вы.</p>
    </div>
    <RoomWork :key="room.id" :room-id="room.id" :runs="runs" />
  </aside>
</template>
