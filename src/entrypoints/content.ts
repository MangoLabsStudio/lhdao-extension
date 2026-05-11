import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
// ⚠ ?inline 让 Vite 把 chip.css 走 PostCSS + Tailwind 4 编译流程返回**编译后**
// 的 CSS 字符串。用 ?raw 会拿到字面量 `@import 'tailwindcss'`,Shadow DOM
// 里浏览器把它当无效 URL,Tailwind utilities 全失效 (SVG 退回默认 300x150
// 等 bug)。
import chipCss from '@/components/chip/chip.css?inline'
import highlightCss from '@/components/chip/highlight.css?inline'
import { MetadataBadge } from '@/components/chip/MetadataBadge'
import { SubmitButton } from '@/components/chip/SubmitButton'
import { sendMessage } from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'
import { extractTweetIdFromArticle } from '@/lib/twitter-dom'

/**
 * Content script — 在 X (Twitter) timeline / 详情页"织入"灯塔任务的视觉信号。
 *
 * 4 个注入点(per article):
 *   ① article 本身 → data-lhdao-active="1" 触发 highlight.css 的背景+ring
 *   ② <time> 旁 → MetadataBadge (Shadow DOM, "🗼 +N LUX")
 *   ③ 匹配任务的 Twitter action button → data-lhdao-glow 触发 halo
 *   ④ role="group" 动作按钮行末尾 → SubmitButton (Shadow DOM, 状态机)
 *
 * 1, 3 不用 React — 文档级 CSS 选择器命中即可。
 * 2, 4 用 Shadow DOM 隔离我们的 Tailwind 样式不污染 Twitter。
 */

// ── selectors ───────────────────────────────────────────────────────

const ACTION_TYPE_TO_SELECTOR: Record<
  CampaignTaskCache['actionType'],
  string[]
> = {
  LIKE: ['[data-testid="like"]', '[data-testid="unlike"]'],
  RT: ['[data-testid="retweet"]', '[data-testid="unretweet"]'],
  COMMENT: ['[data-testid="reply"]'],
  COMMENT_LIKE: [
    '[data-testid="reply"]',
    '[data-testid="like"]',
    '[data-testid="unlike"]',
  ],
}

const ACTION_TYPE_TO_GLOW_KEY: Record<
  CampaignTaskCache['actionType'],
  string[]
> = {
  LIKE: ['like'],
  RT: ['retweet'],
  COMMENT: ['reply'],
  COMMENT_LIKE: ['reply', 'like'],
}

// ── per-article state ──────────────────────────────────────────────

const ARTICLE_FLAG = 'data-lhdao-active'

interface MountedArticle {
  article: Element
  hosts: HTMLElement[]
  roots: Root[]
  glowedButtons: Element[]
}

const mounted = new Map<string, MountedArticle>() // key = tweetId
/** tweetId 的 get-tasks RPC await 期间的占位,防止 race 导致双挂载 */
const inFlight = new Set<string>()

// ── entrypoint ──────────────────────────────────────────────────────

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  cssInjectionMode: 'manifest',
  runAt: 'document_idle',

  async main() {
    injectGlobalStyle()

    const observer = new MutationObserver(scheduleScan)
    observer.observe(document.body, { childList: true, subtree: true })
    scheduleScan()

    // SPA 导航监听:Twitter 用 pushState 切换路由,焦点 tweet id 会变,
    // 已挂载的 SubmitButton 需要重新计算 isFocal。
    //
    // 关键 timing bug:pushState 触发的瞬间,Twitter 尚未渲染新 article DOM,
    // 单次 rAF scan 命中不了新页面的推文。MutationObserver 理论上能捕到
    // 后续插入,但实测 timeline → detail 切换偶尔遗漏。叠加多次 setTimeout
    // 重扫做兜底,scan 内部有 mounted Map 去重,多扫不会重复挂。
    watchUrlChanges(() => {
      unmountAll()
      scheduleScan()
      setTimeout(scheduleScan, 100)
      setTimeout(scheduleScan, 400)
      setTimeout(scheduleScan, 1000)
      setTimeout(scheduleScan, 2000)
    })

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'tasks-updated') {
        unmountAll()
        scheduleScan()
      }
    })
  },
})

// ── global style injection (一次性) ─────────────────────────────────

function injectGlobalStyle() {
  if (document.getElementById('lhdao-highlight-style')) return
  const style = document.createElement('style')
  style.id = 'lhdao-highlight-style'
  style.textContent = highlightCss
  document.head.appendChild(style)
}

// ── scan loop ───────────────────────────────────────────────────────

let rafScheduled = false
function scheduleScan() {
  if (rafScheduled) return
  rafScheduled = true
  requestAnimationFrame(async () => {
    rafScheduled = false
    await scanTimeline()
  })
}

