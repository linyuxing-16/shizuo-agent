import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/shizuo-agent/',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        config: resolve(__dirname, 'config.html'),
      },
    },
  },
});
