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
 * 插在 Twitter action button 行末尾的 "我做完了" 按钮(灯塔配色)。
 *
 * 单任务直接 submit;多任务 (同一推文挂多个 campaign) 顺序逐个 submit,
 * 任意一个失败都不阻塞后续 — 最终 reward 汇总展示。
 *
 * COMMENT 类任务下方多一行关键字提示,用户可以一眼看到要带什么词。
 */
export function SubmitButton({ tasks }: Props) {
  const [state, setState] = React.useState<RowState>({ kind: 'idle' })

  const submit = React.useCallback(async () => {
    if (state.kind === 'submitting') return
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
      setState({
        kind: 'error',
        code: 'INTERNAL',
        raw: 'no response',
      })
    }
  }, [tasks, state.kind])

  // 找有关键字要求的 COMMENT 任务,展示 hint
  const keywordHint = React.useMemo(() => {
    const kw = tasks.find(
      (t) =>
        (t.actionType === 'COMMENT' || t.actionType === 'COMMENT_LIKE') &&
        t.commentKeyword,
    )?.commentKeyword
    return kw ?? null
  }, [tasks])

  return (
    <div className="lhdao-submit-wrap inline-flex items-center gap-1.5 align-middle">
      {keywordHint && state.kind === 'idle' && (
        <span
          className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-600 dark:bg-rose-950/40 dark:text-rose-400"
          title="评论需含此关键字"
        >
          <KeywordIcon />
          <code className="font-mono">{keywordHint}</code>
        </span>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={state.kind === 'submitting' || state.kind === 'done'}
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-[11.5px] font-bold leading-none transition active:scale-[0.97] disabled:cursor-not-allowed ${stateClasses(state)}`}
        title={state.kind === 'error' ? state.raw : undefined}
      >
        {state.kind === 'idle' && (
          <>
            <CheckIcon className="h-3 w-3" />
            我做完了
          </>
        )}
        {state.kind === 'submitting' && (
          <>
            <SpinnerIcon className="h-3 w-3 animate-spin" />
            提交中
          </>
        )}
        {state.kind === 'done' && (
          <>
            <SparkleIcon className="h-3 w-3" />
            <span className="tabular-nums">+{state.reward} LUX</span>
          </>
        )}
        {state.kind === 'error' && (
          <>
            <RetryIcon className="h-3 w-3" />
            {friendlyError(state.code)} · 重试
          </>
        )}
      </button>
    </div>
  )
}

function stateClasses(state: RowState): string {
  switch (state.kind) {
    case 'idle':
    case 'submitting':
      return 'bg-gradient-to-r from-teal-500 to-cyan-500 text-white shadow-sm hover:opacity-90'
    case 'done':
      return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:ring-emerald-900/40'
    case 'error':
      return 'border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 dark:border-rose-900/40 dark:bg-slate-950 dark:text-rose-400 dark:hover:bg-rose-950/30'
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
      return '系统错误'
  }
}

// ── icons (inline SVG,Shadow DOM-safe) ──────────────────────────

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Done</title>
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
        strokeWidth="2.5"
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
function KeywordIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" aria-hidden="true">
      <title>Keyword</title>
      <path
        d="M3 7h18M3 12h18M3 17h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
