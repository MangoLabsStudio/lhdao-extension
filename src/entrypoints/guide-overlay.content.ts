// ─────────────────────────────────────────────────────────────────────────
// [引导悬浮窗] ISOLATED content script:详情页命中任务 → 挂悬浮窗;监听 capture
// 的 __lhcap 累积已完成动作 + 自计可见停留;达标解锁验证;调 reserve/verify RPC。
// 复用 capture.content(MAIN)已发的 __lhcap,不新增捕获逻辑。停留用本脚本自己
// 的可见计时器(content-script 间模块 state 不共享,也避免重复 record-dwell)。
// ─────────────────────────────────────────────────────────────────────────
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GuideOverlay, type GuidePhase } from '@/components/guide/GuideOverlay'
import guideCss from '@/components/guide/guide-overlay.css?inline'
import { computeGuideState, requiredActionsFor } from '@/lib/guide-state'
import { sendMessage } from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'

const DWELL_GOAL_MS = 10_000

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  world: 'ISOLATED',
  runAt: 'document_end',
  main() {
    let focalTweetId: string | null = null
    let task: CampaignTaskCache | null = null
    let host: HTMLElement | null = null
    let root: Root | null = null
    const detected = new Set<string>()
    let phase: GuidePhase = 'unreserved'
    let busy = false
    let errorMsg: string | undefined
    let successReward: number | undefined
    let collapsed = false
    let visibleMs = 0
    let lastVisibleAt: number | null =
      document.visibilityState === 'visible' ? Date.now() : null

    function currentDwellMs(): number {
      return visibleMs + (lastVisibleAt ? Date.now() - lastVisibleAt : 0)
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        lastVisibleAt = Date.now()
      } else if (lastVisibleAt) {
        visibleMs += Date.now() - lastVisibleAt
        lastVisibleAt = null
      }
    })

    function focalIdFromUrl(): string | null {
      const m = location.pathname.match(/\/status\/(\d+)/)
      return m ? m[1] : null
    }

    function dismissedKey(id: string): string {
      return `lhdao-guide-dismissed:${id}`
    }

    function render() {
      if (!root || !task) return
      const state = computeGuideState(
        task.actionType,
        detected,
        currentDwellMs(),
        DWELL_GOAL_MS,
      )
      root.render(
        createElement(GuideOverlay, {
          reward: task.expectedReward,
          phase,
          state,
          goalMs: DWELL_GOAL_MS,
          busy,
          errorMsg,
          successReward,
          collapsed,
          onReserve: doReserve,
          onVerify: doVerify,
          onDismiss: doDismiss,
          onToggleCollapse: () => {
            collapsed = !collapsed
            render()
          },
        }),
      )
    }

    async function doReserve() {
      if (!task || busy) return
      busy = true
      errorMsg = undefined
      render()
      try {
        const r = await sendMessage({
          type: 'reserve-task',
          campaignId: task.campaignId,
        })
        if (r.type === 'reserve-result' && r.ok) {
          phase = 'detecting'
        } else if (r.type === 'reserve-result') {
          errorMsg = r.message
        }
      } catch {
        errorMsg = '预约失败,请重试'
      }
      busy = false
      render()
    }

    async function doVerify() {
      if (!task || busy) return
      busy = true
      errorMsg = undefined
      render()
      try {
        const r = await sendMessage({
          type: 'verify-task',
          campaignId: task.campaignId,
        })
        if (r.type === 'verify-result' && r.ok) {
          successReward = r.reward
          phase = 'success'
        } else if (r.type === 'verify-result') {
          errorMsg = r.message
        }
      } catch {
        errorMsg = '验证失败,请重试'
      }
      busy = false
      render()
    }

    function doDismiss() {
      if (focalTweetId) {
        try {
          sessionStorage.setItem(dismissedKey(focalTweetId), '1')
        } catch {}
      }
      unmount()
    }

    function mount() {
      if (host) return
      host = document.createElement('div')
      host.id = 'lhdao-guide-host'
      const shadow = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = guideCss
      shadow.appendChild(style)
      const mountPoint = document.createElement('div')
      shadow.appendChild(mountPoint)
      document.body.appendChild(host)
      root = createRoot(mountPoint)
      render()
    }

    function unmount() {
      try {
        root?.unmount()
      } catch {}
      host?.remove()
      root = null
      host = null
    }

    function resetState() {
      detected.clear()
      phase = 'unreserved'
      busy = false
      errorMsg = undefined
      successReward = undefined
      collapsed = false
      visibleMs = 0
      lastVisibleAt = document.visibilityState === 'visible' ? Date.now() : null
    }

    async function onFocalChange() {
      const id = focalIdFromUrl()
      if (id === focalTweetId) return
      focalTweetId = id
      unmount()
      task = null
      resetState()
      if (!id) return
      try {
        if (sessionStorage.getItem(dismissedKey(id)) === '1') return
      } catch {}
      let tasksForTweet: CampaignTaskCache[] = []
      try {
        const snap = await sendMessage({ type: 'get-tasks-snapshot' })
        // 快速切推竞态:await 期间焦点可能已变;若已被更晚的 onFocalChange 取代,
        // 直接放弃(否则会给上一条推挂错窗,且 mount 的 if(host)return 会让旧窗胜出)。
        if (focalTweetId !== id) return
        if (snap.type === 'tasks-snapshot') {
          tasksForTweet = snap.byTweet[id] ?? []
        }
      } catch {}
      if (tasksForTweet.length === 0) return
      task = [...tasksForTweet].sort(
        (a, b) => b.expectedReward - a.expectedReward,
      )[0]
      mount()
    }

    window.addEventListener('message', (e) => {
      if (e.source !== window) return
      const d = e.data as
        | { __lhcap?: boolean; action?: Record<string, unknown> }
        | undefined
      if (!d || d.__lhcap !== true || !d.action || !task) return
      const a = d.action
      const at = typeof a.actionType === 'string' ? a.actionType : ''
      const required = requiredActionsFor(task.actionType)
      if (!(required as string[]).includes(at)) return
      const hit =
        at === 'FOLLOW'
          ? typeof a.handle === 'string' &&
            a.handle.toLowerCase() === (task.targetUsername ?? '').toLowerCase()
          : typeof a.tweetId === 'string' && a.tweetId === focalTweetId
      if (!hit) return
      detected.add(at)
      render()
    })

    setInterval(() => {
      if (root && task && phase === 'detecting' && !collapsed) render()
    }, 250)

    let lastPath = location.pathname
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname
        void onFocalChange()
      }
    }, 500)

    void onFocalChange()
  },
})
