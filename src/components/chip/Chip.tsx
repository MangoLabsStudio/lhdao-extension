import * as React from 'react'
import { sendMessage } from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'
import type { SubmitErrorCode } from '@/types/messages'

interface ChipProps {
  tasks: CampaignTaskCache[]
}

/**
 * 推文上挂着的 Lighthouse 任务高亮 chip。
 *
 * 渲染规则:
 *   - 一条推文可能挂多个任务(LIKE / RT / COMMENT 各一个 sub-row)
 *   - 每个 sub-row 有独立 idle / submitting / done / error 状态机
 *   - 容器与 Shadow DOM 隔离,Twitter 的 CSS 抓不到这里,我们的样式
 *     也不会污染 timeline
 */
export function Chip({ tasks }: ChipProps) {
  if (tasks.length === 0) return null

  const totalReward = tasks.reduce((acc, t) => acc + t.expectedReward, 0)

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-teal-200/80 bg-white shadow-sm dark:border-teal-900/40 dark:bg-slate-950">
      {/* Header — 品牌标识,solid 色,无渐变文字 */}
      <header className="flex items-center justify-between gap-2 bg-teal-50 px-3 py-2 dark:bg-teal-950/40">
        <div className="flex items-center gap-1.5">
          <LighthouseMark />
          <span className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
            Lighthouse
          </span>
          <span className="text-[10.5px] text-teal-600/70 dark:text-teal-400/70">
            · {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
          </span>
        </div>
        <span className="rounded-full bg-white px-2 py-0.5 text-[10.5px] font-bold tabular-nums text-teal-700 shadow-sm dark:bg-slate-900 dark:text-teal-300">
          +{totalReward} LUX
        </span>
      </header>

      {/* Action rows — divide via 1px hairline (NOT a side stripe) */}
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {tasks.map((t) => (
          <ActionRow key={t.campaignId} task={t} />
        ))}
      </div>
    </div>
  )
}

// ── one row per action ───────────────────────────────────────────────

type RowState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; reward: number }
  | { kind: 'error'; code: SubmitErrorCode; raw: string }

function ActionRow({ task }: { task: CampaignTaskCache }) {
  const [state, setState] = React.useState<RowState>({ kind: 'idle' })

  const submit = React.useCallback(async () => {
    setState({ kind: 'submitting' })
    const r = await sendMessage({
      type: 'submit-task',
      campaignId: task.campaignId,
    })
    if (r.type !== 'submit-result') {
      setState({ kind: 'error', code: 'INTERNAL', raw: 'unexpected response' })
      return
    }
    if (r.ok) {
      setState({ kind: 'done', reward: r.reward })
    } else {
      setState({ kind: 'error', code: r.code, raw: r.message })
    }
  }, [task.campaignId])

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <ActionIcon type={task.actionType} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-slate-800 dark:text-slate-100">
          <span>{actionLabel(task.actionType)}</span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span className="font-bold tabular-nums text-teal-700 dark:text-teal-300">
            +{task.expectedReward} LUX
          </span>
        </div>
        {task.commentKeyword && (
          <div className="mt-0.5 text-[10.5px] leading-snug text-rose-600 dark:text-rose-400">
            评论需包含:
            <code className="ml-1 rounded bg-rose-50 px-1 py-px font-mono text-[10px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {task.commentKeyword}
            </code>
          </div>
        )}
      </div>

      <RowAction state={state} onSubmit={submit} />
    </div>
  )
}

// ── status renderer ──────────────────────────────────────────────────

function RowAction({
  state,
  onSubmit,
}: {
  state: RowState
  onSubmit: () => void
}) {
  if (state.kind === 'idle') {
    return (
      <button
        type="button"
        onClick={onSubmit}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-gradient-to-r from-teal-500 to-cyan-500 px-3 text-[11.5px] font-bold text-white shadow-sm transition hover:opacity-90 active:scale-[0.97]"
      >
        <CheckIcon className="h-3 w-3" />
        我做完了
      </button>
    )
  }
  if (state.kind === 'submitting') {
    return (
      <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-slate-100 px-3 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <SpinnerIcon className="h-3 w-3 animate-spin" />
        提交中
      </span>
    )
  }
  if (state.kind === 'done') {
    return (
      <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-3 text-[11.5px] font-bold tabular-nums text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
        <SparkleIcon className="h-3 w-3" />+{state.reward} LUX
      </span>
    )
  }
  // error
  return (
    <button
      type="button"
      onClick={onSubmit}
      title={state.raw}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-rose-200 bg-white px-2.5 text-[10.5px] font-bold text-rose-600 transition hover:bg-rose-50 dark:border-rose-900/40 dark:bg-slate-950 dark:text-rose-400 dark:hover:bg-rose-950/30"
    >
      <RetryIcon className="h-3 w-3" />
      {friendlyError(state.code)} · 重试
    </button>
  )
}

// ── inline SVG icons (no external deps,Shadow DOM-safe) ────────────

function LighthouseMark() {
  // 简化版灯塔 mark — 一个圆点 + 上方光束
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <title>Lighthouse</title>
      <path
        d="M8 1 L4 5 H6 V13 H10 V5 H12 Z"
        fill="currentColor"
        className="text-teal-600 dark:text-teal-400"
      />
      <circle cx="8" cy="14.5" r="1.2" className="fill-teal-500" />
    </svg>
  )
}

function ActionIcon({ type }: { type: CampaignTaskCache['actionType'] }) {
  const baseCls =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400'
  const inner = (() => {
    if (type === 'LIKE') return <HeartIcon className="h-3.5 w-3.5" />
    if (type === 'RT') return <RepeatIcon className="h-3.5 w-3.5" />
    if (type === 'COMMENT') return <CommentIcon className="h-3.5 w-3.5" />
    return <CommentLikeIcon className="h-3.5 w-3.5" />
  })()
  return <span className={baseCls}>{inner}</span>
}

function HeartIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Like</title>
      <path
        d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l8.84 8.84 8.84-8.84a5.5 5.5 0 0 0 0-7.78z"
        fill="currentColor"
      />
    </svg>
  )
}
function RepeatIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Retweet</title>
      <path
        d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function CommentIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Comment</title>
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
function CommentLikeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Comment + Like</title>
      <path
        d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 13.5a1.5 1.5 0 1 1 1.5-1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
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

// ── helpers ──────────────────────────────────────────────────────────

function actionLabel(type: CampaignTaskCache['actionType']): string {
  switch (type) {
    case 'LIKE':
      return '点赞'
    case 'RT':
      return '转发'
    case 'COMMENT':
      return '评论'
    case 'COMMENT_LIKE':
      return '评论 + 点赞'
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
      return '评论缺关键字'
    case 'WRONG_X_ACCOUNT':
      return 'X 账号不匹配'
    case 'API_NOT_READY':
      return 'X API 延迟'
    case 'ACTION_NOT_DETECTED':
      return '未检测到动作'
    case 'NETWORK':
      return '网络错误'
    case 'RESERVE_FAILED':
    case 'VERIFY_FAILED':
    case 'INTERNAL':
      return '系统错误'
  }
}
