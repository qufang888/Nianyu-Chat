import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const host = process.env.VITE_DEV_SERVER_HOST || 'localhost';
const port = Number(process.env.VITE_DEV_SERVER_PORT || 5173);

export default defineConfig({
  root: '.',
  base: './',
  mode: 'development',
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    host,
    port,
    strictPort: false,
  },
});
