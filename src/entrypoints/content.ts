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
import {
  extractAuthorHandleFromArticle,
  extractTweetIdFromArticle,
  findAuthorAvatarLink,
} from '@/lib/twitter-dom'

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
   *  用于 scanTimeline 在 SPA 导航后做 focal reconcile —— focal 状态
   *  变了的 article 需要 unmount 重挂(添加/移除 SubmitButton)。 */
  isFocal: boolean
  /** 头像 ring 视觉的目标 <a>(已贴 data-lhdao-follow-ring)。unmount 时清属性 */
  ringedAvatars: Element[]
  /** 这条 article 是否承担"该 FOLLOW campaign 的 claim 入口"角色 */
  followClaimCampaignIds: string[]
}

const mounted = new Map<string, MountedArticle>() // key = tweetId or `follow:<handle>`
/** tweetId 的 get-tasks RPC await 期间的占位,防止 race 导致双挂载 */
const inFlight = new Set<string>()

/**
 * 跨 article 的 FOLLOW campaign 去重:某条 follow campaign 的 claim 按钮
 * 仅挂在 timeline 上**第一次扫到**(`mounted` 里第一次出现)的 article。
 * 后续同作者的 article 只挂头像 ring,不再挂 claim,避免视觉刷屏。
 *
 * 注意 trade-off:如果该首条 article 因虚拟化滚动被 Twitter 回收,我们
 * 通过 scanTimeline 的 stale cleanup 把它从 mounted Map 移除并 release
 * 这里对应的 campaignId,下一帧扫到下一条同作者 article 时会重新成为
 * "首条",claim 按钮顺势挪过去。
 */
