import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: proxy API to the running Go server (:8090 launchd dev copy)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8095,
    proxy: {
      '/api': 'http://localhost:8090',
    },
  },
})
