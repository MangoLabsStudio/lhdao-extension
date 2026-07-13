import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
// ⚠ ?inline 让 Vite 把 chip.css 走 PostCSS + Tailwind 4 编译流程返回**编译后**
// 的 CSS 字符串。用 ?raw 会拿到字面量 `@import 'tailwindcss'`,Shadow DOM
// 里浏览器把它当无效 URL,Tailwind utilities 全失效 (SVG 退回默认 300x150
// 等 bug)。
import chipCss from '@/components/chip/chip.css?inline'
import highlightCss from '@/components/chip/highlight.css?inline'
import { MetadataBadge } from '@/components/chip/MetadataBadge'
import { ProfileFollowCard } from '@/components/profile/ProfileFollowCard'
import {
  PromoteButton,
  PromoteDialog,
  promoteButtonCss,
  promoteDialogCss,
} from '@/components/promote/PromoteDialog'
import { CurrentTaskSection } from '@/components/sidebar/CurrentTaskSection'
import sidebarCss from '@/components/sidebar/sidebar.css?inline'
import { initDwellTracker, onDwellUrlChange } from '@/lib/dwell-tracker'
import { sendMessage } from '@/lib/messaging'
import type { LighthouseMember } from '@/lib/queries'
import { type CampaignTaskCache, localStore } from '@/lib/storage'
import {
  extractAuthorHandleFromArticle,
  extractTweetIdFromArticle,
  findAuthorAvatarLink,
} from '@/lib/twitter-dom'

/**
 * Content script — 在 X (Twitter) timeline / 详情页"织入"灯塔任务的视觉信号。
 *
 * 3 个注入点(per article):
 *   ① article 本身 → data-lhdao-active="1" 触发 highlight.css 的背景+ring
 *   ② <time> 旁 → MetadataBadge (Shadow DOM, "🗼 +N LUX")
 *   ③ 匹配任务的 Twitter action button → data-lhdao-glow 触发 halo
 *
 * 1, 3 不用 React — 文档级 CSS 选择器命中即可。
 * 2 用 Shadow DOM 隔离我们的 Tailwind 样式不污染 Twitter。
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
  // FOLLOW 的 glow 不挂在 article 内任何 Twitter 原生按钮上 —— timeline 上
  // 没有 follow button(只有进 profile 页才有)。FOLLOW 的视觉是头像 ring,
  // 在 mountArticle 单独处理(findAuthorAvatarLink),不走 glow selector 路径。
  FOLLOW: [],
}

// ── per-article state ──────────────────────────────────────────────

const ARTICLE_FLAG = 'data-lhdao-active'

interface MountedArticle {
  article: Element
  hosts: HTMLElement[]
  roots: Root[]
  glowedButtons: Element[]
  /** 挂载时这条 article 是否是焦点推文(URL 在 /status/<id> 上)。
   *  用于 scanTimeline 在 SPA 导航后做 focal reconcile。 */
  isFocal: boolean
  /** 头像 ring 视觉的目标 <a>(已贴 data-lhdao-follow-ring)。unmount 时清属性 */
  ringedAvatars: Element[]
}

const mounted = new Map<string, MountedArticle>() // key = tweetId or `follow:<handle>`
/** tweetId 的 get-tasks RPC await 期间的占位,防止 race 导致双挂载 */
const inFlight = new Set<string>()

/**
 * Content-side 本地任务快照,scanTimeline 同步查 — 避免 per-article
 * `await sendMessage()` 累加成肉眼可见的延迟(20 条推文 × ~30ms ≈ 600ms)。
 *
 * 刷新时机:
 *   1. content script 启动 (refreshTasksSnapshot in main())
 *   2. 收到 BG 广播 'tasks-updated' (每次 syncTasks 完成时)
 *
 * null 时 scan 跳过(还在初始化 / 拉取中),下一帧 MutationObserver 再触发。
 */
let tasksSnapshot: {
  byTweet: Record<string, CampaignTaskCache[]>
  byAuthor: Record<string, CampaignTaskCache[]>
} | null = null

async function refreshTasksSnapshot(): Promise<void> {
  if (contextDead) return
  try {
    const r = await sendMessage({ type: 'get-tasks-snapshot' })
    if (r.type === 'tasks-snapshot') {
      const tweetCount = Object.keys(r.byTweet).length
      const authorCount = Object.keys(r.byAuthor).length
      console.log(
        `[lhdao] snapshot loaded: ${tweetCount} tweets, ${authorCount} authors`,
      )
      tasksSnapshot = { byTweet: r.byTweet, byAuthor: r.byAuthor }
      // 拿到新数据立刻重扫 — Twitter 滚动可能已经有 article 等着挂
      scheduleScan()
    } else {
      console.warn('[lhdao] snapshot unexpected response shape', r)
    }
  } catch (e) {
    if (!handleContextError(e)) {
      console.warn('[lhdao] snapshot fetch failed', e)
    }
  }
}

