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
    ],
    action: {
      default_title: 'Lighthouse',
    },
  },

  vite: () => ({
    plugins: [tailwindcss()],
    define: {
      // Compile-time endpoints. 仅 prod。
      //
      //   __API_ENDPOINT__ = service.lhdao.top    (GraphQL backend)
      //   __WEB_ENDPOINT__ = app.lhdao.top        (app routes: /settings/plugin-tokens 等)
      //
      // Web 是 app 子域 — lhdao.top 是 landing,/settings 等路径在 app.lhdao.top。
      //
      // 临时想用 staging,环境变量 WXT_API_ENDPOINT / WXT_WEB_ENDPOINT 覆盖即可,
      // 不再提供 :beta npm scripts(2026-05-18 移除,避免误发 beta zip 上 Web Store)。
      __API_ENDPOINT__: JSON.stringify(
        process.env.WXT_API_ENDPOINT ?? 'https://service.lhdao.top/graphql',
      ),
      __WEB_ENDPOINT__: JSON.stringify(
        process.env.WXT_WEB_ENDPOINT ?? 'https://app.lhdao.top',
      ),
    },
  }),
})
