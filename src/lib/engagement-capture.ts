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
  /** COMMENT: X 成功响应返回的新回复 tweet id。 */
  resultTweetId?: string
}

/** 我们关心的 X GraphQL op(看请求体即可判定动作,无需读响应)。 */
export const CAPTURE_OPS = [
  'FavoriteTweet',
  'CreateRetweet',
  'CreateTweet',
  // 长评论 / X Premium 用户发评论走 CreateNoteTweet(不是 CreateTweet)。
  // 不覆盖它 → 这类评论捕获不到 → 验证判 COMMENT 未完成、不发奖。
  'CreateNoteTweet',
] as const

/**
 * 有界深度搜索:在对象任意层级找到 keys 里第一个「标量值」的键,返回其 String。
 * 用于 X 在不同入口/版本把 in_reply_to_tweet_id / tweet_id 嵌在不同路径时不漏。
 * 深度上限防环 + 防超大 payload 卡顿。
 */
function deepFindScalar(
  obj: unknown,
  keys: readonly string[],
  depth = 0,
): string | undefined {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const v = rec[k]
    if ((typeof v === 'string' || typeof v === 'number') && String(v)) {
      return String(v)
    }
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') {
      const found = deepFindScalar(v, keys, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

const REPLY_ID_KEYS = ['in_reply_to_tweet_id', 'in_reply_to_status_id'] as const

/**
 * 从 X mutation 的请求体抽取一个互动动作(LIKE/RT/COMMENT)。返回 null = 不是
 * 我们关心的动作(未知 op / 原创推文而非评论 / 缺 tweet_id / body 解析失败)。
 * 健壮性:tweet_id / in_reply_to 都先走显式路径、再有界深查兜底,X 改嵌套也不漏;
 * 但「无 reply id = 原创推文」严格返回 null,绝不把原创误判成评论。
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
    const tweetId =
      variables.tweet_id ?? deepFindScalar(variables, ['tweet_id'])
    return tweetId ? { actionType: 'LIKE', tweetId: String(tweetId) } : null
  }
  if (op === 'CreateRetweet') {
    const tweetId =
      variables.tweet_id ?? deepFindScalar(variables, ['tweet_id'])
    return tweetId ? { actionType: 'RT', tweetId: String(tweetId) } : null
  }
  if (op === 'CreateTweet' || op === 'CreateNoteTweet') {
    // 评论 = 带 in_reply_to;原创推文没有 → 不是任务动作,忽略。
    // CreateNoteTweet(长评论 / X Premium)与 CreateTweet reply 结构一致;X 在不同
    // 入口(详情页内联框 / 弹窗 / 引用)可能把 reply 嵌在不同路径,故先走显式常见
    // 路径,再有界深查该键 —— 只要 variables 里任何层级有 in_reply_to 就判评论,
    // X 改结构也不漏;深查找不到 = 真原创,返回 null 不误判。
    const inReplyTo =
      variables.reply?.in_reply_to_tweet_id ??
      variables.note_tweet?.reply?.in_reply_to_tweet_id ??
      deepFindScalar(variables, REPLY_ID_KEYS)
    if (!inReplyTo) return null
    const text =
      (typeof variables.tweet_text === 'string'
        ? variables.tweet_text
        : undefined) ??
      variables.note_tweet?.text ??
      variables.note_tweet?.tweet_text ??
      (typeof variables.text === 'string' ? variables.text : undefined) ??
      deepFindScalar(variables, ['tweet_text', 'text'])
    return {
      actionType: 'COMMENT',
      tweetId: String(inReplyTo),
      ...(text ? { commentText: String(text) } : {}),
    }
  }
  return null
}

export function extractCreatedCommentTweetId(
  op: string | null | undefined,
  responseJson: unknown,
): string | null {
  if (op !== 'CreateTweet' && op !== 'CreateNoteTweet') return null
  const data = asRecord(asRecord(responseJson).data)
  const roots =
    op === 'CreateTweet'
      ? [data.create_tweet]
      : [data.notetweet_create, data.create_note_tweet, data.create_tweet]
  for (const root of roots) {
    const result = asRecord(asRecord(root).tweet_results).result
    const direct = scalarId(asRecord(result).rest_id)
    if (direct) return direct
    const nested = scalarId(asRecord(asRecord(result).tweet).rest_id)
    if (nested) return nested
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
  resultTweetId?: string
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
      ...(cap.resultTweetId ? { resultTweetId: cap.resultTweetId } : {}),
    }))
}

export interface ReportedAction {
  // string(非 CaptureActionType):与 storage session 键 + 后端 actionType:String 契约一致
  actionType: string
  /** FOLLOW 无 tweetId(按 handle 匹配),故可选。 */
  tweetId?: string
  /** FOLLOW 被关注 handle(无 @,小写)。绑进签名 + 供后端权威验关注。 */
  handle?: string
  /** COMMENT/COMMENT_LIKE 的评论正文。持久化到 session,verifyOnly 随签名提交带上,
   *  供插件权威路径落库 / auto-title(否则发奖后评论正文丢失)。 */
  commentText?: string
  resultTweetId?: string
  capturedAt: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function scalarId(value: unknown): string | null {
  return typeof value === 'string' && /^\d+$/u.test(value) ? value : null
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
