import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' }] },
  worker: { format: 'es' },
  build: { rollupOptions: { input: { app: 'index.html', benchmark: 'benchmark.html' } } },
})
