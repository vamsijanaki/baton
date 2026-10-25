import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: { port: 5199, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // two pages: the main window and the menu-bar popover
    rolldownOptions: { input: { main: 'index.html', tray: 'tray.html' } },
  },
});
