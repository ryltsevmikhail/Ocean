<script setup lang="ts">
defineProps<{ name: keyof typeof icons }>();
const icons = {
  settings: 'M3 7h4 M11 7h10 M3 17h10 M17 17h4 M7 4h4v6H7z M13 14h4v6h-4z',
  provider:
    'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5',
  attachment: 'M8 12l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8 M6 14l8-8',
  file: 'M6 2h8l4 4v16H6z M14 2v5h5',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',

  group:
    'M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M16 4a4 4 0 0 1 0 8 M20 21v-2a4 4 0 0 0-3-3.87 M14 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  panel: 'M3 4h18v16H3z M15 4v16',
  rooms: 'M3 4h18v16H3z M9 4v16',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  refresh: 'M20 6v5h-5 M20 11a8 8 0 1 0-2 7',
  send: 'M12 19V5 M5 12l7-7 7 7',
  profile:
    'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0Z M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z M6 19a6 6 0 0 1 12 0',
  task: 'M4 5h16v14H4z M7 9l2 2 3-4 M14 10h3',
  event: 'M2 12h5l3-7 4 14 3-7h5',
  diff: 'M4 7h10 M9 2v10 M11 17h10',
};
</script>
<template>
  <svg
    class="glyph"
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path :d="icons[name]" />
  </svg>
</template>
