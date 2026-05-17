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
      //   prod : __API_ENDPOINT__ = service.lhdao.top      __WEB_ENDPOINT__ = app.lhdao.top
      //   beta : __API_ENDPOINT__ = service.lhdaobeta.top  __WEB_ENDPOINT__ = lhdaobeta.top
      //
      // Web 是 app 子域(用户在 lhdao.top 是 landing,实际应用 + token 设置
      // 页在 app.lhdao.top/settings/plugin-tokens),不要指错根域名 lhdao.top
      // 否则跳转去的是介绍页找不到 /settings 路径。
      __API_ENDPOINT__: JSON.stringify(
        process.env.WXT_API_ENDPOINT ?? 'https://service.lhdao.top/graphql',
      ),
      __WEB_ENDPOINT__: JSON.stringify(
        process.env.WXT_WEB_ENDPOINT ?? 'https://app.lhdao.top',
      ),
    },
  }),
})