async function scanTimeline() {
  // —— 1. 清扫 stale 挂载 ———————————————————————————————————————
  // Twitter SPA 导航时同一条 tweetId 可能换 article DOM 节点 (timeline
  // 卡片 → 详情页 article)。旧的 article.isConnected === false,需要主动
  // 从 mounted Map 移除,否则后续新 article 因为 mounted.has(tweetId) 命中
  // 被跳过 → 用户进详情页插件不渲染,要刷新才出。
  for (const [tweetId, state] of mounted.entries()) {
    if (!state.article.isConnected) {
      unmountArticle(state)
      mounted.delete(tweetId)
    }
  }

  // —— 2. 扫新 article 挂载 ——————————————————————————————————————
  const articles = document.querySelectorAll('article')
  for (const article of articles) {
    if (article.hasAttribute(ARTICLE_FLAG)) continue
    const tweetId = extractTweetIdFromArticle(article)
    if (!tweetId) continue
    if (mounted.has(tweetId) || inFlight.has(tweetId)) continue

    // 关键:在 await sendMessage 之前**先**占位,否则 MutationObserver
    // 在等响应期间触发的下一次 scan 会拿到同一个 article(还没 ARTICLE_FLAG)
    // 再发一次 RPC,两次都进 mount → 双 badge / 双按钮。
    inFlight.add(tweetId)
    article.setAttribute(ARTICLE_FLAG, '1')

    try {
      const r = await sendMessage({ type: 'get-tasks-for-tweet', tweetId })
      if (r.type !== 'tasks' || r.tasks.length === 0) {
        // 没任务 — 撤销占位,article 可能后续会有任务被 sync 进来
        article.removeAttribute(ARTICLE_FLAG)
        continue
      }
      const state = mountArticle(article, r.tasks, tweetId)
      if (state) {
        mounted.set(tweetId, state)
      } else {
        article.removeAttribute(ARTICLE_FLAG)
      }
    } finally {
      inFlight.delete(tweetId)
    }
  }
}

// ── mount / unmount ─────────────────────────────────────────────────

function mountArticle(
  article: Element,
  tasks: CampaignTaskCache[],
  currentTweetId: string,
): MountedArticle | null {
  const state: MountedArticle = {
    article,
    hosts: [],
    roots: [],
    glowedButtons: [],
  }

  try {
    // ② Metadata badge — 优先 User-Name 容器(@handle / 名字行,所有页面
    // 视图都稳定存在),退而求其次找 <time>(可能在 timeline 是相对时间在
    // 头行,在详情页是底部完整日期 — 不同位置会跑偏)。
    const badgeAnchor = findBadgeAnchor(article)
    if (badgeAnchor) {
      const host = createShadowHost('lhdao-badge', 'inline')
      // 让 badge 紧跟在 anchor 后面(同一行内联)
      badgeAnchor.parentElement?.insertBefore(host, badgeAnchor.nextSibling)
      const root = renderInto(host, createElement(MetadataBadge, { tasks }))
      state.hosts.push(host)
      state.roots.push(root)
    }

    // ③ Action button glow
    const glowKeys = new Set<string>()
    for (const t of tasks) {
      for (const k of ACTION_TYPE_TO_GLOW_KEY[t.actionType] ?? []) {
        glowKeys.add(k)
      }
    }
    for (const t of tasks) {
      for (const sel of ACTION_TYPE_TO_SELECTOR[t.actionType] ?? []) {
        const btn = article.querySelector(sel)
        if (btn && !btn.hasAttribute('data-lhdao-glow')) {
          // 用第一个匹配的 glow key (例如 like / retweet / reply)
          const key = sel.includes('like')
            ? 'like'
            : sel.includes('retweet')
              ? 'retweet'
              : 'reply'
          btn.setAttribute('data-lhdao-glow', key)
          state.glowedButtons.push(btn)
        }
      }
    }

    // ④ Submit button — **仅在详情页的焦点推文上注入**,timeline 卡片不显示
    // 防止 timeline 视觉太杂。从 location.pathname 解析 /<user>/status/<id>,
    // 命中且 tweetId 匹配当前 article 才挂。
    const focalTweetId = getFocalTweetId()
    const isFocal = focalTweetId != null && focalTweetId === currentTweetId
    if (isFocal) {
      const actionRow = findActionRow(article)
      if (actionRow) {
        const host = createShadowHost('lhdao-submit', 'inline-flex')
        host.style.alignItems = 'center'
        actionRow.appendChild(host)
        const root = renderInto(host, createElement(SubmitButton, { tasks }))
        state.hosts.push(host)
        state.roots.push(root)
      }
    }

    return state
  } catch (e) {
    console.warn('[lhdao] mountArticle failed', e)
    // 部分挂载成功也算,后续 unmount 会清干净
    return state.hosts.length > 0 ? state : null
  }
}

