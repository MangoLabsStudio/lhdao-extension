// [引导悬浮窗] 纯逻辑:任务要求哪些动作 / 检测到哪些 / 停留够没 / 能否验证。
// 无副作用,content 与组件共用,便于单测。

export type GuideAction = 'LIKE' | 'RT' | 'COMMENT' | 'FOLLOW'

const LABEL: Record<GuideAction, string> = {
  LIKE: '点赞',
  RT: '转发',
  COMMENT: '评论',
  FOLLOW: '关注',
}

/** 把后端 actionType 展开成需检测的原语动作(COMMENT_LIKE = 评论+点赞)。 */
export function requiredActionsFor(actionType: string): GuideAction[] {
  if (actionType === 'COMMENT_LIKE') return ['COMMENT', 'LIKE']
  if (
    actionType === 'LIKE' ||
    actionType === 'RT' ||
    actionType === 'COMMENT' ||
    actionType === 'FOLLOW'
  ) {
    return [actionType]
  }
  return []
}

export interface GuideItem {
  key: GuideAction
  label: string
  done: boolean
}

export interface GuideState {
  items: GuideItem[]
  dwellMs: number
  dwellOk: boolean
  canVerify: boolean
}

/** 由「任务类型 + 已检测动作 + 停留 ms + 停留目标」算出窗态。 */
export function computeGuideState(
  actionType: string,
  detected: Set<string>,
  dwellMs: number,
  goalMs: number,
): GuideState {
  const req = requiredActionsFor(actionType)
  const items = req.map((k) => ({
    key: k,
    label: LABEL[k],
    done: detected.has(k),
  }))
  const dwellOk = dwellMs >= goalMs
  const canVerify = items.length > 0 && items.every((i) => i.done) && dwellOk
  return { items, dwellMs, dwellOk, canVerify }
}
