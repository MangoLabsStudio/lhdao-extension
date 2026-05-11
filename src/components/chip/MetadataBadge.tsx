import type { CampaignTaskCache } from '@/lib/storage'

interface Props {
  tasks: CampaignTaskCache[]
}

/**
 * 推文 handle / time 行右侧的极简徽章。**只显示奖励**,动作类型与
 * 关键字提示走 tooltip(避免推文头行被撑大或换行)。
 *
 * 设计目标:像 X 上的 verified blue tick 一样——存在感低,但能看到。
 */
export function MetadataBadge({ tasks }: Props) {
  if (tasks.length === 0) return null

  const total = tasks.reduce((acc, t) => acc + t.expectedReward, 0)
  const single = tasks.length === 1 ? tasks[0] : null

  const tooltip = single
    ? `Lighthouse · ${actionLabel(single.actionType)} · +${single.expectedReward} LUX${
        single.commentKeyword ? ` · 评论需含 "${single.commentKeyword}"` : ''
      }`
    : `Lighthouse · ${tasks.length} 个任务 · 合计 +${total} LUX`

  return (
    <span
      className="ml-1 inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full bg-teal-500/10 px-1.5 py-0 align-middle text-[10.5px] font-bold leading-[16px] text-teal-600 dark:bg-teal-400/15 dark:text-teal-300"
      title={tooltip}
      aria-label={tooltip}
    >
      <LighthouseGlyph />
      <span className="tabular-nums">
        +{single ? single.expectedReward : total}
      </span>
      <span className="text-[8.5px] font-medium opacity-70">LUX</span>
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
    <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" aria-hidden="true">
      <title>Lighthouse</title>
      <path d="M8 1 L4 5 H6 V13 H10 V5 H12 Z" fill="currentColor" />
      <circle cx="8" cy="14.5" r="1" fill="currentColor" opacity="0.7" />
    </svg>
  )
}
