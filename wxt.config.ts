import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'wxt'
// @ts-expect-error -- Node ESM release helper intentionally has no TS surface.
import { resolveEndpointPolicy } from './scripts/verify-product-manifests.mjs'

// ── env resolution ───────────────────────────────────────────────────
//
// 默认走 prod,通过 HTTPS env 切 staging:
//   prod  : 直接 `pnpm build`
//   beta  : `WXT_API_ENDPOINT=https://service.lhdaobeta.top/graphql \
//            WXT_WEB_ENDPOINT=https://app.lhdaobeta.top pnpm build`
//
// HTTP 仅用于显式 local build。必须设置 WXT_LOCAL_BUILD=true,且 API/Web
// 都使用 localhost、127.0.0.1 或 [::1]；拒绝 production/local 混用。
//
// host_permissions 必须跟 API_ENDPOINT 一致 — 否则 fetch 被 CSP 拦,sync
// 静默失败。这里从 API_ENDPOINT origin 自动派生,避免手动维护两份配置漂移。
//
// WEB_ENDPOINT 现在需要 host_permission:验证成功后要"检测已开的任务广场标签页,
// 有就聚焦、没有才新建"——chrome.tabs.query({url}) 读标签 URL 必须有对应域名的
// host 权限(否则 tab.url 被抹掉,查不到)。只加自己的 web 域,维持最小权限。
// (beta 构建自动是 app.lhdaobeta.top,prod 是 app.lhdao.top。)
const endpointPolicy = resolveEndpointPolicy(process.env)
const API_ENDPOINT = endpointPolicy.apiEndpoint
const WEB_ENDPOINT = endpointPolicy.webEndpoint
const API_HOST_PATTERN = endpointPolicy.apiHostPattern
const WEB_HOST_PATTERN = endpointPolicy.webHostPattern

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: '.output',

  manifest: {
    name: 'Lighthouse',
    description: 'Complete Lighthouse engagement and product-experience tasks',
    permissions: ['storage', 'alarms', 'activeTab', 'scripting'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://www.binance.com/*',
      API_HOST_PATTERN,
      WEB_HOST_PATTERN,
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
      __WEB_MATCH_PATTERN__: JSON.stringify(WEB_HOST_PATTERN),
    },
  }),
})
