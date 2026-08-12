import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5174, strictPort: true },
  build: {
    outDir: 'build',
    sourcemap: false,
    chunkSizeWarningLimit: 850
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    coverage: { reporter: ['text', 'json-summary'] }
  }
})
