import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn generates components that import from "@/lib/utils".
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
