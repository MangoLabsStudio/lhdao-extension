import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: '.output',

  manifest: {
    name: 'Lighthouse',
    description:
      'Highlight Lighthouse engagement tasks on X timeline + 1-click claim',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://service.lhdao.top/*',
      'https://service.lhdaobeta.top/*',
    ],
    action: {
      default_title: 'Lighthouse',
    },
  },

  vite: () => ({
    plugins: [tailwindcss()],
    define: {
      // Compile-time endpoints. Override via env vars to target staging.
      //
      // 这两个端点要一起切 — token 数据库 per-env 不通用:
      //   prod : __API_ENDPOINT__ = service.lhdao.top      __WEB_ENDPOINT__ = lhdao.top
      //   beta : __API_ENDPOINT__ = service.lhdaobeta.top  __WEB_ENDPOINT__ = lhdaobeta.top
      __API_ENDPOINT__: JSON.stringify(
        process.env.WXT_API_ENDPOINT ?? 'https://service.lhdao.top/graphql',
      ),
      __WEB_ENDPOINT__: JSON.stringify(
        process.env.WXT_WEB_ENDPOINT ?? 'https://lhdao.top',
      ),
    },
  }),
})
