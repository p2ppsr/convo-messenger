import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // @bsv/sdk's native GlobalKVStore recovery identifies wallet review errors
  // by constructor.name. Preserve it in production just as MetanetDocs does.
  esbuild: { keepNames: true },
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
