import * as React from 'react'
import { sendMessage } from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'
import type { SubmitErrorCode } from '@/types/messages'

interface Props {
  tasks: CampaignTaskCache[]
}

/**
 * 抢单流程 = 两步:
 *   1. claim  → reserveEngagementSlot   (占席位)
 *   2. (用户去 Twitter 真的做动作)
 *   3. verify → verifyEngagement        (验证 + 发奖)
 *
 * 状态机:
 *   idle     → click: reserve  → reserved (开始 cooldown 倒计时)
 *   reserved → click: verify   → done(+N LUX) | error(retry verify)
 *   error    → click: 根据 phase 重试对应步骤
 *   done     → 终态
 *
 * 多任务串行抢:第一个任务的 cooldown 时长用作整组的倒计时;reward 累加。
 */

type State =
  | { kind: 'idle' }
  | { kind: 'reserving' }
  | { kind: 'reserved'; cooldownDeadlineMs?: number }
  | { kind: 'verifying' }
  | { kind: 'done'; reward: number }
  | {
      kind: 'error'
      phase: 'reserve' | 'verify'
      code: SubmitErrorCode
      raw: string
    }

export function SubmitButton({ tasks }: Props) {
  const [state, setState] = React.useState<State>({ kind: 'idle' })

  // 倒计时 tick — 仅 reserved + cooldown 有时启用
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    if (state.kind !== 'reserved' || !state.cooldownDeadlineMs) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [state])

  const reserve = React.useCallback(async () => {
    setState({ kind: 'reserving' })
    let minCooldown: number | undefined
    let lastErr: { code: SubmitErrorCode; message: string } | null = null

    for (const t of tasks) {
      const r = await sendMessage({
        type: 'reserve-task',
        campaignId: t.campaignId,
      })
      if (r.type !== 'reserve-result') continue
      if (r.ok) {
        if (r.cooldownSeconds != null) {
          minCooldown = Math.min(minCooldown ?? Infinity, r.cooldownSeconds)
        }
      } else {
        lastErr = { code: r.code, message: r.message }
      }
    }

    if (lastErr && minCooldown === undefined) {
      setState({
        kind: 'error',
        phase: 'reserve',
        code: lastErr.code,
        raw: lastErr.message,
      })
    } else {
      setState({
        kind: 'reserved',
        cooldownDeadlineMs: minCooldown
          ? Date.now() + minCooldown * 1000
          : undefined,
      })
    }
  }, [tasks])

  const verify = React.useCallback(async () => {
    setState({ kind: 'verifying' })
    let totalReward = 0
    let lastErr: { code: SubmitErrorCode; message: string } | null = null

    for (const t of tasks) {
      const r = await sendMessage({
        type: 'verify-task',
        campaignId: t.campaignId,
      })
      if (r.type !== 'verify-result') continue
      if (r.ok) {
        totalReward += r.reward
      } else {
        lastErr = { code: r.code, message: r.message }
      }
    }

    if (totalReward > 0) {
      setState({ kind: 'done', reward: totalReward })
    } else if (lastErr) {
      setState({
        kind: 'error',
        phase: 'verify',
        code: lastErr.code,
        raw: lastErr.message,
      })
    } else {
      setState({
        kind: 'error',
        phase: 'verify',
        code: 'INTERNAL',
        raw: 'no response',
      })
    }
  }, [tasks])

  const onClick = () => {
    switch (state.kind) {
      case 'idle':
        return reserve()
      case 'reserved':
        return verify()
      case 'error':
        return state.phase === 'reserve' ? reserve() : verify()
      default:
        return
    }
  }

  const disabled =
    state.kind === 'reserving' ||
    state.kind === 'verifying' ||
    state.kind === 'done'

  const cooldownLeft =
    state.kind === 'reserved' && state.cooldownDeadlineMs
      ? Math.max(0, Math.ceil((state.cooldownDeadlineMs - now) / 1000))
      : null

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={state.kind === 'error' ? state.raw : undefined}
      className={btnClasses(state)}
      style={{
        height: '32px',
        minWidth: '70px',
        padding: '0 12px',
        borderRadius: '9999px',
        fontSize: '12.5px',
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        transition: 'all 150ms',
      }}
    >
      <IconForState state={state} />
      <span className="tabular-nums">{labelForState(state, cooldownLeft)}</span>
    </button>
  )
}

