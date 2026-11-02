<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watchEffect } from 'vue';
import type { Character, Reaction } from './clay/characters.js';
import { mountFace } from './clay/face.js';
const props = defineProps<{ character: Character; color: string }>();
const host = ref<HTMLElement>();
let mounted: ReturnType<typeof mountFace> | undefined;
onMounted(() => {
  if (host.value) {
    mounted = mountFace(host.value);
    watchEffect(() => mounted?.render(props.character, props.color));
  }
});
onBeforeUnmount(() => mounted?.destroy());
defineExpose({
  play: (reaction: Reaction) => mounted?.play(reaction),
  stop: () => mounted?.stop(),
});
</script>
<template><span ref="host" class="avatar" aria-hidden="true"></span></template>
