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
import { SidebarCard } from '@/components/sidebar/SidebarCard'
import sidebarCss from '@/components/sidebar/sidebar.css?inline'
import { initDwellTracker, onDwellUrlChange } from '@/lib/dwell-tracker'
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

/** Sidebar 卡片单例挂载状态 (Twitter 任何页面只有一个右侧 sidebar) */
interface SidebarMountedState {
  host: HTMLElement
  root: Root
  anchor: Element
}
let sidebarMounted: SidebarMountedState | null = null

/**
 * 扩展被 reload 后, content script 跟 BG SW 的连接断了 — chrome.runtime
 * 所有调用都会抛 "Extension context invalidated"。这时候继续扫描没意义,
 * 错误日志还会刷屏。检测到一次就 set 这个 flag,所有 entry point 立刻
 * 静默退出 + unmount 所有已挂的视觉元素。用户刷新页面后,新 content
 * script 会从干净状态启动。
 */
let contextDead = false

/**
 * 判断 error 是不是扩展上下文失效。是的话 mark dead + cleanup,返回 true
 * 让调用方退出当前循环。
 */
function handleContextError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  if (
    !/Extension context invalidated|Receiving end does not exist/i.test(msg)
  ) {
    return false
  }
  if (!contextDead) {
    contextDead = true
    console.warn('[lhdao] extension reloaded — refresh this page to recover')
    try {
      unmountAll()
    } catch {
      // ignore
    }
    showReloadHint()
  }
  return true
}

/**
 * 在页面顶部贴一个**不打扰**的小条提示用户刷新。点 × 可关闭。
 * 直接 inline style,不依赖 chip.css / Tailwind (这时候 BG 都没了,
 * 想动态从扩展拿资源也不可能)。
 */
function showReloadHint() {
  if (document.getElementById('lhdao-reload-hint')) return
  const banner = document.createElement('div')
  banner.id = 'lhdao-reload-hint'
  banner.setAttribute('role', 'status')
  banner.style.cssText = [
    'position: fixed',
    'top: 12px',
    'left: 50%',
    'transform: translateX(-50%)',
    'z-index: 2147483647',
    'background: rgb(20, 184, 166)',
    'color: white',
    'font-size: 12.5px',
    'font-weight: 600',
    'font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
    'padding: 6px 10px 6px 14px',
    'border-radius: 999px',
    'box-shadow: 0 4px 14px rgba(20, 184, 166, 0.35)',
    'display: inline-flex',
    'align-items: center',
    'gap: 10px',
    'cursor: default',
  ].join(';')
  banner.innerHTML = `
    <span>🗼 Lighthouse 已更新,刷新页面继续</span>
    <button id="lhdao-reload-btn" type="button" style="
      background: rgba(255,255,255,0.2); color: white; border: none;
      padding: 2px 8px; border-radius: 999px; font: inherit;
      cursor: pointer;">刷新</button>
    <button id="lhdao-dismiss-btn" type="button" aria-label="dismiss" style="
      background: transparent; color: rgba(255,255,255,0.85); border: none;
      cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px;">×</button>
  `
  document.body.appendChild(banner)
  banner.querySelector('#lhdao-reload-btn')?.addEventListener('click', () => {
    location.reload()
  })
  banner.querySelector('#lhdao-dismiss-btn')?.addEventListener('click', () => {
    banner.remove()
  })
}

// (旧的 BottomMissionState 已删除 — submit 按钮现在挂在 article action
// 行而不是 inline composer 旁,生命周期跟 article 一起,不需要单独 state)

