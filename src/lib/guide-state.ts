// [任务引导] 纯逻辑:任务要求哪些动作 / 检测到哪些 / 停留够没 / 能否验证。
// 无副作用,content 与组件共用,便于单测。sidebar「当前任务」段 + (历史)悬浮窗共享。

import type { CampaignTaskCache, CommentGuideStatus } from '@/lib/storage'

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

/**
 * 把多个后端 actionType 合并成去重的原语动作序列。
 * 一个 campaign 在 cache 里被「按 action 拍平」成多条 entry(见 flattenTasks),
 * 归并回单个任务视图时用它把 [COMMENT_LIKE, LIKE] → [COMMENT, LIKE]。
 */
export function requiredActionsForMany(actionTypes: string[]): GuideAction[] {
  const out: GuideAction[] = []
  const seen = new Set<GuideAction>()
  for (const at of actionTypes) {
    for (const a of requiredActionsFor(at)) {
      if (!seen.has(a)) {
        seen.add(a)
        out.push(a)
      }
    }
  }
  return out
}

/** 由「已展开的要求原语动作 + 已检测动作 + 停留」算出任务态。 */
export function computeGuideStateForActions(
  required: GuideAction[],
  detected: Set<string>,
  dwellMs: number,
  goalMs: number,
): GuideState {
  const items = required.map((k) => ({
    key: k,
    label: LABEL[k],
    done: detected.has(k),
  }))
  const dwellOk = dwellMs >= goalMs
  const canVerify = items.length > 0 && items.every((i) => i.done) && dwellOk
  return { items, dwellMs, dwellOk, canVerify }
}

/** 由「单个任务类型 + 已检测动作 + 停留 ms + 停留目标」算出窗态。 */
export function computeGuideState(
  actionType: string,
  detected: Set<string>,
  dwellMs: number,
  goalMs: number,
): GuideState {
  return computeGuideStateForActions(
    requiredActionsFor(actionType),
    detected,
    dwellMs,
    goalMs,
  )
}

/** 归并后的「当前任务」视图 — 一个 campaign 的完整要求(跨其所有 action entry)。 */
export interface CurrentCampaign {
  campaignId: string
  /** 目标推文作者名(标题用),可能 null */
  authorName: string | null
  /** 目标推文作者 handle(副标题 fallback),可能 null */
  authorHandle: string | null
  /** 该 campaign 的原始 actionType 列表(拍平前) */
  actionTypes: string[]
  /** 去重展开后需检测的原语动作 */
  requiredActions: GuideAction[]
  /** 跨所有 action entry 汇总的奖励(LUX) */
  totalReward: number
  /** COMMENT 类关键字(首个非空) */
  commentKeyword: string | null
  commentGuide?: string | null
  commentGuideStatus: CommentGuideStatus
  /** FOLLOW 目标 handle(首个非空,小写) */
  targetUsername: string | null
  /** 该 campaign 是否为当前用户已预约(RESERVED)。挑选「当前任务」时已预约的优先。 */
  reserved: boolean
  /** Historical participant fact; only true is displayed. */
  lighthouseSelectedAtClaim?: boolean | null
}

/**
 * 把「按 action 拍平的 cache」按 campaignId 归并回「campaign 视图」:合并要求
 * 动作、汇总奖励、取 commentKeyword / targetUsername / author 的首个非空。返回
 * 按总奖励降序 —— 调用方取 [0] 作为该推文的「当前任务」。
 *
 * 入参可能是 `byTweet[tweetId]` 与 `byAuthor[handle]` 的合并列表:同一个 FOLLOW
 * 单会**同时**落进两个索引(flatten 时 byTweet 若有 tweetId + byAuthor 恒有),
 * 经 chrome.storage 序列化后成两个不同对象,故按 `(campaignId, actionType)` 去重,
 * 避免奖励 / 动作被重复计入。
 */
export function groupCampaigns(tasks: CampaignTaskCache[]): CurrentCampaign[] {
  const map = new Map<string, CurrentCampaign>()
  const seen = new Set<string>()
  for (const t of tasks) {
    const dedupKey = `${t.campaignId}\0${t.actionType}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    let v = map.get(t.campaignId)
    if (!v) {
      v = {
        campaignId: t.campaignId,
        authorName: t.authorName ?? null,
        authorHandle: t.authorHandle ?? null,
        actionTypes: [],
        requiredActions: [],
        totalReward: 0,
        commentKeyword: null,
        commentGuide: undefined,
        commentGuideStatus: 'unavailable',
        targetUsername: null,
        reserved: false,
        lighthouseSelectedAtClaim: undefined,
      }
      map.set(t.campaignId, v)
    }
    if (t.actionType === 'COMMENT' || t.actionType === 'COMMENT_LIKE') {
      v.commentGuide = t.commentGuide
      v.commentGuideStatus =
        t.commentGuideStatus ??
        (t.commentGuide === undefined ? 'unavailable' : 'ready')
    }
    v.actionTypes.push(t.actionType)
    v.totalReward += Number.isFinite(t.expectedReward) ? t.expectedReward : 0
    if (!v.commentKeyword && t.commentKeyword)
      v.commentKeyword = t.commentKeyword
    if (!v.targetUsername && t.targetUsername)
      v.targetUsername = t.targetUsername
    if (!v.authorName && t.authorName) v.authorName = t.authorName
    if (!v.authorHandle && t.authorHandle) v.authorHandle = t.authorHandle
    if (t.reserved) v.reserved = true
    if (
      v.lighthouseSelectedAtClaim === undefined &&
      t.lighthouseSelectedAtClaim !== undefined
    ) {
      v.lighthouseSelectedAtClaim = t.lighthouseSelectedAtClaim
    }
  }
  const out = [...map.values()]
  for (const v of out) v.requiredActions = requiredActionsForMany(v.actionTypes)
  // 已预约优先,其次总奖励降序。同一推文多 campaign 时,[0] 必须是用户实际预约
  // 的那个 —— 否则「当前任务」会显示奖励最高的可参与单,验证用错 campaignId →
  // NO_ACTIVE_RESERVATION(预约了评论、卡片却显示转发)。
  out.sort(
    (a, b) =>
      Number(b.reserved) - Number(a.reserved) || b.totalReward - a.totalReward,
  )
  return out
}
