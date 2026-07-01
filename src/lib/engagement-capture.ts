// ─────────────────────────────────────────────────────────────────────────
// [shadow 捕获] 从 X 请求/响应里抽取用户互动动作 + 映射到灯塔任务的纯逻辑。
// content(MAIN 捕获)与 background(映射上报)共用;无副作用,便于单测。
// 范围:LIKE / RT / COMMENT(GraphQL 请求体,tweet-id 映射)+ FOLLOW
// (friendships/create 响应体拿 screen_name,handle 映射)。撤销/收藏暂缓。
// ─────────────────────────────────────────────────────────────────────────

export type CaptureActionType = 'LIKE' | 'RT' | 'COMMENT' | 'FOLLOW'

export interface CapturedAction {
  actionType: CaptureActionType
  /** LIKE/RT/COMMENT:动作针对的推文 id。 */
  tweetId?: string
  /** FOLLOW:被关注者 handle(小写)。 */
  handle?: string
  /** 仅 COMMENT 带:发布的评论正文(用于后续评论审计 / 交付)。 */
  commentText?: string
}

/** 我们关心的 X GraphQL op(看请求体即可判定动作,无需读响应)。 */
export const CAPTURE_OPS = [
  'FavoriteTweet',
  'CreateRetweet',
  'CreateTweet',
] as const

/**
 * 从 X mutation 的请求体抽取一个互动动作(LIKE/RT/COMMENT)。返回 null = 不是
 * 我们关心的动作(未知 op / 原创推文而非评论 / 缺 tweet_id / body 解析失败)。
 */
export function extractCapturedAction(
  op: string | null | undefined,
  body: string | undefined,
): CapturedAction | null {
  if (!op || !body) return null
  // biome-ignore lint/suspicious/noExplicitAny: X 的 variables 结构随 op 动态变化
  let variables: Record<string, any>
  try {
    variables = JSON.parse(body).variables ?? {}
  } catch {
    return null
  }

  if (op === 'FavoriteTweet') {
    const tweetId = variables.tweet_id
    return tweetId ? { actionType: 'LIKE', tweetId: String(tweetId) } : null
  }
  if (op === 'CreateRetweet') {
    const tweetId = variables.tweet_id
    return tweetId ? { actionType: 'RT', tweetId: String(tweetId) } : null
  }
  if (op === 'CreateTweet') {
    // 评论 = 带 in_reply_to;原创推文没有 → 不是任务动作,忽略。
    const inReplyTo = variables.reply?.in_reply_to_tweet_id
    if (!inReplyTo) return null
    const text = variables.tweet_text ?? variables.text ?? undefined
    return {
      actionType: 'COMMENT',
      tweetId: String(inReplyTo),
      ...(text ? { commentText: String(text) } : {}),
    }
  }
  return null
}

/**
 * FOLLOW:REST `/1.1/friendships/create.json` 的**响应体**就是被关注的用户对象
 * (v1.1 顶层带 screen_name)→ 直接拿 handle,无需 user_id→handle 反查。
 * 返回 null = 非该接口 / 响应无 screen_name。
 */
export function extractFollowFromResponse(
  url: string | undefined,
  responseJson: unknown,
): CapturedAction | null {
  if (!url || !/\/friendships\/create/.test(url)) return null
  const handle =
    responseJson && typeof responseJson === 'object'
      ? (responseJson as { screen_name?: unknown }).screen_name
      : undefined
  if (typeof handle !== 'string' || !handle) return null
  return { actionType: 'FOLLOW', handle: handle.toLowerCase() }
}

/** 捕获到的动作是否满足某任务的 actionType。COMMENT_LIKE 组合任务放宽匹配。 */
export function actionMatchesTask(
  captured: CaptureActionType,
  taskActionType: string,
): boolean {
  if (taskActionType === captured) return true
  // COMMENT_LIKE = 评论+点赞组合任务;单独的 COMMENT 或 LIKE 都算部分证据。
  if (taskActionType === 'COMMENT_LIKE') {
    return captured === 'COMMENT' || captured === 'LIKE'
  }
  return false
}

export interface CampaignTaskLike {
  campaignId: string
  actionType: string
}

export interface TaskSnapshot {
  /** tweetId → 推文级任务(LIKE/RT/COMMENT)。 */
  byTweet: Record<string, CampaignTaskLike[]>
  /** author handle(小写)→ FOLLOW 任务。 */
  byAuthor: Record<string, CampaignTaskLike[]>
}

export interface MappedReport {
  campaignId: string
  actionType: CaptureActionType
  tweetId?: string
  handle?: string
  commentText?: string
}

/**
 * 把一个捕获动作映射到它命中的灯塔任务(可能多个 campaign)。
 * FOLLOW 走 byAuthor(handle);LIKE/RT/COMMENT 走 byTweet(tweetId)。
 */
export function mapCaptureToCampaigns(
  cap: CapturedAction,
  snapshot: TaskSnapshot,
): MappedReport[] {
  if (cap.actionType === 'FOLLOW') {
    if (!cap.handle) return []
    const tasks = snapshot.byAuthor[cap.handle.toLowerCase()] ?? []
    return tasks
      .filter((t) => t.actionType === 'FOLLOW')
      .map((t) => ({
        campaignId: t.campaignId,
        actionType: 'FOLLOW' as const,
        handle: cap.handle,
      }))
  }
  if (!cap.tweetId) return []
  const tasks = snapshot.byTweet[cap.tweetId] ?? []
  return tasks
    .filter((t) => actionMatchesTask(cap.actionType, t.actionType))
    .map((t) => ({
      campaignId: t.campaignId,
      actionType: cap.actionType,
      tweetId: cap.tweetId,
      ...(cap.commentText ? { commentText: cap.commentText } : {}),
    }))
}

export interface ReportedAction {
  // string(非 CaptureActionType):与 storage session 键 + 后端 actionType:String 契约一致
  actionType: string
  /** FOLLOW 无 tweetId(按 handle 匹配),故可选。 */
  tweetId?: string
  capturedAt: string
}

/**
 * 累积某 campaign 已捕获的动作(按 actionType 去重、后到覆盖)。
 * 必须累积上报:后端 recordCapture 是 latest-wins 覆盖,若每次只报单动作,
 * 多动作任务(如 LIKE+RT)会互相覆盖 → 漏判。故每次报「该 campaign 至今全部动作」。
 */
export function mergeAction(
  prev: ReportedAction[] | undefined,
  next: ReportedAction,
): ReportedAction[] {
  const out = (prev ?? []).filter((a) => a.actionType !== next.actionType)
  out.push(next)
  return out
}
