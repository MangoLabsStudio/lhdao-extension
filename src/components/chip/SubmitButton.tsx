import * as React from 'react'
import { sendMessage } from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'
import type { SubmitErrorCode } from '@/types/messages'

interface Props {
  tasks: CampaignTaskCache[]
}

/**
 * 抢单 + 验证两按钮组件。
 *
 * 用户视角的两步流程拆成两个**独立按钮**(并排):
 *   1. [抢单] reserveEngagementSlot 占席位
 *   2. (用户离开插件,去 Twitter 真的完成动作)
 *   3. [验证] verifyEngagement 校验 + 发奖
 *
 * 按钮联动:
 *   - 抢单按钮 idle 可点;抢单中 disabled;抢成功后 disabled 显示"已抢"
 *   - 验证按钮在抢单成功之前**永远 disabled**;抢成功 + cooldown 走完
 *     才能点;验证中 disabled;done 显示奖励数额
 *   - 任一阶段出错 → 该按钮显示 "重试 · 简述",再次点击重试
 *
 * 多任务串行抢:第一个任务的 cooldown 时长用作整组的倒计时;reward 累加。
 */

// 抢单阶段独立状态机
type ReserveState =
  | { kind: 'idle' }
  | { kind: 'reserving' }
  | { kind: 'done'; cooldownDeadlineMs?: number }
  | { kind: 'error'; code: SubmitErrorCode; raw: string }

// 验证阶段独立状态机(只在 reserve 完成后才会从 'locked' 变化)
type VerifyState =
  | { kind: 'locked' } // reserve 未完成时
  | { kind: 'idle' } // reserve 完成,可以点
  | { kind: 'verifying' }
  | { kind: 'done'; reward: number }
  | { kind: 'error'; code: SubmitErrorCode; raw: string }

export function SubmitButton({ tasks }: Props) {
  const [reserveState, setReserveState] = React.useState<ReserveState>({
    kind: 'idle',
  })
  const [verifyState, setVerifyState] = React.useState<VerifyState>({
    kind: 'locked',
  })

  // FOLLOW 任务的特殊 idle 文案 — 让用户知道点这个按钮要去关注谁。
  // 仅当所有 task 都是 FOLLOW 时显示 "关注 @handle";混合任务保持 "抢单"。
  const followOnlyHandle = React.useMemo(() => {
    if (tasks.length === 0) return null
    const allFollow = tasks.every((t) => t.actionType === 'FOLLOW')
    if (!allFollow) return null
    return tasks[0]?.targetUsername ?? null
  }, [tasks])

  // 倒计时 tick — 仅 reserve done + cooldown 时启用,影响 verify 按钮可点性
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    if (reserveState.kind !== 'done' || !reserveState.cooldownDeadlineMs) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [reserveState])

  const cooldownLeft =
    reserveState.kind === 'done' && reserveState.cooldownDeadlineMs
      ? Math.max(0, Math.ceil((reserveState.cooldownDeadlineMs - now) / 1000))
      : 0

  // ── reserve action ────────────────────────────────────────────────
  const reserve = React.useCallback(
    async (confirmCascade?: boolean) => {
      setReserveState({ kind: 'reserving' })
      let minCooldown: number | undefined
      let lastErr: { code: SubmitErrorCode; message: string } | null = null

      for (const t of tasks) {
        const r = await sendMessage({
          type: 'reserve-task',
          campaignId: t.campaignId,
          confirmCascade,
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
        console.error(
          '[lhdao] reserve failed:',
          lastErr.code,
          '·',
          lastErr.message,
        )
        setReserveState({
          kind: 'error',
          code: lastErr.code,
          raw: lastErr.message,
        })
        // verify 仍保持 locked
      } else {
        setReserveState({
          kind: 'done',
          cooldownDeadlineMs: minCooldown
            ? Date.now() + minCooldown * 1000
            : undefined,
        })
        // 解锁 verify 按钮(可能仍受 cooldown 限制点不动,但不再 locked)
        setVerifyState({ kind: 'idle' })
      }
    },
    [tasks],
  )

  // ── verify action ─────────────────────────────────────────────────
  const verify = React.useCallback(async () => {
    setVerifyState({ kind: 'verifying' })
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
      setVerifyState({ kind: 'done', reward: totalReward })
    } else if (lastErr) {
      console.error(
        '[lhdao] verify failed:',
        lastErr.code,
        '·',
        lastErr.message,
      )
      setVerifyState({
        kind: 'error',
        code: lastErr.code,
        raw: lastErr.message,
      })
    } else {
      console.error('[lhdao] verify: no response from background')
      setVerifyState({
        kind: 'error',
        code: 'INTERNAL',
        raw: 'no response',
      })
    }
  }, [tasks])

  // ── reserve button derivation ────────────────────────────────────
  const reserveClickable =
    reserveState.kind === 'idle' || reserveState.kind === 'error'
  const onReserveClick = () => {
    if (!reserveClickable) return
    if (reserveState.kind === 'error') {
      // cascade 警告 → 自动 confirm 接受降档
      const isCascade = /降到\s*\w+\s*档/.test(reserveState.raw)
      void reserve(isCascade)
      return
    }
    void reserve()
  }

  // ── verify button derivation ──────────────────────────────────────
  // 三层 disable:
  //   1. locked (reserve 未完成)
  //   2. verifying (正在验证)
  //   3. done (已经领过奖了,不能再点)
  //   4. cooldown 未结束(还在等席位释放/Twitter API 缓存)
  const verifyClickable =
    (verifyState.kind === 'idle' || verifyState.kind === 'error') &&
    cooldownLeft === 0
  const onVerifyClick = () => {
    if (!verifyClickable) return
    void verify()
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
      }}
    >
      <button
        type="button"
        onClick={onReserveClick}
        disabled={!reserveClickable}
        title={reserveState.kind === 'error' ? reserveState.raw : undefined}
        className={reserveBtnClass(reserveState)}
        style={btnStyle}
      >
        <ReserveIcon state={reserveState} />
        <span className="tabular-nums">
          {reserveLabel(reserveState, followOnlyHandle)}
        </span>
      </button>
      <button
        type="button"
        onClick={onVerifyClick}
        disabled={!verifyClickable}
        title={verifyState.kind === 'error' ? verifyState.raw : undefined}
        className={verifyBtnClass(verifyState, cooldownLeft)}
        style={btnStyle}
      >
        <VerifyIcon state={verifyState} />
        <span className="tabular-nums">
          {verifyLabel(verifyState, cooldownLeft)}
        </span>
      </button>
    </span>
  )
}

