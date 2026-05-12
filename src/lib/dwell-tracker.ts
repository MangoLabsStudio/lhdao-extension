import { sendMessage } from './messaging'

/**
 * Dwell time tracker — 累积当前推文详情页"可见"时长,在用户离开时上报。
 *
 * 设计:
 *  - 只有 document.visibilityState === 'visible' 时累积(切后台 / 最小化 /
 *    切 tab 都暂停)
 *  - 1 秒以下的会话不上报(过滤误触)
 *  - 切到新推文 / 关 tab / SPA 离开都触发 end → flush
 *  - 上报失败由 BG SW 静默吞掉(用户没绑 token / 网络问题都不打扰)
 *
 * 用户隐私边界(写在这里给 reviewer 看):
 *  - 仅对 /<user>/status/<id> URL 触发
 *  - 数据 (tweetId + durationMs) 仅发到 lhdao 后端,无第三方
 *  - 没有 opt-out — 默认开启(产品决策)
 *  - 未绑 token 的用户实际无法上报(BG SW 会丢弃),构成隐性 opt-in
 */

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
}

/**
 * 结算当前 dwell,如果累积时长 ≥ 1s,通过 BG SW 上报后端。无论是否上报,
 * state 被清空。允许多次调用(幂等)。
 */
function flush() {
  if (!state) return
  pause() // 把当前未结束的 visible 段记入 accumulatedMs
  const { tweetId, accumulatedMs } = state
  state = null

  if (accumulatedMs >= 1000) {
    // 发完即弃 — BG SW 内自己处理 token 缺失 / 网络错
    void sendMessage({
      type: 'record-dwell',
      tweetId,
      durationMs: Math.floor(accumulatedMs),
    })
  }
}

/**
 * 给 content script 入口调一次。绑定 visibilitychange / focus / blur /
 * pagehide / beforeunload。
 *
 * **不**自动启动 tracking — 启动靠 onFocalTweetChange()。
 */
export function initDwellTracker() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume()
    else pause()
  })
  // window blur/focus 比 visibilitychange 粒度更细 (visibilitychange 只
  // 在 tab 真的隐藏时触发,blur 在窗口失焦时即触发)
  window.addEventListener('blur', pause)
  window.addEventListener('focus', resume)
  // pagehide 比 beforeunload 更可靠(后者不一定触发,尤其 navigate 时)
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
