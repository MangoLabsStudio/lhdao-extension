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
    watchUrlChanges(() => {
      unmountAll()
      scheduleScan()
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
  const articles = document.querySelectorAll('article')
  for (const article of articles) {
    if (article.hasAttribute(ARTICLE_FLAG)) continue
    const tweetId = extractTweetIdFromArticle(article)
    if (!tweetId) continue
    if (mounted.has(tweetId)) continue

    const r = await sendMessage({ type: 'get-tasks-for-tweet', tweetId })
    if (r.type !== 'tasks' || r.tasks.length === 0) continue

    article.setAttribute(ARTICLE_FLAG, '1')
    const state = mountArticle(article, r.tasks, tweetId)
    if (state) mounted.set(tweetId, state)
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
    // ② Metadata badge (after time element)
    const timeEl = article.querySelector('time')
    const headerAnchor = timeEl?.closest('a') ?? timeEl?.parentElement
    if (headerAnchor?.parentElement) {
      const host = createShadowHost('lhdao-badge', 'inline')
      headerAnchor.parentElement.insertBefore(host, headerAnchor.nextSibling)
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
  // 兜底:清理 stale 标记(article 可能已离开 DOM)
  for (const a of document.querySelectorAll(`[${ARTICLE_FLAG}]`)) {
    a.removeAttribute(ARTICLE_FLAG)
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
