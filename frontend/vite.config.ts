import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode !== 'test' ? [tailwindcss()] : []),
  ],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: './src/tests/setup.ts',
    css: false,
    pool: 'threads',
  },
}))