const followClaimMountedFor = new Map<string, Element>() // campaignId → article element

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
      // 不再 unmountAll() — 那会让所有 article 闪一下再挂回来。
      // 让 scanTimeline 里的 focal-reconcile 自己处理:
      //   - 旧焦点 article 的 state.isFocal=true 但当前 URL 焦点变了
      //     → reconcile 检测到不一致,unmount 它(去掉 SubmitButton)
      //   - 新焦点 article 同理,unmount 然后下一帧 scan 重挂(加 button)
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
  // —— 1. 清扫 stale 挂载 + focal 状态 reconcile ─────────────────
  // 两种需要重新挂的情况:
  //   a) Twitter SPA 把同 tweetId 的 article DOM 换了节点(timeline 卡
  //      → 详情页 article)。旧的 article.isConnected === false。
  //   b) URL 焦点切了(/status/<a> → /status/<b> 或退到 /home),
  //      旧焦点 article 需要去掉 SubmitButton,新焦点需要补上
  //      SubmitButton。用 state.isFocal !== 当前 isFocal 判定。
  //
  // FOLLOW 额外清理:从 mounted 移除时,顺带释放 followClaimMountedFor
  // 里属于这条 article 的 campaignId,让下次 scan 时下一个还活着的同
  // 作者 article 接过 claim 角色。
  const currentFocal = getFocalTweetId()
  for (const [tweetId, state] of mounted.entries()) {
    const stale = !state.article.isConnected
    const focalChanged = state.isFocal !== (currentFocal === tweetId)
    if (stale || focalChanged) {
      releaseFollowClaim(state)
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
      // 双查:tweet-level tasks (LIKE/RT/COMMENT/COMMENT_LIKE + 来源推文上
      // 的 FOLLOW) + author-level tasks (跨该作者所有推文的 FOLLOW)。
      const authorHandle = extractAuthorHandleFromArticle(article)
      const [tweetTasksRes, followTasksRes] = await Promise.all([
        sendMessage({ type: 'get-tasks-for-tweet', tweetId }),
        authorHandle
          ? sendMessage({
              type: 'get-tasks-for-author',
              authorHandle,
            })
          : Promise.resolve({ type: 'tasks' as const, tasks: [] }),
      ])

      const tweetTasks =
        tweetTasksRes.type === 'tasks' ? tweetTasksRes.tasks : []
      const authorTasks =
        followTasksRes.type === 'tasks' ? followTasksRes.tasks : []

      // 合并 by campaignId(同一 follow campaign 可能既在 byTweet 又在
      // byAuthor 里出现,跟来源推文重合的情况)
      const seen = new Set<string>()
      const allTasks: CampaignTaskCache[] = []
      for (const t of [...tweetTasks, ...authorTasks]) {
        const key = `${t.campaignId}:${t.actionType}`
        if (seen.has(key)) continue
        seen.add(key)
        allTasks.push(t)
      }

      if (allTasks.length === 0) {
        article.removeAttribute(ARTICLE_FLAG)
        continue
      }
      // await 期间 article 可能被 Twitter 虚拟化卸下,挂到 detached 节点
      // 看似成功实则用户看不到。这里再确认下还活着才挂。
      if (!article.isConnected) {
        article.removeAttribute(ARTICLE_FLAG)
        continue
      }
      const state = mountArticle(article, allTasks, tweetId, authorHandle)
      // 即使 hosts.length === 0(caret 没找到/广告卡/Spaces 等异形 article)
      // 也要进 mounted Map + 保留 ARTICLE_FLAG。glow 属性已经贴在原生
      // like/RT/reply 按钮上,部分挂载也算成功,放回 Map 让后续 stale
      // cleanup 能清。
      //
      // 历史 bug:这里曾在 hosts.length===0 时 unmountArticle(清 glow)+
      // 清 flag,导致 Twitter 在 article 子树里任何 DOM 变更(媒体懒加载/
      // 计数刷新)触发 MutationObserver → 同条 article 又被扫到 → 又贴
      // glow → 又清 → ......高亮在所有"异形 article"上肉眼可见的闪动。
      if (state) {
        mounted.set(tweetId, state)
      } else {
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
    followClaimCampaignIds: [],
    isFocal,
  }

  // —— 拆分任务来源 ——
  // followTasks 全部都贴 ring(Q2=c:每条同作者 article 都加 ring 视觉)。
  // 但 claim 按钮 dedup:某 follow campaign 的 claim 已经被别的 article
  // 占了 → 这条 article 不挂 claim。本 article 是首次承担 claim 的
  // followCampaigns 进入 ownedFollowTasks。
  const followTasks = tasks.filter((t) => t.actionType === 'FOLLOW')
  const ownedFollowTasks: CampaignTaskCache[] = []
  for (const t of followTasks) {
    const owner = followClaimMountedFor.get(t.campaignId)
    if (owner && owner !== article && owner.isConnected) {
      // 已被别人占,跳过 claim(ring 还会挂)
      continue
    }
    // 占下 claim 角色
    followClaimMountedFor.set(t.campaignId, article)
    state.followClaimCampaignIds.push(t.campaignId)
    ownedFollowTasks.push(t)
  }

  const nonFollowTasks = tasks.filter((t) => t.actionType !== 'FOLLOW')

  // claim 按钮的 tasks 集合:
  //   - 来源推文上的 LIKE/RT/COMMENT/COMMENT_LIKE:仅在 isFocal (detail 页) 显示
  //   - FOLLOW 的 ownedFollowTasks:无论 isFocal 都显示(timeline 上头像旁可点)
  const claimTasks: CampaignTaskCache[] = [
    ...(isFocal ? nonFollowTasks : []),
    ...ownedFollowTasks,
  ]

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

    // ④ Submit button — 决定逻辑:
    //   - isFocal (detail 页): 含所有 LIKE/RT/COMMENT + 本 article 拥有的 FOLLOW
    //   - timeline (非 isFocal): 仅当本 article 拥有 FOLLOW claim 才挂
    //
    // 挂载位置:
    //   - isFocal 走 action row(reply / RT / like 按钮同行,稳定不会被
    //     compose 模态卸载,原 LIKE/RT 任务的语境)
    //   - timeline-FOLLOW 走 action row 同样位置,跟 detail 页保持一致
    if (claimTasks.length > 0) {
      const actionRow = findActionRow(article)
      if (actionRow) {
        const host = createShadowHost('lhdao-submit', 'inline-flex')
        host.style.alignItems = 'center'
        actionRow.appendChild(host)
        const root = renderInto(
          host,
          createElement(SubmitButton, { tasks: claimTasks }),
        )
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
 * 该 article 被 unmount / 离开 DOM 之前,从全局 follow claim 注册表里
 * 释放它认领过的 campaignId,让下一次 scan 时下一个还活着的同作者 article
 * 接过 claim 角色。
 */
function releaseFollowClaim(state: MountedArticle) {
  for (const campaignId of state.followClaimCampaignIds) {
    const current = followClaimMountedFor.get(campaignId)
    if (current === state.article) {
      followClaimMountedFor.delete(campaignId)
    }
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
  for (const avatar of state.ringedAvatars) {
    avatar.removeAttribute('data-lhdao-follow-ring')
  }
  state.article.removeAttribute(ARTICLE_FLAG)
}

function unmountAll() {
  for (const state of mounted.values()) {
    releaseFollowClaim(state)
    unmountArticle(state)
  }
  mounted.clear()
  inFlight.clear()
  followClaimMountedFor.clear()
  unmountSidebar()
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
  if (sidebarMounted?.host.isConnected && sidebarMounted?.anchor.isConnected) {
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
