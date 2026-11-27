import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'

const envDir = fileURLToPath(new URL('..', import.meta.url))
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '')
  const target = 'http://127.0.0.1:' + (env.PORT || 3000)
  return { envDir, server: { proxy: { '/api': target, '/socket.io': { target, ws: true } } } }
})

