import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3002,
    proxy: {
      '/api': {
        target: 'https://localhost:3010',
        secure: false,
      },
      '/ws': {
        target: 'wss://localhost:3010',
        secure: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
