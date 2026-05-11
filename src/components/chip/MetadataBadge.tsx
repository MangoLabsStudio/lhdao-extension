import type { CampaignTaskCache } from '@/lib/storage'

interface Props {
  tasks: CampaignTaskCache[]
}

/**
 * 插在推文 handle + time 行右侧的小 pill,展示 Lighthouse 任务概览。
 * 信息密度优先 — 单任务直接显示动作 + 奖励,多任务合计奖励 + 计数。
 *
 * 不带交互(纯展示),交互在 <SubmitButton> 里。
 */
export function MetadataBadge({ tasks }: Props) {
  if (tasks.length === 0) return null

  const total = tasks.reduce((acc, t) => acc + t.expectedReward, 0)
  const single = tasks.length === 1 ? tasks[0] : null

  return (
    <span
      className="lhdao-badge ml-1.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-teal-300/60 bg-gradient-to-r from-teal-50 to-cyan-50 px-2 py-0.5 align-middle text-[11px] font-bold leading-none text-teal-700 shadow-sm dark:border-teal-700/40 dark:from-teal-950/50 dark:to-cyan-950/40 dark:text-teal-300"
      title={
        single
          ? `Lighthouse · ${actionLabel(single.actionType)} · +${single.expectedReward} LUX`
          : `Lighthouse · ${tasks.length} tasks · +${total} LUX`
      }
    >
      <LighthouseGlyph />
      {single ? (
        <>
          <span className="opacity-80">{actionLabel(single.actionType)}</span>
          <span className="font-black tabular-nums">
            +{single.expectedReward}
          </span>
          <span className="text-[9px] opacity-70">LUX</span>
        </>
      ) : (
        <>
          <span className="font-black tabular-nums">+{total}</span>
          <span className="text-[9px] opacity-70">LUX · ×{tasks.length}</span>
        </>
      )}
    </span>
  )
}

function actionLabel(type: CampaignTaskCache['actionType']): string {
  switch (type) {
    case 'LIKE':
      return '点赞'
    case 'RT':
      return '转发'
    case 'COMMENT':
      return '评论'
    case 'COMMENT_LIKE':
      return '评论+赞'
  }
}

function LighthouseGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
      <title>Lighthouse</title>
      <path d="M8 1 L4 5 H6 V13 H10 V5 H12 Z" fill="currentColor" />
      <circle cx="8" cy="14.5" r="1.1" fill="currentColor" opacity="0.7" />
    </svg>
  )
}