/**
 * 找一个稳定的"头部锚点"挂 Badge。期望视觉上 badge 紧跟在时间戳右边,
 * 跟 "@handle · 1小时" 在同一行内联流动。
 *
 * 优先级:
 *   1. [data-testid="User-Name"] 内的 <time> 元素的最近 <a>(时间戳链接,
 *      插在它后面就和 handle/dot/time 同一行)
 *   2. article 内第一个 <time>(timeline 卡片头部 fallback)
 *   3. User-Name 容器(最终兜底)
 */
function findBadgeAnchor(article: Element): Element | null {
  const userName = article.querySelector('[data-testid="User-Name"]')
  if (userName) {
    const timeInUserName = userName.querySelector('time')
    const timeAnchor = timeInUserName?.closest('a')
    if (timeAnchor) return timeAnchor // 同一行,跟在时间戳后
    if (timeInUserName) return timeInUserName as Element
    return userName as Element // 兜底,放 User-Name 之后(新行)
  }
  const timeEl = article.querySelector('time')
  return timeEl?.closest('a') ?? timeEl ?? null
}

function findActionRow(article: Element): Element | null {
  // Twitter action buttons (reply/retweet/like/...) 通常在一个 role="group"
  // 父容器里。找包含 [data-testid="like"] 或 [data-testid="reply"] 的 group。
  const groups = article.querySelectorAll('[role="group"]')
  for (const g of groups) {
    if (
      g.querySelector('[data-testid="like"]') ||
      g.querySelector('[data-testid="reply"]') ||
      g.querySelector('[data-testid="retweet"]')
    ) {
      return g
    }
  }
  // 兜底:任意有 like 按钮的最近父元素
  const like =
    article.querySelector('[data-testid="like"]') ??
    article.querySelector('[data-testid="reply"]')
  return like?.parentElement?.parentElement ?? null
}

function unmountArticle(state: MountedArticle) {
  for (const root of state.roots) {
    try {
      root.unmount()
    } catch {
      // ignore
    }
  }
  for (const host of state.hosts) {
    host.remove()
  }
  for (const btn of state.glowedButtons) {
    btn.removeAttribute('data-lhdao-glow')
  }
  state.article.removeAttribute(ARTICLE_FLAG)
}

function unmountAll() {
  for (const state of mounted.values()) {
    unmountArticle(state)
  }
  mounted.clear()
  inFlight.clear()
  // 兜底:清理 stale 标记(article 可能已离开 DOM)+ 拖延 host(若有)
  for (const a of document.querySelectorAll(`[${ARTICLE_FLAG}]`)) {
    a.removeAttribute(ARTICLE_FLAG)
  }
  for (const h of document.querySelectorAll('[data-lhdao-host="1"]')) {
    h.remove()
  }
}

// ── shadow DOM helpers ──────────────────────────────────────────────

function createShadowHost(
  className: string,
  display: 'inline' | 'inline-block' | 'inline-flex',
): HTMLElement {
  const host = document.createElement('span')
  host.className = className
  host.style.display = display
  host.setAttribute('data-lhdao-host', '1')
  return host
}

/**
 * 从当前 URL 解析"焦点推文 id" — 详情页路径形如
 * `/<user>/status/<id>`(可带后续 /photo/N 或 query),timeline / home /
 * profile 等页面没有 status 路径,返回 null。
 */
function getFocalTweetId(): string | null {
  const m = location.pathname.match(/\/status\/(\d+)/)
  return m ? m[1] : null
}

/** Twitter SPA 用 pushState,监听 popstate + 包装 pushState/replaceState */
function watchUrlChanges(cb: () => void) {
  let last = location.pathname
  const notify = () => {
    if (location.pathname !== last) {
      last = location.pathname
      cb()
    }
  }
  window.addEventListener('popstate', notify)
  // 包装 history.pushState/replaceState 让我们能感知 SPA 导航
  for (const fn of ['pushState', 'replaceState'] as const) {
    const original = history[fn]
    history[fn] = function (...args: Parameters<typeof original>) {
      const result = original.apply(this, args)
      setTimeout(notify, 0)
      return result
    }
  }
}

function renderInto(host: HTMLElement, node: React.ReactNode): Root {
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = chipCss
  shadow.appendChild(style)
  const mountPoint = document.createElement('div')
  shadow.appendChild(mountPoint)
  const root = createRoot(mountPoint)
  root.render(node)
  return root
}
