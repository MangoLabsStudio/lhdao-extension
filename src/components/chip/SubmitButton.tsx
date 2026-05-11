import * as React from 'react'
import { sendMessage } from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'
import type { SubmitErrorCode } from '@/types/messages'

interface Props {
  tasks: CampaignTaskCache[]
}

type RowState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; reward: number }
  | { kind: 'error'; code: SubmitErrorCode; raw: string }

/**
 * 插在 Twitter action button 行末尾的 "verify" 按钮。
 *
 * 视觉风格:贴齐 Twitter action button 的 ghost 风(透明背景 + 单色 icon +
 * 可选 label,hover 才出现淡色底)。这样它看起来是动作行的一员,而不是
 * 突兀的外挂卡片。
 *
 * 单任务直接 submit;多任务顺序逐个 submit,reward 累加,任一失败保留为
 * lastErr 显示。
 */
export function SubmitButton({ tasks }: Props) {
  const [state, setState] = React.useState<RowState>({ kind: 'idle' })

  const submit = React.useCallback(async () => {
    if (state.kind !== 'idle' && state.kind !== 'error') return
    setState({ kind: 'submitting' })

    let totalReward = 0
    let lastErr: { code: SubmitErrorCode; message: string } | null = null

    for (const t of tasks) {
      const r = await sendMessage({
        type: 'submit-task',
        campaignId: t.campaignId,
      })
      if (r.type !== 'submit-result') continue
      if (r.ok) {
        totalReward += r.reward
      } else {
        lastErr = { code: r.code, message: r.message }
      }
    }

    if (totalReward > 0) {
      setState({ kind: 'done', reward: totalReward })
    } else if (lastErr) {
      setState({ kind: 'error', code: lastErr.code, raw: lastErr.message })
    } else {
      setState({ kind: 'error', code: 'INTERNAL', raw: 'no response' })
    }
  }, [tasks, state.kind])

  return (
    <button
      type="button"
      onClick={submit}
      disabled={state.kind === 'submitting' || state.kind === 'done'}
      title={state.kind === 'error' ? state.raw : undefined}
      className={btnClasses(state)}
    >
      <IconForState state={state} />
      <span className="tabular-nums">{labelForState(state)}</span>
    </button>
  )
}

// ── style derivation ─────────────────────────────────────────────────

/**
 * 模仿 Twitter action button 的 ghost 样式:透明底,hover 才出现淡色圆圈。
 * 高度 h-9 跟 Twitter 自家按钮一致,圆角 full,inline-flex 不破坏行内对齐。
 */
function btnClasses(state: RowState): string {
  const base =
    'group inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium leading-none transition-all duration-150 disabled:cursor-not-allowed select-none'

  switch (state.kind) {
    case 'idle':
      return `${base} text-teal-600 hover:bg-teal-500/10 hover:text-teal-700 active:scale-[0.96] dark:text-teal-400 dark:hover:bg-teal-400/15 dark:hover:text-teal-300`
    case 'submitting':
      return `${base} text-teal-500/70 dark:text-teal-400/70`
    case 'done':
      return `${base} text-emerald-600 dark:text-emerald-400`
    case 'error':
      return `${base} text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 active:scale-[0.96] dark:text-rose-400 dark:hover:bg-rose-400/15 dark:hover:text-rose-300`
  }
}

function labelForState(state: RowState): string {
  switch (state.kind) {
    case 'idle':
      return 'verify'
    case 'submitting':
      return ''
    case 'done':
      return `+${state.reward}`
    case 'error':
      return friendlyError(state.code)
  }
}

function IconForState({ state }: { state: RowState }) {
  const cls = 'h-[18px] w-[18px]'
  switch (state.kind) {
    case 'idle':
      return <CheckIcon className={cls} />
    case 'submitting':
      return <SpinnerIcon className={`${cls} animate-spin`} />
    case 'done':
      return <SparkleIcon className={cls} />
    case 'error':
      return <RetryIcon className={cls} />
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
      return '重试'
  }
}

// ── icons (Twitter 系自家 button 用 ~20px icon,我们贴齐) ────────

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Verify</title>
      <path
        d="M5 13l4 4L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Loading</title>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeDasharray="40 18"
        strokeLinecap="round"
      />
    </svg>
  )
}
function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Earned</title>
      <path
        d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z"
        fill="currentColor"
      />
    </svg>
  )
}
function RetryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
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
