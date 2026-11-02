<script setup lang="ts">
import { computed } from 'vue';
import ClayFace from './ClayFace.vue';
import { botStyle } from './bot-style.js';
const props = defineProps<{ handle?: string | undefined }>();
const style = computed(() => botStyle(props.handle ?? 'dev'));
</script>
<template>
  <ClayFace
    v-if="handle"
    class="bot-avatar"
    :character="style.character"
    :color="style.color"
  /><img v-else class="avatar" :src="'./marks/ocean.svg'" alt="" draggable="false" />
</template>
