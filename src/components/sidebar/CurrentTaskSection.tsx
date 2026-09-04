import * as React from 'react'
import { LighthouseSelectedText } from '@/components/lighthouse/LighthouseSelectedText'
import {
  type CurrentCampaign,
  computeGuideStateForActions,
  groupCampaigns,
} from '@/lib/guide-state'
import { sendMessage } from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'

/**
 * Sidebar 卡片「当前任务」段 — 嵌入 SidebarCard 身份卡与底部指标之间。
 *
 * 打开一条挂任务的推文详情页 → 本段自动出现:显示该推文奖励最高的 campaign、
 * 要完成的动作清单、停留进度;复用 MAIN-world capture 发的 `__lhcap` 自动打勾 +
 * 自计可见停留;全部达标解锁「验证发奖」→ verify 成功显开箱徽章。
 *
 * 没有「预约」步(预约在任务广场/站内已完成,打开即已参与);离开该推文自动重置。
 * 不在任务推文页时 return null(整段隐藏,卡片回到原样)。
 *
 * 检测/验证只是前端 UX 预判 —— 最终发奖以后端为权威。
 */

const DWELL_GOAL_MS = 10_000
const FOCAL_POLL_MS = 500
const DWELL_TICK_MS = 250
// 验证成功后自动打开任务广场标签页的延时,给用户看一眼"已提交"再开。
const TASK_HALL_OPEN_MS = 2500

type Phase = 'detecting' | 'success'

function focalIdFromUrl(): string | null {
  const m = location.pathname.match(/\/status\/(\d+)/)
  return m ? m[1] : null
}

/**
 * 详情页 URL 首段即主推文作者 handle(`/<author>/status/<id>`)。用于查
 * `byAuthor[handle]` —— 纯 FOLLOW 单(无 targetUrl)只落在 byAuthor,取作者
 * 才能命中,和 content.ts 的 chip 逻辑保持一致。`/i/status/<id>` 这类返回 'i',
 * byAuthor 查不到无副作用。
 */
function focalAuthorFromUrl(): string | null {
  const m = location.pathname.match(/^\/([^/]+)\/status\/\d+/)
  return m ? m[1].toLowerCase() : null
}

