import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Chip } from '@/components/chip/Chip'
import chipCss from '@/components/chip/chip.css?raw'
import { sendMessage } from '@/lib/messaging'
import { extractTweetIdFromArticle } from '@/lib/twitter-dom'

/**
 * Content script — 注入 X (Twitter) timeline,扫描 article DOM 并挂 chip。
 *
 * 流程:
 *   1. MutationObserver 监听整个 document.body 的 childList/subtree 变化
 *   2. 任何变化都 schedule 一次 scanTimeline (rAF debounce,避免抖)
 *   3. scanTimeline 找未处理的 <article>,问 BG 该 tweet 是否有任务
 *   4. 有则在 article 末尾挂 Shadow DOM,渲染 <Chip>
 *   5. BG 广播 tasks-updated → 强制重扫(不再清掉已处理标记,
 *      因为 chip 完成后会通过自身重渲染消失)
 */

const CHIP_ATTR = 'data-lhdao-chip-mounted'
const HOST_ATTR = 'data-lhdao-chip-host'

interface MountedChip {
  host: HTMLDivElement
  root: Root
}

/** 已挂载的 chip,key = tweetId,用于 tasks-updated 时定向更新 */
const mountedChips = new Map<string, MountedChip>()

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  cssInjectionMode: 'manifest',
  runAt: 'document_idle',

  async main() {
    // 监听 timeline 上 article 的进出
    const observer = new MutationObserver(scheduleScan)
    observer.observe(document.body, { childList: true, subtree: true })

    // 启动时立刻扫一次 (twitter SPA 可能已渲染部分 article)
    scheduleScan()

    // BG 广播任务更新 → 强制重扫(可能新出现任务,或旧任务移除)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'tasks-updated') {
        // 移除所有已挂的 chip,等下一轮 scan 重建
        // 这样新增的 tweet 会拿到任务,完成的会消失
        for (const { host, root } of mountedChips.values()) {
          root.unmount()
          host.remove()
        }
        mountedChips.clear()

        // 同时清掉 article 上的 mounted 标记,允许重新挂载
        for (const article of document.querySelectorAll(`[${CHIP_ATTR}]`)) {
          article.removeAttribute(CHIP_ATTR)
        }
        scheduleScan()
      }
    })
  },
})

// ── scan ─────────────────────────────────────────────────────────────

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
    if (article.hasAttribute(CHIP_ATTR)) continue
    const tweetId = extractTweetIdFromArticle(article)
    if (!tweetId) continue

    const r = await sendMessage({ type: 'get-tasks-for-tweet', tweetId })
    if (r.type !== 'tasks' || r.tasks.length === 0) continue

    // 标记 + 挂载
    article.setAttribute(CHIP_ATTR, '1')
    const mounted = injectChip(article, r.tasks)
    if (mounted) mountedChips.set(tweetId, mounted)
  }
}

// ── inject ───────────────────────────────────────────────────────────

function injectChip(
  article: Element,
  tasks: Parameters<typeof Chip>[0]['tasks'],
): MountedChip | null {
  try {
    const host = document.createElement('div')
    host.setAttribute(HOST_ATTR, '1')
    article.appendChild(host)

    const shadow = host.attachShadow({ mode: 'open' })

    // 把 Tailwind 编译过的 chip.css inject 进 shadow root
    const style = document.createElement('style')
    style.textContent = chipCss
    shadow.appendChild(style)

    const mountPoint = document.createElement('div')
    shadow.appendChild(mountPoint)

    const root = createRoot(mountPoint)
    root.render(createElement(Chip, { tasks }))

    return { host, root }
  } catch (e) {
    console.warn('[lhdao] injectChip failed', e)
    return null
  }
}
