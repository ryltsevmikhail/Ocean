import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist/web',
    modulePreload: false,
    rolldownOptions: {
      input: {
        desktop: fileURLToPath(new URL('./index.html', import.meta.url)),
        projects: fileURLToPath(new URL('./projects.html', import.meta.url)),
      },
    },
  },
});
