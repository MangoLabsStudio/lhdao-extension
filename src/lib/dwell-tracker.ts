import { sendMessage } from './messaging'

/**
 * Dwell time tracker — 累积当前推文详情页"可见"时长,在用户**离开页面**
 * 时一次性上报。**1 session = 1 行**,简洁直观。
 *
 * 上报触发(只在这些时刻 flush 一次):
 *  - URL 切到另一条推文 / 离开详情页
 *  - tab 关闭 / 浏览器关闭(pagehide / beforeunload)
 *
 * 不上报的:
 *  - tab 切到后台 / 最小化(只 pause,不 flush)
 *  - 切回前台(resume)
 *  - 浏览器崩溃(整段会丢,接受这个边界 — 崩溃极少见,
 *    防护代价是 DB 充满 partial 记录,不值)
 *
 * 隐私边界:仅对 /<user>/status/<id> URL 触发,仅发到 lhdao 自家后端,
 * 默认开启无 opt-out。未绑 token 的用户实际无法上报。
 */

const MIN_DURATION_MS = 500

interface DwellState {
  tweetId: string
  /** 已累积"可见"毫秒数(不含当前未结束的 visible 段) */
  accumulatedMs: number
  /** 当前 visible 段开始时间;null 表示已暂停或未开始 */
  lastVisibleAt: number | null
}

let state: DwellState | null = null

function pause() {
  if (state?.lastVisibleAt) {
    state.accumulatedMs += Date.now() - state.lastVisibleAt
    state.lastVisibleAt = null
  }
}

function resume() {
  if (state && state.lastVisibleAt === null) {
    if (document.visibilityState === 'visible') {
      state.lastVisibleAt = Date.now()
    }
  }
}

function startNew(tweetId: string) {
  flush() // 先 flush 旧的(如果有)
  state = {
    tweetId,
    accumulatedMs: 0,
    lastVisibleAt: document.visibilityState === 'visible' ? Date.now() : null,
  }
  console.log('[lhdao dwell] start', tweetId)
}

/**
 * 结算当前 dwell 并清空 state。≥ 500ms 才发后端。
 * **1 session = 调 1 次 = 写 1 行**,无 partial。
 */
function flush() {
  if (!state) return
  pause()
  const { tweetId, accumulatedMs } = state
  state = null

  if (accumulatedMs >= MIN_DURATION_MS) {
    console.log('[lhdao dwell] flush', tweetId, accumulatedMs, 'ms')
    try {
      void sendMessage({
        type: 'record-dwell',
        tweetId,
        durationMs: Math.floor(accumulatedMs),
      })
    } catch {
      // 扩展已 reload 等极端场景,无能为力
    }
  } else {
    console.log(
      '[lhdao dwell] skip',
      tweetId,
      accumulatedMs,
      'ms (< 500ms threshold)',
    )
  }
}

/**
 * 给 content script 入口调一次。绑定 visibilitychange / pagehide /
 * beforeunload。
 *
 * **不绑 blur/focus** — 用户切到其他窗口但 tab 仍 visible 时,blur 会
 * 错误暂停,严重欠采集。只用 visibilitychange 判定 tab 是否真后台/最小化。
 *
 * **不**自动启动 tracking — 启动靠 onDwellUrlChange()。
 */
export function initDwellTracker() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume()
    else pause()
  })
  // pagehide 比 beforeunload 更可靠(后者 SPA 不一定触发);两个都绑保险。
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
}

/**
 * URL 切换(SPA pushState / replaceState / popstate)时调一次。
 * 传入 currentFocalTweetId(从 URL 解析的当前焦点推文 id,无则 null)。
 *
 * 三种情况:
 *  - 新 id != 老 id → flush 老的,start 新的
 *  - 新 id == 老 id → 不动(用户从推文 photo 子页面回来等情况)
 *  - 新 id === null(离开详情页)→ flush 老的
 */
export function onDwellUrlChange(focalTweetId: string | null) {
  if (state?.tweetId === focalTweetId) return // unchanged
  if (focalTweetId == null) {
    flush()
  } else {
    startNew(focalTweetId)
  }
}