/**
 * MV3 service worker 启动后可能需要 100-500ms 才能响应第一次 sendMessage,
 * 偶尔甚至完全错过(SW 还在初始化 alarm/listener)。content script
 * 启动时单次调用容易踩这个坑 → tasksSnapshot 永远是 null → scan 永远
 * silent return → 用户看不到任何 chip 也看不到任何 error。
 *
 * 防御:启动后多次延时重试,任一拿到就停。已拿到则后续 retry no-op。
 */
function bootstrapSnapshot() {
  void refreshTasksSnapshot()
  for (const delay of [200, 800, 2500]) {
    setTimeout(() => {
      if (tasksSnapshot) return
      void refreshTasksSnapshot()
    }, delay)
  }
}

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

    // Feature B — 加载用户的"屏蔽 sensitive 推文"偏好(默认开)
    void loadSensitivePref()

    // 反作弊 dwell tracker:对所有 /<user>/status/<id> 推文详情页累积可见
    // 时长,URL 离开 / tab 关 时通过 BG 上报后端。绑 visibility / focus /
    // blur / pagehide / beforeunload。
    initDwellTracker()
    // 初始进入页面:如果 URL 就在 status,立即开始计时
    onDwellUrlChange(
      getFocalTweetId(),
      getFocalFullUrl(),
      getFocalAuthorHandle(),
    )

    const observer = new MutationObserver(scheduleScan)
    observer.observe(document.body, { childList: true, subtree: true })

    // 启动时立刻拉一次 snapshot + 多次重试兜底 SW 冷启动失败。
    bootstrapSnapshot()
    scheduleScan()

    // SPA 导航监听:Twitter 用 pushState 切换路由,焦点 tweet id 会变,
    // 已挂载的 article 需要重算 focal —— 把 badge 挪到当前焦点 article。
    //
    // 关键 timing bug:pushState 触发的瞬间,Twitter 尚未渲染新 article DOM,
    // 单次 rAF scan 命中不了新页面的推文。MutationObserver 理论上能捕到
    // 后续插入,但实测 timeline → detail 切换偶尔遗漏。叠加多次 setTimeout
    // 重扫做兜底,scan 内部有 mounted Map 去重,多扫不会重复挂。
    watchUrlChanges(() => {
      // 通知 dwell tracker URL 变了 — 切走当前 tweet 则 flush 上报,
      // 切到新 tweet 则开始累积。handle 在 URL change 的瞬间 article
      // 还没渲染,getFocalAuthorHandle() 可能返回 null;后续 scanTimeline
      // 会再次调用 onDwellUrlChange 把 handle 补上(同 id 升级 metadata)。
      onDwellUrlChange(
        getFocalTweetId(),
        getFocalFullUrl(),
        getFocalAuthorHandle(),
      )
      // 不再 unmountAll() — 那会让所有 article 闪一下再挂回来。
      // 让 scanTimeline 里的 focal-reconcile 自己处理:focal 状态变了的
      // article 会被 unmount,下一帧 scan 在当前焦点(detail 页)的 article
      // 节点上重挂 badge/glow/ring。
      // 4 次延时 scan 留着,detail 页 article DOM 渲染晚需要重试。
      scheduleScan()
      setTimeout(scheduleScan, 100)
      setTimeout(scheduleScan, 400)
      setTimeout(scheduleScan, 1000)
      setTimeout(scheduleScan, 2000)
    })

    // 每 5 秒兜底 safety sweep —— 只做 stale flag 清理,**不再主动**
    // scheduleScan。
    //
    // 原因:MutationObserver 监听 document.body 的 childList+subtree 已
    // 经覆盖了 99% 的场景。主动 scheduleScan 在 timeline 静止时也强行
    // 扫一遍,加大了"高亮闪动"的发生概率(任何 scan 都可能触发 focal
    // reconcile / DOM 操作)。让 observer + URL 变化 / tasks-updated
    // 广播来驱动扫描,sweep 只负责清残留属性。
    setInterval(() => {
      for (const a of document.querySelectorAll(`[${ARTICLE_FLAG}]`)) {
        const tweetId = extractTweetIdFromArticle(a)
        if (tweetId && !mounted.has(tweetId) && !inFlight.has(tweetId)) {
          a.removeAttribute(ARTICLE_FLAG)
        }
      }
    }, 5000)

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'tasks-updated') {
        // 拉新 snapshot — refreshTasksSnapshot 内部会 scheduleScan,
        // 不需要再 unmountAll(scanTimeline 自己有 stale + focal reconcile)。
        // 老做法 unmountAll 会让所有 chip 闪一下重挂,视觉不好。
        void refreshTasksSnapshot()
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
  requestAnimationFrame(() => {
    rafScheduled = false
    scanTimeline()
    void scanProfilePage()
    scanProfileFollowTask()
    scanSensitive()
    scanPromoteButtons()
    void scanMemberLogos()
  })
}

// ── 灯塔成员 logo(时间线作者 handle 后;评论区/回复区不展示)────────
const MEMBER_LOGO_FLAG = 'data-lhdao-member-logo'
const MEMBER_LOGO_BUSY = 'data-lhdao-member-logo-busy'

