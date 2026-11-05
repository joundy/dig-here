import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Found late, these would make the dev server reload the page right as someone signs in.
  optimizeDeps: { include: ['near-api-js', '@hot-labs/near-connect', 'function-call-key-plugin'] },
  server: {
    proxy: {
      '/api': { target: process.env.DIG_API ?? 'http://localhost:8787', changeOrigin: true },
    },
  },
  test: { include: ['src/**/*.test.ts'] },
});
