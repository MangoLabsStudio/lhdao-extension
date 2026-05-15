import type { CampaignTaskCache } from '@/lib/storage'

interface Props {
  tasks: CampaignTaskCache[]
}

/**
 * 推文 handle / time 行右侧的极简徽章。**只显示奖励数字**,没有 logo
 * (放在头行容易被 Twitter 的 layout 撑大,纯文字配色就够辨识)。
 * 动作类型 + 关键字提示走 tooltip。
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

  const displayReward = fmtReward(single ? single.expectedReward : total)

  return (
    <span
      style={{ fontSize: '11px', lineHeight: '16px' }}
      className="ml-1 inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-teal-500/12 px-1.5 align-middle font-bold text-teal-700 dark:bg-teal-400/18 dark:text-teal-300"
      title={tooltip}
    >
      <span className="tabular-nums">+{displayReward}</span>
      <span
        style={{ fontSize: '9px' }}
        className="ml-0.5 font-medium opacity-70"
      >
        LUX
      </span>
    </span>
  )
}

function fmtReward(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return String(n)
  // 1 位小数(LUX 分发精度通常 0.1),去掉尾随零
  return Number(n.toFixed(1)).toString()
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
    case 'FOLLOW':
      return '关注'
  }
}