// ── entrypoint ──────────────────────────────────────────────────────

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  cssInjectionMode: 'manifest',
  runAt: 'document_idle',

  async main() {
    injectGlobalStyle()

    // 反作弊 dwell tracker:对所有 /<user>/status/<id> 推文详情页累积可见
    // 时长,URL 离开 / tab 关 时通过 BG 上报后端。绑 visibility / focus /
    // blur / pagehide / beforeunload。
    initDwellTracker()
    // 初始进入页面:如果 URL 就在 status,立即开始计时
    onDwellUrlChange(getFocalTweetId())

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
      // 通知 dwell tracker URL 变了 — 切走当前 tweet 则 flush 上报,
      // 切到新 tweet 则开始累积。
      onDwellUrlChange(getFocalTweetId())
      unmountAll()
      scheduleScan()
      setTimeout(scheduleScan, 100)
      setTimeout(scheduleScan, 400)
      setTimeout(scheduleScan, 1000)
      setTimeout(scheduleScan, 2000)
    })

    // 每 3 秒兜底 safety sweep — 防 MutationObserver 漏触发 / DOM 重渲染
    // 导致的"识别不准 / 没高亮"边界情况。scan 内部有 mounted/inFlight 去重,
    // 多扫无副作用。同时清理 stale ARTICLE_FLAG(article 在 DOM 但没挂)。
    setInterval(() => {
      // 清扫 stale ARTICLE_FLAG:有 flag 但 mounted Map 里没记录的 article
      // 说明上次扫挂失败但 flag 残留,移除让下面 scan 重新尝试
      for (const a of document.querySelectorAll(`[${ARTICLE_FLAG}]`)) {
        const tweetId = extractTweetIdFromArticle(a)
        if (tweetId && !mounted.has(tweetId) && !inFlight.has(tweetId)) {
          a.removeAttribute(ARTICLE_FLAG)
        }
      }
      scheduleScan()
    }, 3000)

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
  if (contextDead) return // 扩展已重载,继续扫只会刷屏 invalidated 错误
  if (rafScheduled) return
  rafScheduled = true
  requestAnimationFrame(async () => {
    rafScheduled = false
    await scanTimeline()
    scanSidebar()
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
      // await 期间 article 可能被 Twitter 虚拟化卸下,挂到 detached 节点
      // 看似成功实则用户看不到。这里再确认下还活着才挂。
      if (!article.isConnected) {
        article.removeAttribute(ARTICLE_FLAG)
        continue
      }
      const state = mountArticle(article, r.tasks, tweetId)
      // hosts === 0 说明 caret 没找到 / 关键 anchor 缺失,等于啥都没挂。
      // 放进 mounted Map 会永远 dedup,所以这种情况清掉 flag 等下次 scan
      // 时 DOM 可能已经稳定,再重试。
      if (state && state.hosts.length > 0) {
        mounted.set(tweetId, state)
      } else {
        if (state) unmountArticle(state) // 清理已经贴的 glow 属性
        article.removeAttribute(ARTICLE_FLAG)
      }
    } catch (e) {
      // 扩展 reload 导致的 context invalidated → 全局停止,不再喷错误
      if (handleContextError(e)) {
        inFlight.delete(tweetId)
        article.removeAttribute(ARTICLE_FLAG)
        return // 跳出整个 scan 循环
      }
      // 其他 RPC 异常 → 不能让 ARTICLE_FLAG 残留(否则永久 skip),清干净
      console.warn('[lhdao] scan article failed', tweetId, e)
      article.removeAttribute(ARTICLE_FLAG)
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
    // ② Metadata badge — 顶部右上角 (3-dot caret 菜单的左侧),展示
    // "+N LUX" 奖励信息。Article-level 挂载,timeline 卡片和详情页都有。
    // 注意:submit/claim 按钮**不在这里**,在底部 reply composer 旁
    // (见下方 scanBottomMission),原因:用户做评论类任务时本来就要去
    // 那个 textarea 打字,把 verify 按钮放在那里语境最自然。
    const caretAnchor = findTopRightAnchor(article)
    if (caretAnchor?.parentElement) {
      const host = createShadowHost('lhdao-top', 'inline-flex')
      host.style.alignItems = 'center'
      host.style.marginRight = '6px'
      caretAnchor.parentElement.insertBefore(host, caretAnchor)
      const root = renderInto(host, createElement(MetadataBadge, { tasks }))
      state.hosts.push(host)
      state.roots.push(root)
    }

    // ③ Action button glow — 高亮 Twitter 原生 like/retweet/reply 按钮,
    // 引导用户先去做动作再回来 verify。
    for (const t of tasks) {
      for (const sel of ACTION_TYPE_TO_SELECTOR[t.actionType] ?? []) {
        const btn = article.querySelector(sel)
        if (btn && !btn.hasAttribute('data-lhdao-glow')) {
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

    // ④ Submit button — **仅在焦点推文** (URL 匹配 /status/<id>) 的
    // action button 行末尾挂。
    //
    // 为什么是 action 行而不是 reply composer 旁:
    //   - composer 在用户点 "回复" 时会被 Twitter 卸成模态对话框,
    //     React unmount → 状态丢失 → 倒计时 / reserved 全清零
    //   - action 行 (reply / RT / like / share) 是焦点推文的稳定子节点,
    //     用户点 reply 后这一行**仍然可见**(模态在上方覆盖,article 没卸)
    //   - 视觉上也紧挨用户要做的 like / RT / reply 按钮,做完动作不用挪眼
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
 * 找推文头部右上角的锚点 — 3-dot 菜单 (data-testid="caret") 的元素本身,
 * 调用方 `insertBefore(host, caret)` 让我们的 group 出现在它左边。
 *
 * fallback:有些视图 caret 在子层,用 [aria-label="More"] 也能命中。
 */
function findTopRightAnchor(article: Element): Element | null {
  const caret =
    article.querySelector('[data-testid="caret"]') ??
    article.querySelector('[aria-label="More"]') ??
    article.querySelector('button[aria-haspopup="menu"]')
  return caret as Element | null
}

/**
 * 找推文底部的 action button 行(包含 reply / RT / like / bookmark / share
 * 的横排 role="group" 容器)。submit/claim 按钮塞到这一行最后,跟原生
 * action 同排。
 */
function findActionRow(article: Element): Element | null {
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
  unmountSidebar()
  // 兜底:清理 stale 标记(article 可能已离开 DOM)+ 拖延 host(若有)
  for (const a of document.querySelectorAll(`[${ARTICLE_FLAG}]`)) {
    a.removeAttribute(ARTICLE_FLAG)
  }
  for (const h of document.querySelectorAll('[data-lhdao-host="1"]')) {
    h.remove()
  }
}

// ── Sidebar card injection ──────────────────────────────────────────

/**
 * 找 Twitter 右侧 sidebar 的"订阅 Premium"卡片(或 "Subscribe to
 * Premium"英文版),作为 anchor 插我们卡片到它**上方**。
 *
 * 探测策略(任一命中即返回):
 *   1. [data-testid="sidebarColumn"] 内含 "订阅 Premium"/"Premium"/
 *      "Subscribe" 文本的最近 section/div
 *   2. [aria-label*="Premium"] 元素 (升级 banner 自身)
 *   3. 兜底:sidebarColumn 内第一个 section
 */
function findSidebarPremiumAnchor(): {
  anchor: Element
  parent: Element
} | null {
  const sidebar = document.querySelector('[data-testid="sidebarColumn"]')
  if (!sidebar) return null

  // 候选 1: aria-label
  const premiumByAria = sidebar.querySelector(
    'aside[aria-label*="Premium" i], section[aria-label*="Premium" i]',
  )
  if (premiumByAria?.parentElement) {
    return { anchor: premiumByAria, parent: premiumByAria.parentElement }
  }

  // 候选 2: 找 sidebar 内含有"Premium"文本的最外层卡片块
  // Twitter sidebar 内部结构通常是嵌套 div,卡片之间是 flex column sibling。
  // 找文本节点再向上爬到 parent of "search box section"
  const candidates = sidebar.querySelectorAll('section, aside, div')
  for (const el of candidates) {
    if (
      el.children.length > 0 &&
      el.parentElement &&
      /订阅\s*Premium|Subscribe to Premium|Subscribe\s*$/i.test(
        el.textContent?.slice(0, 100) ?? '',
      )
    ) {
      // 向上找到 sidebar 下"卡片级"的容器 — 通常是 sidebar 的孙子级
      let card: Element = el
      while (
        card.parentElement &&
        card.parentElement !== sidebar &&
        !card.parentElement.matches('[data-testid="sidebarColumn"] > div')
      ) {
        card = card.parentElement
        // 不向上超过 5 层防越界
        if (card.parentElement === sidebar) break
      }
      if (card.parentElement) {
        return { anchor: card, parent: card.parentElement }
      }
    }
  }

  // 候选 3 (兜底):sidebar 内第一个 section
  const firstSection = sidebar.querySelector('section')
  if (firstSection?.parentElement) {
    return { anchor: firstSection, parent: firstSection.parentElement }
  }

  return null
}

function scanSidebar() {
  if (contextDead) return

  // 已经挂好且 anchor 仍在 DOM → 不动
  if (
    sidebarMounted &&
    sidebarMounted.host.isConnected &&
    sidebarMounted.anchor.isConnected
  ) {
    return
  }

  // 老 host 失效 → 拆掉
  if (sidebarMounted && !sidebarMounted.host.isConnected) {
    unmountSidebar()
  }

  // 找新 anchor
  const found = findSidebarPremiumAnchor()
  if (!found) return // sidebar 还没渲染出来,下一轮 scan 再来

  const host = createShadowHost('lhdao-sidebar', 'inline')
  host.style.display = 'block'
  host.style.width = '100%'
  found.parent.insertBefore(host, found.anchor)
  const root = renderInto(host, createElement(SidebarCard), sidebarCss)
  sidebarMounted = { host, root, anchor: found.anchor }
}

function unmountSidebar() {
  if (!sidebarMounted) return
  try {
    sidebarMounted.root.unmount()
  } catch {
    // ignore
  }
  sidebarMounted.host.remove()
  sidebarMounted = null
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

function renderInto(
  host: HTMLElement,
  node: React.ReactNode,
  css: string = chipCss,
): Root {
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = css
  shadow.appendChild(style)
  const mountPoint = document.createElement('div')
  shadow.appendChild(mountPoint)
  const root = createRoot(mountPoint)
  root.render(node)
  return root
}
