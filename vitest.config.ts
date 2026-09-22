import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing'

export default defineConfig(async () => ({
  plugins: await WxtVitest(),
  define: {
    __API_ENDPOINT__: JSON.stringify('https://service.lhdao.top/graphql'),
    __WEB_ENDPOINT__: JSON.stringify('https://app.lhdao.top'),
    __WEB_MATCH_PATTERN__: JSON.stringify('https://app.lhdao.top/*'),
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
}))
