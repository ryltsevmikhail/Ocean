<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Avatar from './Avatar.vue';
import ClayFace from './ClayFace.vue';
import { botStyle, setBotStyle } from './bot-style.js';
import { characters, ids, type Character, type Reaction } from './clay/characters.js';
import type { Bot } from '../protocol.js';
const props = defineProps<{ bot: Bot }>();
const editor = ref<HTMLDialogElement>();
const opened = ref(false);
const size = ref(96);
const actor = ref<InstanceType<typeof ClayFace>>();
const style = computed(() => botStyle(props.bot.handle));
const info = computed(() => characters[style.value.character]);
const motions: readonly [Reaction, string][] = [
  ['blink', 'Моргнуть'],
  ['gaze', 'Взгляд'],
  ['smile', 'Улыбка'],
  ['think', 'Подумать'],
  ['write', 'Писать'],
  ['search', 'Искать'],
];
const system = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = ref(system.matches);
const updateMotion = () => {
  reduced.value = system.matches;
};
onMounted(() => system.addEventListener('change', updateMotion));
onBeforeUnmount(() => system.removeEventListener('change', updateMotion));
function select(id: Character) {
  setBotStyle(props.bot.handle, { character: id, color: characters[id][1] });
}
function tint(event: Event) {
  const input = event.target;
  if (input instanceof HTMLInputElement)
    setBotStyle(props.bot.handle, { ...style.value, color: input.value });
}
function open() {
  opened.value = true;
  editor.value?.showModal();
}
</script>
<template>
  <button class="person" :aria-label="'Аватар @' + bot.handle" @click="open">
    <Avatar :handle="bot.handle" /><span
      ><strong>@{{ bot.handle }}</strong
      ><small>{{ bot.name }}</small></span
    >
  </button>
  <dialog
    ref="editor"
    class="settings character-studio"
    :aria-label="'Аватар @' + bot.handle"
    @close="opened = false"
  >
    <template v-if="opened">
      <header>
        <div>
          <small>Ocean · Студия персонажей</small>
          <h2>Аватар @{{ bot.handle }}</h2>
        </div>
        <button class="round" aria-label="Закрыть" @click="editor?.close()">×</button>
      </header>
      <div class="studio-layout">
        <div>
          <h3>Коллекция</h3>
          <div class="collection">
            <button
              v-for="(id, i) in ids"
              :key="id"
              :aria-label="characters[id][0]"
              :aria-pressed="style.character === id"
              @click="select(id)"
            >
              <small>{{ String(i + 1).padStart(2, '0') }}</small
              ><ClayFace
                :character="id"
                :color="style.character === id ? style.color : characters[id][1]"
              /><span>{{ characters[id][0] }}</span>
            </button>
          </div>
        </div>
        <div class="inspector">
          <h3>Предпросмотр</h3>
          <div class="stage" :data-size="size">
            <ClayFace ref="actor" :character="style.character" :color="style.color" />
          </div>
          <div class="optical-sizes" aria-label="Размер предпросмотра">
            <button
              v-for="px in [24, 32, 48, 96]"
              :key="px"
              :aria-label="px + ' пикселей'"
              :aria-pressed="px === size"
              @click="size = px"
            >
              {{ px }}
            </button>
          </div>
          <h2>{{ info[0] }}</h2>
          <p>{{ info[2] }}</p>
          <label class="pigment"
            >Пигмент <input type="color" :value="style.color" @input="tint"
          /></label>
          <h3>Мимика</h3>
          <p v-if="reduced">Движение отключено в настройках системы.</p>
          <div class="reactions">
            <button
              v-for="[id, title] in motions"
              :key="id"
              :disabled="reduced"
              @click="actor?.play(id)"
            >
              {{ title }}
            </button>
          </div>
          <div class="studio-actions">
            <button class="primary" :disabled="reduced" @click="actor?.play('signature')">
              {{ info[3] }}</button
            ><button @click="actor?.stop()">Стоп</button>
          </div>
        </div>
      </div>
      <footer>
        <small>Выбор сохраняется для @{{ bot.handle }}</small
        ><button @click="setBotStyle(bot.handle, null)">Сбросить</button>
      </footer>
    </template>
  </dialog>
</template>
