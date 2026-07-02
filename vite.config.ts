import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// index.html is owned by the legacy no-build app — the new scaffold's entry
// is index-vite.html until cutover (see brainstorms/noc-dashboard-scaffold-plan-2026-07-02.md)
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'index-vite.html',
    },
  },
})