// ── style derivation ─────────────────────────────────────────────────

function btnClasses(state: State): string {
  switch (state.kind) {
    case 'idle':
      // 主 CTA:灯塔渐变背景 + 白字 + 圆角(用户要求"系统风格的按钮渐变加上圆角")
      return 'lhdao-btn lhdao-btn-primary'
    case 'reserving':
      return 'lhdao-btn lhdao-btn-primary lhdao-btn-busy'
    case 'reserved':
      return 'lhdao-btn lhdao-btn-secondary'
    case 'verifying':
      return 'lhdao-btn lhdao-btn-secondary lhdao-btn-busy'
    case 'done':
      return 'lhdao-btn lhdao-btn-done'
    case 'error':
      return 'lhdao-btn lhdao-btn-error'
  }
}

function labelForState(state: State, cooldownLeft: number | null): string {
  switch (state.kind) {
    case 'idle':
      return 'claim'
    case 'reserving':
      return '抢单中'
    case 'reserved':
      return cooldownLeft !== null ? `verify · ${cooldownLeft}s` : 'verify'
    case 'verifying':
      return '验证中'
    case 'done':
      return `+${state.reward} LUX`
    case 'error':
      return state.phase === 'reserve'
        ? `${friendlyError(state.code)} · 重抢`
        : `${friendlyError(state.code)} · 重验证`
  }
}

function IconForState({ state }: { state: State }) {
  const sz = { width: '14px', height: '14px' }
  switch (state.kind) {
    case 'idle':
      return <BoltIcon style={sz} />
    case 'reserving':
    case 'verifying':
      return (
        <span
          style={{
            ...sz,
            display: 'inline-block',
            animation: 'lhdao-spin 1s linear infinite',
          }}
        >
          <SpinnerIcon style={sz} />
        </span>
      )
    case 'reserved':
      return <CheckIcon style={sz} />
    case 'done':
      return <SparkleIcon style={sz} />
    case 'error':
      return <RetryIcon style={sz} />
  }
}

function friendlyError(code: SubmitErrorCode): string {
  switch (code) {
    case 'NO_TOKEN':
    case 'TOKEN_INVALID':
      return 'token 失效'
    case 'SLOT_FULL':
      return '席位已满'
    case 'BOT_BLOCKED':
      return '账号受限'
    case 'ALREADY_DONE':
      return '已完成'
    case 'COMMENT_MISSING':
      return '缺关键字'
    case 'WRONG_X_ACCOUNT':
      return 'X 账号不符'
    case 'API_NOT_READY':
      return 'X API 延迟'
    case 'ACTION_NOT_DETECTED':
      return '未检测到'
    case 'NETWORK':
      return '网络错误'
    case 'RESERVE_FAILED':
    case 'VERIFY_FAILED':
    case 'INTERNAL':
      return '失败'
  }
}

// ── icons ────────────────────────────────────────────────────────────

function BoltIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" style={style} aria-hidden="true">
      <title>Claim</title>
      <path d="M13 2L3 14h7l-1 8 11-14h-7z" fill="currentColor" />
    </svg>
  )
}
function CheckIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" style={style} aria-hidden="true">
      <title>Verify</title>
      <path
        d="M5 13l4 4L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function SpinnerIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" style={style} aria-hidden="true">
      <title>Loading</title>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray="40 18"
        strokeLinecap="round"
      />
    </svg>
  )
}
function SparkleIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" style={style} aria-hidden="true">
      <title>Earned</title>
      <path
        d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z"
        fill="currentColor"
      />
    </svg>
  )
}
function RetryIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" style={style} aria-hidden="true">
      <title>Retry</title>
      <path
        d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