export function CurrentTaskSection({
  onRewarded,
}: {
  onRewarded?: () => void
}) {
  const [focalId, setFocalId] = React.useState<string | null>(() =>
    focalIdFromUrl(),
  )
  const accountGeneration = React.useRef(0)
  const [accountVersion, setAccountVersion] = React.useState(0)
  const [campaign, setCampaign] = React.useState<CurrentCampaign | null>(null)
  // 显式加载态:'loading' = 正在为当前焦点推文拉/归并任务(显骨架);
  // 'ready' = 已尘埃落定(拿到任务 or 确认无任务)。此前用 campaign===null
  // 兼表两义 → 拉取窗口整段空白(「偶发性不显示加载」)。
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [detected, setDetected] = React.useState<Set<string>>(() => new Set())
  const [dwellMs, setDwellMs] = React.useState(0)
  const [phase, setPhase] = React.useState<Phase>('detecting')
  const [busy, setBusy] = React.useState(false)
  const [errorMsg, setErrorMsg] = React.useState<string | undefined>(undefined)

  // 可见停留计时(refs 累计,focal 变则归零)
  const visibleMsRef = React.useRef(0)
  const lastVisibleAtRef = React.useRef<number | null>(
    document.visibilityState === 'visible' ? Date.now() : null,
  )

  React.useEffect(() => {
    const onAccountChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || !('apiToken' in changes)) return
      accountGeneration.current++
      setCampaign(null)
      setDetected(new Set())
      setPhase('detecting')
      setAccountVersion(accountGeneration.current)
    }
    chrome.storage.onChanged.addListener(onAccountChange)
    return () => chrome.storage.onChanged.removeListener(onAccountChange)
  }, [])

  // ── 焦点推文轮询(URL /status/<id>) ──
  React.useEffect(() => {
    const id = setInterval(() => {
      const next = focalIdFromUrl()
      setFocalId((prev) => (prev === next ? prev : next))
    }, FOCAL_POLL_MS)
    return () => clearInterval(id)
  }, [])

  // ── 焦点变化:重置全部状态 + 拉该推任务并归并 ──
  React.useEffect(() => {
    setCampaign(null)
    setDetected(new Set())
    setDwellMs(0)
    setPhase('detecting')
    setBusy(false)
    setErrorMsg(undefined)
    setStatus('loading')
    visibleMsRef.current = 0
    lastVisibleAtRef.current =
      document.visibilityState === 'visible' ? Date.now() : null

    // 不在任务推文详情页:不是「加载中」,直接 ready(→ 下方 return null 隐藏
    // 整段)。若不置 ready,非详情页会常驻骨架。
    if (!focalId) {
      setStatus('ready')
      return
    }

    let cancelled = false
    const generation = accountVersion
    let loadSequence = 0
    // 本 focal 会话是否已拿到任务。拿到后,后续空快照(任务完成/名额变动暂时
    // 从快照消失,或 verify 成功后 force-sync 触发的 tasks-updated 回拉)不再
    // 把它清成 null —— 否则会把「进行中卡 / 成功庆祝」误清掉(自身引入的回归)。
    let gotTask = false
    let forceSyncFailed = false
    const showReadFailure = () => {
      if (cancelled || generation !== accountGeneration.current) return
      setCampaign((current) =>
        current
          ? {
              ...current,
              commentGuideStatus:
                current.commentGuide === undefined ? 'unavailable' : 'stale',
            }
          : null,
      )
      setStatus(gotTask ? 'ready' : 'error')
    }
    const hydrateDetectedActions = async (
      current: CurrentCampaign,
    ): Promise<void> => {
      try {
        const r = await sendMessage({
          type: 'get-captured-actions',
          campaignId: current.campaignId,
          tweetId: focalId,
        })
        if (
          cancelled ||
          generation !== accountGeneration.current ||
          r.type !== 'captured-actions'
        )
          return
        const required = new Set<string>(current.requiredActions)
        setDetected((prev) => {
          const next = new Set(prev)
          for (const action of r.actions) {
            if (required.has(action)) next.add(action)
          }
          return next
        })
      } catch {
        // 捕获回填失败不影响实时监听;用户后续动作仍会通过 __lhcap 解锁。
      }
    }
    // 拉快照 + 归并当前推文任务。
    const load = async (afterSync = false): Promise<void> => {
      const sequence = ++loadSequence
      try {
        const snap = await sendMessage({ type: 'get-tasks-snapshot' })
        if (
          cancelled ||
          generation !== accountGeneration.current ||
          sequence !== loadSequence ||
          snap.type !== 'tasks-snapshot'
        )
          return
        // Only a completed background refresh can clear a failed sync RPC;
        // ordinary cache reads must keep the failure visible.
        if (afterSync && snap.ready !== false && !snap.syncFailed) {
          forceSyncFailed = false
        }
        const author = focalAuthorFromUrl()
        // byTweet(该推文的互动单)+ byAuthor(以本推作者为目标的 FOLLOW 单);
        // groupCampaigns 会按 (campaignId, actionType) 去重两者交集。
        const tasks: CampaignTaskCache[] = [
          ...(snap.byTweet[focalId] ?? []),
          ...(author ? (snap.byAuthor[author] ?? []) : []),
        ]
        const hit = groupCampaigns(tasks)[0] ?? null
        if (hit) {
          setCampaign(
            forceSyncFailed
              ? {
                  ...hit,
                  commentGuideStatus:
                    hit.commentGuide === undefined ? 'unavailable' : 'stale',
                }
              : hit,
          )
          void hydrateDetectedActions(hit)
          setStatus('ready')
          gotTask = true
          return
        }
        // 已拿到过任务 → 保留,不因空快照清掉(保护进行中卡 / 成功态)。
        if (gotTask) {
          setStatus('ready')
          return
        }
        if (snap.syncFailed || forceSyncFailed) {
          setStatus('error')
          return
        }
        // 从没拿到:BG 已同步(ready≠false)→ 该推确实无任务,收尾 ready(→ null);
        // 冷启未同步(ready=false / 老 BG 无此字段)→ 保持 loading 骨架,靠下面的
        // backoff / tasks-updated 广播再拉,避免把冷启空快照误判成「无任务」。
        if (snap.ready !== false) {
          setCampaign(null)
          setStatus('ready')
        }
      } catch {
        if (sequence === loadSequence) showReadFailure()
      }
    }

    const refresh = () => {
      void sendMessage({ type: 'force-sync' })
        .then(() => {
          forceSyncFailed = false
          return load()
        })
        .catch(() => {
          forceSyncFailed = true
          showReadFailure()
        })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    void load()
    refresh()
    window.addEventListener('online', refresh)
    window.addEventListener('pageshow', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    // 冷启 backoff:BG 首次 syncTasks 可能还没落库,空快照不能当「无任务」。
    // 逐次重试;命中 ready 后再跑也只是 no-op。
    const timers = [400, 1200, 2600].map((d) =>
      setTimeout(() => {
        if (!cancelled) void load()
      }, d),
    )
    // BG 每次 syncTasks 完成广播 tasks-updated(如刚在网页预约完 → 同步 → 任务
    // 出现)。收到就对当前焦点重新归并,让卡片适时浮现 / 更新。
    const onMsg = (m: unknown): void => {
      if (
        !cancelled &&
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'tasks-updated'
      ) {
        void load(true)
      }
    }
    try {
      chrome.runtime.onMessage.addListener(onMsg)
    } catch {
      // ignore — 扩展上下文失效等
    }
    return () => {
      cancelled = true
      window.removeEventListener('online', refresh)
      window.removeEventListener('pageshow', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
      for (const t of timers) clearTimeout(t)
      try {
        chrome.runtime.onMessage.removeListener(onMsg)
      } catch {
        // ignore
      }
    }
  }, [focalId, accountVersion])

  // ── 页面可见性记账(mount 一次) ──
  React.useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        lastVisibleAtRef.current = Date.now()
      } else if (lastVisibleAtRef.current != null) {
        visibleMsRef.current += Date.now() - lastVisibleAtRef.current
        lastVisibleAtRef.current = null
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // ── 停留进度 tick(仅检测中 + 有任务时跑) ──
  React.useEffect(() => {
    if (!campaign || phase !== 'detecting') return
    const compute = () =>
      visibleMsRef.current +
      (lastVisibleAtRef.current != null
        ? Date.now() - lastVisibleAtRef.current
        : 0)
    setDwellMs(compute())
    const id = setInterval(() => setDwellMs(compute()), DWELL_TICK_MS)
    return () => clearInterval(id)
  }, [campaign, phase])

  // ── 监听 capture 的 __lhcap,累积已完成动作 ──
  React.useEffect(() => {
    if (!campaign || !focalId) return
    const required = campaign.requiredActions as string[]
    const targetUsername = campaign.targetUsername
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window) return
      const d = e.data as
        | { __lhcap?: boolean; action?: Record<string, unknown> }
        | undefined
      if (!d || d.__lhcap !== true || !d.action) return
      const a = d.action
      const at = typeof a.actionType === 'string' ? a.actionType : ''
      if (!required.includes(at)) return
      const hit =
        at === 'FOLLOW'
          ? typeof a.handle === 'string' &&
            a.handle.toLowerCase() === (targetUsername ?? '').toLowerCase()
          : typeof a.tweetId === 'string' && a.tweetId === focalId
      if (!hit) return
      setDetected((prev) => {
        if (prev.has(at)) return prev
        const next = new Set(prev)
        next.add(at)
        return next
      })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [campaign, focalId])

  // ── 验证发奖 ──
  const onVerify = React.useCallback(async () => {
    if (!campaign || busy) return
    setBusy(true)
    setErrorMsg(undefined)
    try {
      const r = await sendMessage({
        type: 'verify-task',
        campaignId: campaign.campaignId,
      })
      if (r.type === 'verify-result' && r.ok) {
        setPhase('success')
        void sendMessage({ type: 'force-sync' })
        onRewarded?.()
      } else if (r.type === 'verify-result') {
        setErrorMsg(r.message)
      }
    } catch {
      setErrorMsg('验证失败,请重试')
    } finally {
      setBusy(false)
    }
  }, [campaign, busy, onRewarded])

  // ── 验证成功 → 新开任务广场标签页并切过去(不动当前 X 页,委托后台开)。
  //    进入 success 后延时自动开,也可点按钮立即开。切走推文(组件卸载)清定时器。
  const goTaskHall = React.useCallback(() => {
    void sendMessage({ type: 'open-task-hall' })
  }, [])
  React.useEffect(() => {
    if (phase !== 'success') return
    const id = setTimeout(goTaskHall, TASK_HALL_OPEN_MS)
    return () => clearTimeout(id)
  }, [phase, goTaskHall])

  // 加载中(拉/归并当前推文任务)→ 显骨架,别整段空白。
  if (status === 'loading') return <CurrentTaskSkeleton />
  if (status === 'error')
    return (
      <section className="lh-cur-sec">
        <div className="lh-cur-head">
          <span className="lh-cur-eyebrow">当前任务</span>
        </div>
        <div className="lh-cur-card lh-cur-guide" role="status">
          评论引导暂时无法加载
        </div>
      </section>
    )
  // 已确认该推文无任务 → 整段隐藏,卡片回到原样。
  if (!campaign) return null

  if (phase === 'success') {
    // 发奖由后端异步处理。成功态不展示预估/最高档奖励数字,避免把异步到账前的
    // expectedReward 误解成实际发放金额;这里只确认任务已完成并已提交验证。
    return (
      <section className="lh-cur-sec">
        <div className="lh-cur-head">
          <span className="lh-cur-eyebrow">当前任务</span>
          <span className="lh-cur-pill lh-cur-pill-done">已完成</span>
        </div>
        <div className="lh-cur-card">
          <div className="lh-cur-done">
            <span className="lh-cur-done-burst">
              <LogoBadge />
            </span>
            <div className="lh-cur-done-big">已完成</div>
            <div className="lh-cur-done-sub">验证已提交 · 奖励发放中</div>
          </div>
          <div className="lh-cur-done-cta">
            <button
              type="button"
              className="lh-cur-btn on"
              onClick={goTaskHall}
            >
              打开任务广场
            </button>
            <div className="lh-cur-redirect-hint">
              即将在新标签打开任务广场…
            </div>
          </div>
        </div>
      </section>
    )
  }

  const state = computeGuideStateForActions(
    campaign.requiredActions,
    detected,
    dwellMs,
    DWELL_GOAL_MS,
  )
  const dwellPct = Math.min(100, Math.round((dwellMs / DWELL_GOAL_MS) * 100))
  const title =
    campaign.authorName ||
    (campaign.authorHandle ? `@${campaign.authorHandle}` : '灯塔互动任务')
  const brief = campaignBrief(campaign)
  const pill = state.canVerify
    ? { cls: 'lh-cur-pill-ready', text: '可验证' }
    : { cls: 'lh-cur-pill-go', text: '进行中' }

  return (
    <section className="lh-cur-sec">
      <div className="lh-cur-head">
        <span className="lh-cur-eyebrow">当前任务</span>
        <span className={`lh-cur-pill ${pill.cls}`}>{pill.text}</span>
      </div>
      <div className="lh-cur-card">
        <div className="lh-cur-top">
          <span className="lh-cur-ic">
            <EngageIcon />
          </span>
          <div className="lh-cur-mid">
            <div className="lh-cur-name">{title}</div>
            {campaign.lighthouseSelectedAtClaim === true ? (
              <LighthouseSelectedText kind="claim" />
            ) : null}
            <div className="lh-cur-brief">{brief}</div>
          </div>
          <div className="lh-cur-reward">
            +{formatReward(campaign.totalReward)}
            <span className="lh-cur-reward-unit">LUX</span>
          </div>
        </div>
        <div className="lh-cur-body">
          {campaign.requiredActions.includes('COMMENT') &&
          (campaign.commentGuide?.trim() ||
            campaign.commentGuideStatus !== 'ready') ? (
            <div className="lh-cur-guide">
              {campaign.commentGuideStatus === 'unavailable' ? (
                <div className="lh-cur-guide-status" role="status">
                  评论引导暂时无法加载
                </div>
              ) : (
                <>
                  <div className="lh-cur-guide-label">
                    评论引导
                    {campaign.commentGuideStatus === 'stale' ? (
                      <span className="lh-cur-guide-status" role="status">
                        更新失败
                      </span>
                    ) : null}
                  </div>
                  {campaign.commentGuide?.trim() ? (
                    <div className="lh-cur-guide-text">
                      {campaign.commentGuide}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
          <div className="lh-cur-todo-label">要完成</div>
          <ul className="lh-cur-todo">
            {state.items.map((it) => (
              <li
                className={`lh-cur-item${it.done ? ' done' : ''}`}
                key={it.key}
              >
                <span className="lh-cur-check" />
                <span className="lh-cur-item-label">{it.label}</span>
                <span className="lh-cur-item-badge">
                  {it.done ? '已完成' : '待完成'}
                </span>
              </li>
            ))}
          </ul>
          <div className="lh-cur-dwell">
            <div className="lh-cur-dwell-row">
              <ClockIcon />
              <span>停留时长</span>
              <span className="r">
                {Math.floor(dwellMs / 1000)} /{' '}
                {Math.floor(DWELL_GOAL_MS / 1000)}s
              </span>
            </div>
            <div className="lh-cur-track">
              <i style={{ width: `${dwellPct}%` }} />
            </div>
          </div>
          {errorMsg ? <div className="lh-cur-err">{errorMsg}</div> : null}
          <button
            type="button"
            className={`lh-cur-btn${state.canVerify && !busy ? ' on' : ' off'}`}
            disabled={!state.canVerify || busy}
            onClick={onVerify}
          >
            {busy
              ? '验证中…'
              : state.canVerify
                ? '验证发奖'
                : '完成上面步骤解锁'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * 「当前任务」加载骨架 — 拉/归并当前推文任务期间显示,复用 identity 卡的
 * lh-sk 系列(同一 shadow root 已注入 sidebar.css)。定位沿用 lh-cur-sec
 * 的 relative(禁 fixed,该组件也会在任务大厅 Drawer 内渲染,transform 会
 * 劫持 fixed)。
 */
function CurrentTaskSkeleton() {
  return (
    <section className="lh-cur-sec lh-task-sk">
      <div className="lh-cur-head">
        <span className="lh-cur-eyebrow">当前任务</span>
        <span className="lh-sk lh-sk-tier" />
      </div>
      <div className="lh-cur-card">
        <div className="lh-cur-top">
          <span className="lh-sk lh-sk-icon" />
          <div className="lh-cur-mid">
            <span className="lh-sk lh-sk-line" style={{ width: 120 }} />
            <span className="lh-sk lh-sk-line" style={{ width: 76 }} />
          </div>
          <span className="lh-sk lh-sk-reward" />
        </div>
        <div className="lh-cur-body">
          <span className="lh-sk lh-sk-line" style={{ width: '100%' }} />
          <span className="lh-sk lh-sk-line" style={{ width: '84%' }} />
          <span className="lh-sk lh-sk-line" style={{ width: '62%' }} />
        </div>
      </div>
    </section>
  )
}

function campaignBrief(c: CurrentCampaign): string {
  if (c.targetUsername && c.requiredActions.includes('FOLLOW')) {
    return `关注 @${c.targetUsername}`
  }
  return '完成下方动作领取奖励'
}

function formatReward(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  return Number(n.toFixed(1)).toLocaleString('en-US')
}

/** 打包的项目 logo(icon/128.png)— 成功徽章用,回退青绿方块。 */
function LogoBadge() {
  const src = React.useMemo(() => {
    try {
      return chrome.runtime.getURL('icon/128.png')
    } catch {
      return ''
    }
  }, [])
  if (!src)
    return <span className="lh-cur-done-logo lh-cur-done-logo-fallback" />
  return <img className="lh-cur-done-logo" src={src} alt="灯塔" />
}

function EngageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <title>task</title>
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <title>dwell</title>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 7v5l3 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