/**
 * 是否「评论区」article(切记不展示 logo)。
 * 详情页(URL 带 /status/<focal>)里非焦点 article = 回复/评论 → 评论区。
 * 非详情页(home / profile / search / list)= 时间线 → false。
 */
function isCommentArticle(article: Element): boolean {
  const focal = getFocalTweetId()
  if (!focal) return false
  const tid = extractTweetIdFromArticle(article)
  return !!tid && tid !== focal
}

async function scanMemberLogos(): Promise<void> {
  if (contextDead) return
  const byHandle = new Map<string, Element[]>()
  for (const article of document.querySelectorAll('article')) {
    if (article.getAttribute(MEMBER_LOGO_FLAG)) continue
    if (article.getAttribute(MEMBER_LOGO_BUSY)) continue
    if (!isArticleRenderable(article)) continue
    if (article.parentElement?.closest('article')) continue // 跳过嵌套引用推
    if (isCommentArticle(article)) continue // 评论区不展示
    const handle = extractAuthorHandleFromArticle(article)
    if (!handle) continue
    if (!byHandle.has(handle)) byHandle.set(handle, [])
    byHandle.get(handle)?.push(article)
  }
  if (byHandle.size === 0) return

  for (const arts of byHandle.values())
    for (const a of arts) a.setAttribute(MEMBER_LOGO_BUSY, '1')

  try {
    const r = await sendMessage({
      type: 'check-lighthouse-members',
      handles: Array.from(byHandle.keys()),
    })
    if (r.type !== 'lighthouse-members-result') return
    for (const [handle, arts] of byHandle.entries()) {
      const isMember = !!r.members[handle]
      for (const art of arts) {
        art.removeAttribute(MEMBER_LOGO_BUSY)
        art.setAttribute(MEMBER_LOGO_FLAG, isMember ? 'yes' : 'no')
        if (isMember) attachMemberLogo(art)
      }
    }
  } catch (e) {
    for (const arts of byHandle.values())
      for (const a of arts) a.removeAttribute(MEMBER_LOGO_BUSY)
    if (handleContextError(e)) return
  }
}

/** 在作者 @handle 后插入灯塔 logo(Shadow DOM 隔离)。 */
function attachMemberLogo(article: Element): void {
  const userName = article.querySelector('[data-testid="User-Name"]')
  if (!userName) return
  if (userName.querySelector('[data-lhdao-member-logo-host]')) return

  // 放在蓝 V(verified badge)后面;没有蓝 V 的成员则放在名字后面
  // (两种都在 @handle 之前)。
  const anchor =
    userName.querySelector(
      '[data-testid="icon-verified"], svg[aria-label*="认证"], svg[aria-label*="Verified"]',
    ) ?? userName.querySelector('a[role="link"]')

  const host = document.createElement('span')
  host.setAttribute('data-lhdao-member-logo-host', '')
  host.style.display = 'inline-flex'
  host.style.alignItems = 'center'
  host.style.verticalAlign = 'middle'
  host.style.margin = '0 3px'
  const iconUrl = chrome.runtime.getURL('icon/128.png')
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `<style>:host{all:initial}img{width:15px;height:15px;border-radius:50%;display:block}</style><img src="${iconUrl}" alt="灯塔成员" title="灯塔成员" />`

  if (anchor) anchor.insertAdjacentElement('afterend', host)
  else userName.appendChild(host)
}

/**
 * 判断 article 是否在用户能看到的位置(viewport 内 / display 没被 SPA 隐藏)。
 *
 * Twitter SPA timeline → detail 切换时,旧 timeline article 常常仍在 DOM
 * 树里(放在 history stack 后台)但 ancestor 被 display:none / 容器尺寸
 * 为 0。我们用 offsetParent + getBoundingClientRect 综合判断。
 *
 * `display:none` → offsetParent === null
 * 完全在视口外滚动 → boundingRect 高度 > 0(看不见但仍可挂载,等用户滚回来)
 * 我们认为只要不是 display:none/visibility:hidden 就算可挂载
 */
function isArticleRenderable(article: Element): boolean {
  if (!(article instanceof HTMLElement)) return true // 保守:不是 HTMLElement 就当可见
  if (article.offsetParent === null) {
    // display:none / 任何祖先 display:none
    // 但 position:fixed 的 offsetParent 也是 null,所以再核对一下 bounding
    const rect = article.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return false
  }
  return true
}

// 诊断 log 策略:**只在数量变化时**输出,避免静止页面刷屏 + 同时让用户
// 看到完整时间线(0 → 7 → 12...)。两个数字之一变化都打。
// 便于一眼定位"为什么 chip 不显示":
//   - 持续 0 articles → DOM selector 错了 / Twitter 改 DOM 了
//   - 7 articles, 0 matched → 后端 tweetId 跟页面对不上
//   - N articles, M>0 matched → 匹配上了,如果还没 chip 就是 mount 失败
let lastScanArticleCount = -1
let lastScanMatchedCount = -1
function logScanDiag(articleCount: number, matchedCount: number) {
  if (
    articleCount === lastScanArticleCount &&
    matchedCount === lastScanMatchedCount
  ) {
    return
  }
  lastScanArticleCount = articleCount
  lastScanMatchedCount = matchedCount
  console.log(
    `[lhdao] scan: ${articleCount} articles on page, ${matchedCount} matched tasks`,
  )
}

