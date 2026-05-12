import { sendMessage } from './messaging'

/**
 * Dwell time tracker — 累积当前推文详情页"可见"时长,在用户离开 / 关 tab
 * 时上报,以及每 30 秒部分上报一次(heartbeat,防极端情况丢数据)。
 *
 * 设计要点:
 *
 *  - **只**用 `visibilitychange` 判定 pause/resume,不绑 blur/focus —
 *    blur 会在用户切到 DevTools 或其他 OS 窗口时错误暂停,严重欠采集。
 *    visibility 只在 tab 真后台 / 最小化时为 hidden,语义最合理。
 *  - 500ms 起步过滤(之前 1s,后改成 500ms 多收集快速划过的会话)。
 *  - 30s heartbeat:长 session 期间每 30 秒"部分 flush"一次(发出后
 *    清零累积器,继续计时)。这样浏览器崩溃 / 强关 tab 也只丢最后 30s,
 *    而不是整段 session。
 *  - 多条 partial 记录在 backend 侧聚合(SUM durationMs by user+tweet)。
 *
 * 隐私边界:仅对 /<user>/status/<id> URL 触发,仅发到 lhdao 自家后端,
 * 默认开启无 opt-out(产品决策)。未绑 token 的用户实际无法上报(BG
 * SW 会丢弃),构成隐性 opt-in。
 */

const MIN_DURATION_MS = 500
const HEARTBEAT_MS = 30_000

interface DwellState {
  tweetId: string
  /** 已累积"可见"毫秒数(不含当前未结束的 visible 段) */
  accumulatedMs: number
  /** 当前 visible 段开始时间;null 表示已暂停或未开始 */
  lastVisibleAt: number | null
}

let state: DwellState | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

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
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS)
  }
}

/**
 * 30 秒一次部分 flush — 把当前累积时长发出去,然后**清零累积器继续计时**。
 * 长 session 会变成多条记录(后端 SUM 聚合得到总时长)。
 *
 * 极端场景保护:用户读了 5 分钟 → 浏览器崩溃 / 强关 tab → pagehide 没
 * 触发 → 整段会丢。有 heartbeat 后只丢最后 30s 内的,前面的都安全。
 */
function heartbeat() {
  if (!state) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    return
  }
  pause() // 把当前未结束的 visible 段算入 accumulatedMs
  const ms = state.accumulatedMs
  if (ms >= MIN_DURATION_MS) {
    console.log('[lhdao dwell] heartbeat', state.tweetId, ms, 'ms (partial)')
    try {
      void sendMessage({
        type: 'record-dwell',
        tweetId: state.tweetId,
        durationMs: Math.floor(ms),
      })
    } catch {
      // ignore — 扩展已 reload 等,无能为力
    }
  }
  // 清零继续计时(下个 30s 又是一个新 segment)
  state.accumulatedMs = 0
  resume()
}

/**
 * 结算当前 dwell 并清空 state。≥ 500ms 才发后端。
 */
function flush() {
  if (!state) return
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  pause()
  const { tweetId, accumulatedMs } = state
  state = null

  if (accumulatedMs >= MIN_DURATION_MS) {
    console.log('[lhdao dwell] flush', tweetId, accumulatedMs, 'ms (final)')
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
  // pagehide 比 beforeunload 更可靠(后者不一定触发,尤其 SPA navigate);
  // 但两个都绑,多一道保险。
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