// ── shared button style ──────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  height: '32px',
  minWidth: '64px',
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
}

// ── reserve button style + label ─────────────────────────────────────

function reserveBtnClass(state: ReserveState): string {
  switch (state.kind) {
    case 'idle':
      return 'lhdao-btn lhdao-btn-primary'
    case 'reserving':
      return 'lhdao-btn lhdao-btn-primary lhdao-btn-busy'
    case 'done':
      // reserve 完成后,按钮转灰禁用,告知用户"已经抢过了"
      return 'lhdao-btn lhdao-btn-secondary'
    case 'error':
      return 'lhdao-btn lhdao-btn-error'
  }
}

function reserveLabel(
  state: ReserveState,
  followOnlyHandle: string | null,
): string {
  switch (state.kind) {
    case 'idle':
      if (followOnlyHandle) {
        const display =
          followOnlyHandle.length > 10
            ? `${followOnlyHandle.slice(0, 9)}…`
            : followOnlyHandle
        return `关注 @${display}`
      }
      return '抢单'
    case 'reserving':
      return '抢单中'
    case 'done':
      return '已抢'
    case 'error': {
      const friendly = friendlyError(state.code)
      const isGeneric =
        state.code === 'RESERVE_FAILED' || state.code === 'INTERNAL'
      const label = isGeneric && state.raw ? state.raw.slice(0, 12) : friendly
      return `${label} · 重抢`
    }
  }
}

// ── verify button style + label ──────────────────────────────────────

function verifyBtnClass(state: VerifyState, cooldownLeft: number): string {
  if (state.kind === 'locked' || cooldownLeft > 0) {
    return 'lhdao-btn lhdao-btn-disabled'
  }
  switch (state.kind) {
    case 'idle':
      return 'lhdao-btn lhdao-btn-primary'
    case 'verifying':
      return 'lhdao-btn lhdao-btn-primary lhdao-btn-busy'
    case 'done':
      return 'lhdao-btn lhdao-btn-done'
    case 'error':
      return 'lhdao-btn lhdao-btn-error'
  }
}

function verifyLabel(state: VerifyState, cooldownLeft: number): string {
  if (state.kind === 'locked') return '验证'
  if (cooldownLeft > 0) return `验证 · ${cooldownLeft}s`
  switch (state.kind) {
    case 'idle':
      return '验证'
    case 'verifying':
      return '验证中'
    case 'done':
      return `+${state.reward} LUX`
    case 'error': {
      const friendly = friendlyError(state.code)
      const isGeneric =
        state.code === 'VERIFY_FAILED' || state.code === 'INTERNAL'
      const label = isGeneric && state.raw ? state.raw.slice(0, 12) : friendly
      return `${label} · 重试`
    }
  }
}

// ── per-button icons ─────────────────────────────────────────────────

function ReserveIcon({ state }: { state: ReserveState }) {
  const sz = { width: '14px', height: '14px' }
  switch (state.kind) {
    case 'idle':
      return <BoltIcon style={sz} />
    case 'reserving':
      return <Spinner style={sz} />
    case 'done':
      return <CheckIcon style={sz} />
    case 'error':
      return <RetryIcon style={sz} />
  }
}

function VerifyIcon({ state }: { state: VerifyState }) {
  const sz = { width: '14px', height: '14px' }
  switch (state.kind) {
    case 'locked':
    case 'idle':
      return <CheckIcon style={sz} />
    case 'verifying':
      return <Spinner style={sz} />
    case 'done':
      return <SparkleIcon style={sz} />
    case 'error':
      return <RetryIcon style={sz} />
  }
}

// ── error code → 中文短文案 ──────────────────────────────────────────

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

// ── icons (shared) ───────────────────────────────────────────────────

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
      <title>Check</title>
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
function Spinner({ style }: { style?: React.CSSProperties }) {
  return (
    <span
      style={{
        ...style,
        display: 'inline-block',
        animation: 'lhdao-spin 1s linear infinite',
      }}
    >
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
    </span>
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
