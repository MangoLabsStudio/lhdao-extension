import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'

// ── env resolution ───────────────────────────────────────────────────
//
// 默认走 prod,通过 env 切 staging:
//   prod  : 直接 `pnpm build`
//   beta  : `WXT_API_ENDPOINT=https://service.lhdaobeta.top/graphql \
//            WXT_WEB_ENDPOINT=https://app.lhdaobeta.top pnpm build`
//
// 注意:测试环境 web 域名是 `app.lhdaobeta.top`(跟 prod 一样有 app. 前缀),
// 不是 `lhdaobeta.top` — 后者是 landing 页,routes 都在 app 子域。
//
// host_permissions 必须跟 API_ENDPOINT 一致 — 否则 fetch 被 CSP 拦,sync
// 静默失败。这里从 API_ENDPOINT origin 自动派生,避免手动维护两份配置漂移。
//
// WEB_ENDPOINT 不需要 host_permission(只 navigation,不 fetch),所以不算
// 进列表 — 维持 "least permission" 原则,Web Store 审核也更顺。
const API_ENDPOINT =
  process.env.WXT_API_ENDPOINT ?? 'https://service.lhdao.top/graphql'
const WEB_ENDPOINT = process.env.WXT_WEB_ENDPOINT ?? 'https://app.lhdao.top'

const API_HOST_PATTERN = `${new URL(API_ENDPOINT).origin}/*`

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
      API_HOST_PATTERN,
    ],
    action: {
      default_title: 'Lighthouse',
    },
    // 让 content script 在 x.com / twitter.com 上能 fetch 扩展自带的 icon
    // PNG(用 chrome.runtime.getURL('icon/128.png')),作为 timeline 推文
    // 注入的 "灯塔成员" chip + profile bio badge 的内嵌 logo。
    web_accessible_resources: [
      {
        resources: ['icon/*.png'],
        matches: ['*://x.com/*', '*://twitter.com/*'],
      },
    ],
  },

  vite: () => ({
    plugins: [tailwindcss()],
    define: {
      __API_ENDPOINT__: JSON.stringify(API_ENDPOINT),
      __WEB_ENDPOINT__: JSON.stringify(WEB_ENDPOINT),
    },
  }),
})
