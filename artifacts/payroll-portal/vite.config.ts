import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const rawPort = process.env.PORT ?? '5000';

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
  ],
  define: {
    // jszip and some pdf libs reference Node globals in their source
    global: 'globalThis',
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
      // polyfill Node's Buffer for jszip in the browser
      buffer: 'buffer/',
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        // Small separate page for employee attendance links (/a/<token>); see attendance.html.
        attendance: path.resolve(import.meta.dirname, 'attendance.html'),
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: {
      '/api': 'http://127.0.0.1:5100',
      '/p': 'http://127.0.0.1:5100',
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
