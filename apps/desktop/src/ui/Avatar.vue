<script setup lang="ts">
import { computed } from 'vue';
import { botStyle, type Shape, type Color } from './bot-style.js';
const props = defineProps<{
  handle?: string | undefined;
  shape?: Shape;
  color?: Color;
  preview?: boolean;
}>();
const style = computed(() => botStyle(props.handle ?? 'dev'));
const form = computed(() => props.shape ?? style.value.shape);
const tint = computed(() => props.color ?? style.value.color);
</script>
<template>
  <svg
    v-if="handle || shape"
    class="avatar"
    :class="{ 'bot-avatar': !preview }"
    aria-hidden="true"
    viewBox="0 0 96 96"
  >
    <g v-if="form === 'dev'">
      <path
        transform="translate(11.475 10.057)"
        d="M0.16459 23.47054c-1.212-8.34 4.404-15.648 12.42-16.65601l38.4-6.576c8.292-1.476 16.02 4.044 17.112 12.516l6.88801 42.09601c1.16399 7.968-4.668 15.22799-12.55201 16.21199l-39.72 5.94c-7.716 1.152-15.144-4.332-16.116-12.252l-6.432-41.28z"
        :fill="tint"
      />
      <path
        transform="translate(55.356 29.940)"
        stroke="#000000"
        stroke-width="3.510"
        stroke-linecap="round"
        d="M0 0l3.132 4.164"
        fill="none"
      />
      <path
        transform="translate(61.872 28.188)"
        stroke="#000000"
        stroke-width="3.510"
        stroke-linecap="round"
        d="M0 0l3.252 4.38"
        fill="none"
      />
    </g>
    <g v-if="form === 'review'">
      <path
        transform="translate(7.008 8.832)"
        d="M82.212 43.836c0 18.864-15.56399 35.028-40.152 35.02801-17.844 0-42.06-12.108-42.06-31.06801 0-20.892 18.696-47.796 41.808-47.796 25.548 0 40.404 26.904 40.404 43.836z"
        :fill="tint"
      />
      <path
        transform="translate(53.004 26.268)"
        stroke="#090909"
        stroke-width="3.053"
        stroke-linecap="round"
        d="M4.308 0l-4.308 4.584"
        fill="none"
      />
      <path
        transform="translate(60.564 27.804)"
        stroke="#090909"
        stroke-width="3.053"
        stroke-linecap="round"
        d="M3.624 0l-3.624 3.78"
        fill="none"
      />
    </g>
    <g v-if="form === 'docs'">
      <path
        transform="translate(5.232 5.532)"
        d="M65.424 20.364c-1.38-12.168-11.00401-20.364-22.656-20.364-11.65199 0-21.432 8.688-22.644 20.364-11.268 1.164-20.124 10.632-20.124 22.248 0 11.88 9.048 20.844 20.1 21.62401 1.008 12.264 11.34 20.844 22.76401 20.93999 11.66399-0.09599 21.66-8.688 22.584-20.86799 11.52-0.84001 20.184-10.152 20.18399-21.69601 0-11.58-9-21.264-20.208-22.248z"
        :fill="tint"
      />
      <path
        transform="translate(52.668 31.284)"
        stroke="#0E0E0E"
        stroke-width="2.777"
        stroke-linecap="round"
        d="M2.304 0l-2.304 3.84"
        fill="none"
      />
      <path
        transform="translate(58.164 29.628)"
        stroke="#0E0E0E"
        stroke-width="2.777"
        stroke-linecap="round"
        d="M3.252 0l-3.252 5.496"
        fill="none"
      />
    </g></svg
  ><img v-else class="avatar" :src="'./marks/ocean.svg'" alt="" draggable="false" />
</template>