function scanTimeline() {
  // 没拿到任务快照前不扫(refreshTasksSnapshot 拉完会自动 scheduleScan)
  if (!tasksSnapshot) {
    // 第一次没 snapshot 时 log 一次,后续重复跳过(只在状态转变到非空时再 log)
    if (lastScanArticleCount !== -2) {
      lastScanArticleCount = -2
      console.log('[lhdao] scan skipped: snapshot not ready yet')
    }
    return
  }

  const { byTweet, byAuthor } = tasksSnapshot

  // —— 1. 清扫 stale 挂载 + focal 状态 reconcile ─────────────────
  // 两种需要重新挂的情况:
  //   a) Twitter SPA 把同 tweetId 的 article DOM 换了节点(timeline 卡
  //      → 详情页 article)。旧的 article.isConnected === false。
  //   b) URL 焦点切了(/status/<a> → /status/<b> 或退到 /home),
  //      badge 需要从旧焦点 article 节点挪到新焦点 article 节点。
  //      用 state.isFocal !== 当前 isFocal 判定。
  //   c) 旧的 mounted article 不再可见(SPA 隐藏 timeline article),
  //      需要 unmount 让 scan 重新选可见的同 tweetId article 挂。
  const currentFocal = getFocalTweetId()

  // —— Dwell metadata 升级 ——
  // URL change 时 article 可能还没渲染,onDwellUrlChange 第一次调时 handle
  // 是 null。每次 scanTimeline 跑时再调一遍(dwell-tracker 内对 null 字段
  // 做无打断升级),把 article 渲染好后能拿到的 handle 补上。
  if (currentFocal) {
    onDwellUrlChange(currentFocal, getFocalFullUrl(), getFocalAuthorHandle())
  }

  for (const [tweetId, state] of mounted.entries()) {
    const stale = !state.article.isConnected
    const focalChanged = state.isFocal !== (currentFocal === tweetId)
    const hidden = !stale && !isArticleRenderable(state.article)
    if (stale || focalChanged || hidden) {
      unmountArticle(state)
      mounted.delete(tweetId)
    }
  }

  // —— 2. 按 tweetId 分组,每组只挑最优 article(可见 > 焦点 > 首个)——
  // SPA 切换时同 tweetId 的多个 article 可能并存(timeline + detail),如果
  // 直接 for-each 第一个,可能挂到了用户看不到的那条。
  const articleByTweetId = new Map<string, Element>()
  const articles = document.querySelectorAll('article')
  for (const article of articles) {
    if (article.hasAttribute(ARTICLE_FLAG)) continue
    const tweetId = extractTweetIdFromArticle(article)
    if (!tweetId) continue
    if (mounted.has(tweetId) || inFlight.has(tweetId)) continue

    const existing = articleByTweetId.get(tweetId)
    if (!existing) {
      articleByTweetId.set(tweetId, article)
      continue
    }
    // 已有 candidate,挑更优的:可见 > 焦点匹配 > 当前位置靠后
    const existingVisible = isArticleRenderable(existing)
    const candVisible = isArticleRenderable(article)
    if (candVisible && !existingVisible) {
      articleByTweetId.set(tweetId, article)
      continue
    }
    if (!candVisible && existingVisible) continue
    // 两者可见度相同时,焦点页 article 优先
    const isFocal = currentFocal === tweetId
    if (isFocal) {
      // detail 页 article 通常 DOM 位置靠后(主推文渲染晚于回复区域),
      // 用 sourceOrder 后者覆盖前者达成"更新的 article 胜出"
      articleByTweetId.set(tweetId, article)
    }
  }

  // —— 3. 同步挂载每条 article(查 local cache,无 RPC,无 await)——
  let matchedCount = 0
  for (const [tweetId, article] of articleByTweetId.entries()) {
    const authorHandle = extractAuthorHandleFromArticle(article)

    const tweetTasks = byTweet[tweetId] ?? []
    const authorTasks = authorHandle ? (byAuthor[authorHandle] ?? []) : []

    // 合并 by (campaignId, actionType) — 同一 follow campaign 可能既在
    // byTweet 又在 byAuthor(它是来源推文的同时也是 follow 目标)
    const seen = new Set<string>()
    const allTasks: CampaignTaskCache[] = []
    for (const t of tweetTasks) {
      const key = `${t.campaignId}:${t.actionType}`
      if (seen.has(key)) continue
      seen.add(key)
      allTasks.push(t)
    }
    for (const t of authorTasks) {
      const key = `${t.campaignId}:${t.actionType}`
      if (seen.has(key)) continue
      seen.add(key)
      allTasks.push(t)
    }

    if (allTasks.length === 0) continue
    matchedCount += 1

    article.setAttribute(ARTICLE_FLAG, '1')
    const state = mountArticle(article, allTasks, tweetId, authorHandle)
    if (state) {
      mounted.set(tweetId, state)
    } else {
      article.removeAttribute(ARTICLE_FLAG)
    }
  }

  logScanDiag(articleByTweetId.size, matchedCount)
}

