import type { CampaignTaskCache } from '@/lib/storage'

interface Props {
  tasks: CampaignTaskCache[]
}

/**
 * 推文 handle / time 行右侧的极简徽章。**只显示奖励数字**,没有 logo
 * (放在头行容易被 Twitter 的 layout 撑大,纯文字配色就够辨识)。
 * 动作类型走 tooltip。
 */
export function MetadataBadge({ tasks }: Props) {
  if (tasks.length === 0) return null

  const total = tasks.reduce((acc, t) => acc + t.expectedReward, 0)
  const single = tasks.length === 1 ? tasks[0] : null

  const tooltip = single
    ? `Lighthouse · ${actionLabel(single.actionType)} · +${single.expectedReward} LUX`
    : `Lighthouse · ${tasks.length} 个任务 · 合计 +${total} LUX`

  const displayReward = fmtReward(single ? single.expectedReward : total)

  return (
    <span className="lhdao-reward-pill ml-1 shrink-0" title={tooltip}>
      <span>+{displayReward}</span>
      <span className="lhdao-reward-pill-unit">LUX</span>
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