// ── mount / unmount ─────────────────────────────────────────────────

function mountArticle(
  article: Element,
  tasks: CampaignTaskCache[],
  currentTweetId: string,
  authorHandle: string | null,
): MountedArticle | null {
  const focalTweetId = getFocalTweetId()
  const isFocal = focalTweetId != null && focalTweetId === currentTweetId

  const state: MountedArticle = {
    article,
    hosts: [],
    roots: [],
    glowedButtons: [],
    ringedAvatars: [],
    isFocal,
  }

  // —— 拆分任务来源 ——
  // followTasks → 头像 ring 视觉;nonFollowTasks(LIKE/RT/COMMENT)→ 高亮
  // Twitter 原生动作按钮。抢单按钮已下线,无 claim/ownedFollow 计算。
  const followTasks = tasks.filter((t) => t.actionType === 'FOLLOW')
  const nonFollowTasks = tasks.filter((t) => t.actionType !== 'FOLLOW')

  try {
    // ② Metadata badge — 顶部 caret 旁。展示**总奖励**,所有 tasks 都纳入计算。
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

    // ②.5 Inline task card — 仅焦点推文(详情页主推文)且有任务时,把完整任务卡
    // (检测→停留→验证发奖)内联到动作栏正下方。锚在这条推文的 DOM 上:稳定、有
    // 上下文、不占右栏、不和其它扩展/X 布局抢位(取代旧的右栏当前任务段)。随
    // state.hosts/roots 在 unmountArticle 一并清理;focal 变化时 scanTimeline 会
    // unmount 重挂到新焦点推文。
    if (isFocal && tasks.length > 0) {
      const actionRow = article.querySelector('[role="group"]')
      if (actionRow?.parentElement) {
        const taskHost = createShadowHost('lhdao-inline-task', 'inline')
        taskHost.style.display = 'block'
        taskHost.style.width = '100%'
        taskHost.style.margin = '8px 0 4px'
        actionRow.parentElement.insertBefore(taskHost, actionRow.nextSibling)
        const taskRoot = renderInto(
          taskHost,
          createElement(CurrentTaskSection),
          sidebarCss,
        )
        state.hosts.push(taskHost)
        state.roots.push(taskRoot)
      }
    }

    // ③ Action button glow — 高亮 Twitter 原生 like/retweet/reply 按钮。
    // FOLLOW 在 ACTION_TYPE_TO_SELECTOR 是空数组,不参与 glow。
    for (const t of nonFollowTasks) {
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

    // ③.5 Avatar ring — FOLLOW 任务的视觉信号,贴 data-lhdao-follow-ring
    // 到该作者头像 link。所有同作者 article 都贴(Q2=c)。
    if (authorHandle && followTasks.length > 0) {
      const avatarLink = findAuthorAvatarLink(article, authorHandle)
      if (avatarLink && !avatarLink.hasAttribute('data-lhdao-follow-ring')) {
        avatarLink.setAttribute('data-lhdao-follow-ring', '1')
        state.ringedAvatars.push(avatarLink)
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
  // 策略 1:Twitter 通常用的 caret testid(timeline / detail 都常见)
  const byTestId = article.querySelector('[data-testid="caret"]')
  if (byTestId) return byTestId

  // 策略 2:本地化无关的 aria-label fallback
  const byMore = article.querySelector('[aria-label="More"]')
  if (byMore) return byMore

  // 策略 3:popup-menu button **但要排除 action row 里的**。
  //
  // 详情页主推文 article 经常没有 [data-testid="caret"](caret 在 article
  // 外面的工具栏),策略 1/2 fall through。直接 `button[aria-haspopup="menu"]`
  // 会**误命中 action row 里的 retweet 按钮**(点击弹出 Repost/Quote 菜单,
  // 也带 aria-haspopup="menu"),导致 badge 挂到了 reply 和 RT 之间 — 用户
  // 实测踩过这个 bug。
  //
  // role="group" 是 Twitter action row(reply/RT/like/bookmark/share)的
  // 标准容器,排除掉就只剩顶部菜单按钮。
  const candidates = article.querySelectorAll('button[aria-haspopup="menu"]')
  for (const c of Array.from(candidates)) {
    if (!c.closest('[role="group"]')) return c
  }
  return null
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
  for (const avatar of state.ringedAvatars) {
    avatar.removeAttribute('data-lhdao-follow-ring')
  }
  state.article.removeAttribute(ARTICLE_FLAG)
}

function unmountAll() {
  for (const state of mounted.values()) {
    unmountArticle(state)
  }
  mounted.clear()
  inFlight.clear()
  unmountFollowCard()
  // 兜底:清理 stale 标记(article 可能已离开 DOM)+ 拖延 host(若有)
  for (const a of document.querySelectorAll(`[${ARTICLE_FLAG}]`)) {
    a.removeAttribute(ARTICLE_FLAG)
  }
  for (const a of document.querySelectorAll('[data-lhdao-follow-ring]')) {
    a.removeAttribute('data-lhdao-follow-ring')
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

/**
 * 当前页面是详情页时返回**规范化后**的完整推文 URL — 删去 /photo/N、
 * /analytics 等子路径以及 query string,只保留 `https://x.com/<user>/status/<id>`。
 * 不是详情页返回 null。dwell tracker 用它存进 DB 让分析后台直接呈现。
 */
function getFocalFullUrl(): string | null {
  const m = location.pathname.match(/^(\/[^/]+\/status\/\d+)/)
  if (!m) return null
  return `${location.origin}${m[1]}`
}

/**
 * 详情页主推文作者的 handle(无 @,小写)。从顶层 article 的 User-Name
 * 区抽取。article 还没渲染时返回 null,onDwellUrlChange 会在 scanTimeline
 * 之后再调一次把 handle 补上。
 */
function getFocalAuthorHandle(): string | null {
  const articles = document.querySelectorAll('article')
  for (const a of articles) {
    // 顶层 article(无 article 祖先)= 主推文,不是嵌套引用推文
    if (a.parentElement?.closest('article')) continue
    const handle = extractAuthorHandleFromArticle(a)
    if (handle) return handle
  }
  return null
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

// ── 一键推广按钮(每条推文动作行注入)──────────────────────────────
const PROMOTE_FLAG = 'data-lhdao-promote'

function scanPromoteButtons(): void {
  if (contextDead) return
  for (const article of document.querySelectorAll('article')) {
    if (article.getAttribute(PROMOTE_FLAG)) continue
    if (!isArticleRenderable(article)) continue
    const tweetId = extractTweetIdFromArticle(article)
    if (!tweetId) continue
    const actionRow = article.querySelector('[role="group"]')
    if (!actionRow) continue
    article.setAttribute(PROMOTE_FLAG, '1')
    const handle = extractAuthorHandleFromArticle(article)
    const tweetUrl = handle
      ? `https://x.com/${handle}/status/${tweetId}`
      : `https://x.com/i/status/${tweetId}`
    const host = createShadowHost('lhdao-promote', 'inline-flex')
    host.style.alignItems = 'center'
    actionRow.appendChild(host)
    renderInto(
      host,
      createElement(PromoteButton, {
        onOpen: () => openPromoteDialog(tweetUrl),
      }),
      promoteButtonCss,
    )
  }
}

function openPromoteDialog(tweetUrl: string): void {
  const host = createShadowHost('lhdao-promote-dialog', 'inline')
  host.style.position = 'fixed'
  host.style.inset = '0'
  host.style.zIndex = '2147483647'
  document.body.appendChild(host)
  let root: Root | null = null
  const onClose = () => {
    root?.unmount()
    host.remove()
  }
  root = renderInto(
    host,
    createElement(PromoteDialog, { tweetUrl, onClose }),
    promoteDialogCss,
  )
}

// ════════════════════════════════════════════════════════════════════════
// Lighthouse member tagging — Feature A
// ════════════════════════════════════════════════════════════════════════
//
// 只在 Profile 页(URL 是 /<handle>):成员则在 bio 下方注入 badge。
//
// (timeline / 评论区的逐条 article "灯塔成员" chip 已下线 — 不再在 feed
//  和评论列表里标注成员。)
//
// BG SW 维护 LRU cache(5min TTL),content 这边不缓存。

const RESERVED_TWITTER_PATHS = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'bookmarks',
  'lists',
  'profile',
  'settings',
  'login',
  'logout',
  'signup',
  'search',
  'compose',
  'i',
  'about',
  'tos',
  'privacy',
  'jobs',
  'help',
  'communities',
  'topics',
  'verified-followers',
  'connect_people',
  'following',
  'followers',
])

// ── Profile page badge ──────────────────────────────────────────────

const PROFILE_BADGE_FLAG_SELECTOR = '[data-lhdao-profile-badge]'
let lastProfileHandle: string | null = null
let lastProfileResult: LighthouseMember | null = null

async function scanProfilePage(): Promise<void> {
  if (contextDead) return
  const handle = extractProfileHandleFromUrl(location.pathname)

  // URL 不是 profile 页 → 移除任何残留 badge
  if (!handle) {
    document.querySelectorAll(PROFILE_BADGE_FLAG_SELECTOR).forEach((el) => {
      el.remove()
    })
    lastProfileHandle = null
    lastProfileResult = null
    return
  }

  // 换了 profile?清旧 badge
  if (handle !== lastProfileHandle) {
    document.querySelectorAll(PROFILE_BADGE_FLAG_SELECTOR).forEach((el) => {
      el.remove()
    })
    lastProfileHandle = handle
    lastProfileResult = null
  }

  // 还没拿过 result → 查
  if (lastProfileResult === null) {
    // 标 placeholder 防止并发重复 RPC(用一个 module-level promise)
    if (profilePagePending === handle) return
    profilePagePending = handle
    try {
      const r = await sendMessage({
        type: 'check-lighthouse-members',
        handles: [handle],
      })
      if (r.type === 'lighthouse-members-result') {
        lastProfileResult = r.members[handle] ?? null
      }
    } catch (e) {
      if (handleContextError(e)) return
    } finally {
      if (profilePagePending === handle) profilePagePending = null
    }
  }

  // 非成员 → 不挂 badge
  if (!lastProfileResult) return

  // 找 bio anchor
  const bio = document.querySelector('[data-testid="UserDescription"]')
  if (!bio?.parentElement) {
    // bio 可能还没渲染,下次 rAF 再试
    return
  }
  if (bio.parentElement.querySelector(PROFILE_BADGE_FLAG_SELECTOR)) return

  attachProfileBadge(bio, lastProfileResult)
}

let profilePagePending: string | null = null

function extractProfileHandleFromUrl(pathname: string): string | null {
  // 只匹配纯 /<handle> 或 /<handle>/(没有 /status/ 等子路径)
  // X 用户 handle 规则:1-15 字符,字母数字下划线
  const m = pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)
  if (!m) return null
  const handle = m[1].toLowerCase()
  if (RESERVED_TWITTER_PATHS.has(handle)) return null
  return handle
}

// ── [profile 关注任务卡] 被关注目标的主页:高亮原生「关注」按钮 + 注入任务卡 ──
let followCardState: {
  host: HTMLElement
  root: Root
  handle: string
} | null = null
let glowedFollowBtn: Element | null = null

/** 找 profile 头部的原生「关注」按钮(testid 以 -follow 结尾;已关注是 -unfollow)。
 *  限定在 primaryColumn 内,避开「谁值得关注」侧栏。 */
function findFollowButton(): HTMLElement | null {
  const scope =
    document.querySelector('[data-testid="primaryColumn"]') ?? document
  return (
    scope.querySelector<HTMLElement>('[data-testid$="-follow"]') ??
    scope.querySelector<HTMLElement>('button[aria-label^="Follow @"]') ??
    scope.querySelector<HTMLElement>('button[aria-label^="关注 @"]')
  )
}

/** 给关注按钮贴 glow 属性(CSS 在 highlight.css);换按钮/消失时清旧的。 */
function glowFollowButton(): boolean {
  const btn = findFollowButton()
  if (glowedFollowBtn && glowedFollowBtn !== btn) {
    glowedFollowBtn.removeAttribute('data-lhdao-follow-glow')
    glowedFollowBtn = null
  }
  if (btn && !btn.hasAttribute('data-lhdao-follow-glow')) {
    btn.setAttribute('data-lhdao-follow-glow', '1')
    glowedFollowBtn = btn
  }
  return !!btn
}

function unmountFollowCard(): void {
  if (glowedFollowBtn) {
    glowedFollowBtn.removeAttribute('data-lhdao-follow-glow')
    glowedFollowBtn = null
  }
  if (followCardState) {
    try {
      followCardState.root.unmount()
    } catch {
      // ignore
    }
    followCardState.host.remove()
    followCardState = null
  }
  document.querySelectorAll('[data-lhdao-follow-card]').forEach((el) => {
    el.remove()
  })
}

function scanProfileFollowTask(): void {
  if (contextDead) return
  const handle = extractProfileHandleFromUrl(location.pathname)
  const followTask =
    handle && tasksSnapshot
      ? (tasksSnapshot.byAuthor[handle] ?? []).find(
          (t) => t.actionType === 'FOLLOW',
        )
      : undefined

  // 不是 profile 页 / 该主页无关注任务 / 换了目标 → 清理旧卡
  if (!handle || !followTask) {
    unmountFollowCard()
    return
  }
  if (followCardState && followCardState.handle !== handle) {
    unmountFollowCard()
  }

  // 每次 scan 都兜底高亮(X 会重渲染按钮)
  const btnPresent = glowFollowButton()

  // 已挂且卡还在 DOM 里 → 不重复挂
  if (followCardState?.host.isConnected) return
  // 状态残留但节点被 X 重渲染冲掉 → 卸载后重挂
  if (followCardState) unmountFollowCard()

  // 锚点:UserName 区块(profile 头部,始终存在);未渲染则下轮 rAF 再试
  const anchor = document.querySelector('[data-testid="UserName"]')
  if (!anchor?.parentElement) return
  if (document.querySelector('[data-lhdao-follow-card]')) return

  const host = createShadowHost('lhdao-follow-card', 'inline-block')
  host.style.display = 'block'
  host.style.width = '100%'
  host.setAttribute('data-lhdao-follow-card', '1')
  anchor.parentElement.insertBefore(host, anchor.nextSibling)
  const root = renderInto(
    host,
    createElement(ProfileFollowCard, {
      campaignId: followTask.campaignId,
      targetHandle: handle,
      reward: followTask.expectedReward,
      reserved: followTask.reserved === true,
      followButtonPresent: btnPresent,
    }),
    // 隔离页面 CSS 继承(font/color 等),但保 block 让卡片占满宽度
    ':host{all:initial;display:block}',
  )
  followCardState = { host, root, handle }
}

function attachProfileBadge(bioEl: Element, member: LighthouseMember): void {
  if (!bioEl.parentElement) return

  const host = document.createElement('div')
  host.setAttribute('data-lhdao-profile-badge', '')
  host.style.marginTop = '8px'

  const shadow = host.attachShadow({ mode: 'open' })
  const tier = member.tier ?? '—'
  const iconUrl = chrome.runtime.getURL('icon/128.png')
  shadow.innerHTML = `
    <style>${PROFILE_BADGE_CSS}</style>
    <div class="badge">
      <img class="mark" src="${iconUrl}" alt="" />
      <div class="text">
        <div class="title">Lighthouse 成员</div>
        <div class="sub">
          TIER ${escapeHtml(tier)} · ${escapeHtml(member.displayName)}
        </div>
      </div>
    </div>
  `
  // 挂到 bio 后(同级 sibling)
  bioEl.parentElement.insertBefore(host, bioEl.nextSibling)
}

const PROFILE_BADGE_CSS = `
  :host { all: initial; display: block; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px 7px 8px;
    background: linear-gradient(135deg,
      oklch(0.97 0.025 195) 0%,
      oklch(0.99 0.01 195) 100%);
    border: 1px solid oklch(0.92 0.06 195);
    border-radius: 12px;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont,
      'Segoe UI', 'PingFang SC', system-ui, sans-serif;
  }
  .mark {
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 50%;
  }
  .text { display: flex; flex-direction: column; gap: 2px; }
  .title {
    font-size: 13px;
    font-weight: 700;
    color: #0F172A;
    line-height: 1.1;
  }
  .sub {
    font-size: 11px;
    font-weight: 500;
    color: #475569;
    letter-spacing: 0.01em;
  }
  @media (prefers-color-scheme: dark) {
    .badge {
      background: linear-gradient(135deg,
        oklch(0.22 0.03 195) 0%,
        oklch(0.20 0.015 195) 100%);
      border-color: oklch(0.30 0.04 195);
    }
    .title { color: oklch(0.95 0.01 195); }
    .sub { color: oklch(0.70 0.02 240); }
  }
`

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ════════════════════════════════════════════════════════════════════════
// Feature B — Sensitive (NSFW / 软色情等) 推文屏蔽
// ════════════════════════════════════════════════════════════════════════
//
// 用户在 Options 里翻开关 hideSensitiveTweets(default true)。开着的话:
//
//   1. scanSensitive() 找所有 article 里 [data-testid] 含 "sensitive"
//      或者 "contentWarning" 的子节点 — 这是 X 自家系统标过的"成人/
//      血腥/敏感内容"
//   2. 命中的 article 贴 data-lhdao-hide-sensitive
//   3. highlight.css 里的 selector 把整条 display:none
//
// 关掉开关 → 清掉所有 data-lhdao-hide-sensitive 属性,X 立即恢复原显示。
//
// 实现走 X 自家标识 + display:none,完全不读 / 改 X 自己的样式或 DOM,
// 跟 Shadow DOM 隔离策略一致。

let sensitiveHideOn = true // 默认开,等 loadSensitivePref 读真实值

async function loadSensitivePref(): Promise<void> {
  if (contextDead) return
  try {
    const v = await localStore.get('hideSensitiveTweets')
    // null / undefined → 默认 true(初次安装行为)
    sensitiveHideOn = v !== false
  } catch (e) {
    if (handleContextError(e)) return
    // 读取失败保持默认 true
  }
}

function scanSensitive(): void {
  if (contextDead) return

  // 关着 → 一次性清掉残留 hide attribute,X 立即恢复
  if (!sensitiveHideOn) {
    for (const a of document.querySelectorAll(
      'article[data-lhdao-hide-sensitive]',
    )) {
      a.removeAttribute('data-lhdao-hide-sensitive')
    }
    return
  }

  // 开着 → 扫所有 article 找 sensitive 标识
  //
  // X 标识有几种变体:
  //   - [data-testid="sensitive-media-warning"]   单图被遮罩
  //   - [data-testid="contentWarning"]            整推被遮罩
  //   - 其他 testid 含 "sensitive" 的子组件
  //
  // 用 attribute selector 含 "sensitive" 一网打尽,加上 contentWarning。
  // case-insensitive (i) 防 X 改大小写。
  for (const article of document.querySelectorAll('article')) {
    if (article.hasAttribute('data-lhdao-hide-sensitive')) continue
    const hit =
      article.querySelector('[data-testid*="sensitive" i]') ||
      article.querySelector('[data-testid="contentWarning"]')
    if (hit) {
      article.setAttribute('data-lhdao-hide-sensitive', '1')
    }
  }
}

// 监听 storage 变化 — Options 切换开关时立即生效,不需要刷页
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if ('hideSensitiveTweets' in changes) {
    sensitiveHideOn = changes.hideSensitiveTweets.newValue !== false
    scanSensitive()
  }
})
