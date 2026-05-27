import { SYNC_INTERVAL_SECONDS, VERIFY_RETRY_DELAY_MS, WEB_ENDPOINT } from '@/lib/env'
import { GqlError, gql } from '@/lib/gql'
import { broadcastToContent, onMessage } from '@/lib/messaging'
import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  AVAILABLE_TWEETS_QUERY,
  type AvailableEngagementsResult,
  type AvailableTweet,
  type AvailableTweetsResult,
  CREATE_EXTENSION_PAIRING_MUTATION,
  type CreateExtensionPairingResult,
  type EngagementActionType,
  ME_QUERY,
  type MeResult,
  POLL_EXTENSION_PAIRING_QUERY,
  type PollExtensionPairingResult,
  RECORD_TWEET_DWELL_MUTATION,
  RESERVE_SLOT_MUTATION,
  type ReserveSlotResult,
  VERIFY_ENGAGEMENT_MUTATION,
  type VerifyEngagementResult,
} from '@/lib/queries'
import {
  type ActiveCampaignSummary,
  type CampaignTaskCache,
  localStore,
  sessionStore,
  type TweetCampaignSummary,
  type UserProfile,
} from '@/lib/storage'
import { extractTweetIdFromUrl } from '@/lib/twitter-dom'
import type {
  MsgResponse,
  PairingState,
  SubmitErrorCode,
} from '@/types/messages'

const ALARM_NAME = 'lhdao-sync'
const SUPPORTED_ACTIONS = new Set<EngagementActionType>([
  'LIKE',
  'RT',
  'COMMENT',
  'COMMENT_LIKE',
  'FOLLOW',
])

/**
 * 把 plugin token 脱敏成 popup 展示用的形式:
 *   lhdao_pk_aBcD...xyz8f3d  →  lhdao_pk_••••••••8f3d
 *
 * 保留 prefix 标识(让用户一眼认出"是个 lhdao_pk_ token")+ 末 4 字符
 * (足够用户判断"是不是我刚粘贴的那个"),中间一律 8 个 bullet。
 */
function maskToken(token: string): string {
  if (!token) return ''
  if (token.length < 13) return token // 太短无法 mask
  const prefix = token.startsWith('lhdao_pk_') ? 'lhdao_pk_' : token.slice(0, 4)
  const suffix = token.slice(-4)
  return `${prefix}••••••••${suffix}`
}

/**
 * Background service worker.
 *
 *   - 启动 / 60s alarm 触发 → syncTasks() 拉取可参与任务,扁平化进 sessionStore
 *   - content script 来 RPC → 响应任务查询 / 处理 chip 点击 reserve+verify
 *   - 任务列表更新后广播 'tasks-updated',content script 收到立刻 rescan
 */
export default defineBackground(() => {
  console.log('[lhdao] background worker booted')

  // 启动立刻 sync 一次,然后每 60s
  void syncTasks()
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: SYNC_INTERVAL_SECONDS / 60,
  })
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM_NAME) void syncTasks()
  })

  onMessage(async (req): Promise<MsgResponse> => {
    if (req.type === 'get-tasks-for-tweet') {
      const map = (await sessionStore.get('tasksByTweetId')) ?? {}
      return { type: 'tasks', tasks: map[req.tweetId] ?? [] }
    }
    if (req.type === 'get-tasks-for-author') {
      const map = (await sessionStore.get('tasksByAuthorHandle')) ?? {}
      const handle = req.authorHandle.toLowerCase()
      return { type: 'tasks', tasks: map[handle] ?? [] }
    }
    if (req.type === 'get-tasks-snapshot') {
      // 整体快照 — content script 启动 + tasks-updated 时各拉一次,本地缓存
      // 后 scan 直接同步查,避免 per-article RPC 串行 await 的肉眼延迟。
      const byTweet = (await sessionStore.get('tasksByTweetId')) ?? {}
      const byAuthor = (await sessionStore.get('tasksByAuthorHandle')) ?? {}
      return { type: 'tasks-snapshot', byTweet, byAuthor }
    }
    if (req.type === 'submit-task') {
      return submitTask(req.campaignId)
    }
    if (req.type === 'reserve-task') {
      return reserveOnly(req.campaignId, req.confirmCascade)
    }
    if (req.type === 'verify-task') {
      return verifyOnly(req.campaignId)
    }
    if (req.type === 'record-dwell') {
      // fire-and-forget: 失败不影响用户,只 console.warn
      void recordDwell(
        req.tweetId,
        req.durationMs,
        req.tweetUrl ?? null,
        req.authorHandle ?? null,
      )
      return { type: 'ack' }
    }
    if (req.type === 'get-active-campaigns') {
      const campaigns = (await sessionStore.get('activeCampaigns')) ?? []
      return { type: 'active-campaigns', campaigns }
    }
    if (req.type === 'get-sidebar-data') {
      const token = await localStore.get('apiToken')
      const tokenConfigured = !!token
      const profile = (await sessionStore.get('userProfile')) ?? null
      const tweetCampaigns = (await sessionStore.get('tweetCampaigns')) ?? null
      return {
        type: 'sidebar-data',
        profile,
        tweetCampaigns,
        tokenConfigured,
      }
    }
    if (req.type === 'has-token') {
      const token = await localStore.get('apiToken')
      return { type: 'token-status', configured: !!token }
    }
    if (req.type === 'get-popup-data') {
      // popup 一次拿全:token / profile / 任务计数 / sync 状态
      const token = await localStore.get('apiToken')
      const profile = (await sessionStore.get('userProfile')) ?? null
      const map = (await sessionStore.get('tasksByTweetId')) ?? {}
      let taskCount = 0
      let tweetCount = 0
      for (const arr of Object.values(map)) {
        if (arr.length > 0) {
          tweetCount += 1
          taskCount += arr.length
        }
      }
      return {
        type: 'popup-data',
        hasToken: !!token,
        tokenMasked: token ? maskToken(token) : null,
        profile,
        taskCount,
        tweetCount,
        lastSyncAt: (await sessionStore.get('lastSyncAt')) ?? null,
        lastSyncError: (await sessionStore.get('lastSyncError')) ?? null,
        lastSyncHttpStatus:
          (await sessionStore.get('lastSyncHttpStatus')) ?? null,
      }
    }
    if (req.type === 'force-sync') {
      // popup "刷新" 按钮的入口 — 等 sync 跑完再 return,UI 可以即时
      // 看到错误或最新计数,不用等下一个 60s alarm。
      await syncTasks()
      const err = await sessionStore.get('lastSyncError')
      const httpStatus = await sessionStore.get('lastSyncHttpStatus')
      if (err) {
        return {
          type: 'sync-result',
          ok: false,
          error: err,
          httpStatus: httpStatus ?? undefined,
        }
      }
      const map = (await sessionStore.get('tasksByTweetId')) ?? {}
      let taskCount = 0
      let tweetCount = 0
      for (const arr of Object.values(map)) {
        if (arr.length > 0) {
          tweetCount += 1
          taskCount += arr.length
        }
      }
      return {
        type: 'sync-result',
        ok: true,
        lastSyncAt: (await sessionStore.get('lastSyncAt')) ?? Date.now(),
        taskCount,
        tweetCount,
      }
    }
    // ── Extension Pairing (一键登录) ─────────────────────────────────
    if (req.type === 'start-pairing') {
      const r = await startPairing()
      if (r.ok) return { type: 'pairing-started', ok: true, code: r.code }
      return { type: 'pairing-started', ok: false, reason: r.reason }
    }
    if (req.type === 'cancel-pairing') {
      await cancelPairing()
      return { type: 'ack' }
    }
    if (req.type === 'get-pairing-status') {
      return { type: 'pairing-status-result', state: pairingState }
    }
    return { type: 'ack' }
  })

  // token 写入 / 删除 → 立即重新 sync(用户在 options 页粘贴 token 后,
  // 不必等下一个 60s alarm 才看到任务)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'apiToken' in changes) {
      void syncTasks()
    }
  })
})

// ── sync ─────────────────────────────────────────────────────────────

async function syncTasks(): Promise<void> {
  const token = await localStore.get('apiToken')
  if (!token) {
    // 没 token 就清空所有缓存,避免遗留旧任务/旧余额误导
    await sessionStore.set('tasksByTweetId', {})
    await sessionStore.set('tasksByAuthorHandle', {})
    await sessionStore.set('activeCampaigns', [])
    await sessionStore.set('tweetCampaigns', [])
    await sessionStore.set('userProfile', null)
    await sessionStore.set('lastSyncError', 'No API token configured')
    await sessionStore.set('lastSyncHttpStatus', null)
    return
  }

  // 三个 query 并行拉,allSettled 让部分失败不阻塞其他成功的结果。
  // engagements → chip 高亮用;tweets → sidebar 列表用;me → sidebar 个人面板用。
  const [engRes, tweetsRes, meRes] = await Promise.allSettled([
    gql<AvailableEngagementsResult>(AVAILABLE_ENGAGEMENTS_QUERY),
    gql<AvailableTweetsResult>(AVAILABLE_TWEETS_QUERY),
    gql<MeResult>(ME_QUERY),
  ])

  // —— engagement → chip / activeCampaigns ——
  if (engRes.status === 'fulfilled') {
    const data = engRes.value
    const { byTweet, byAuthor } = flattenTasks(data.availableEngagements)
    const activeCampaigns = buildActiveCampaignSummaries(
      data.availableEngagements,
    )
    await sessionStore.set('tasksByTweetId', byTweet)
    await sessionStore.set('tasksByAuthorHandle', byAuthor)
    await sessionStore.set('activeCampaigns', activeCampaigns)
  } else {
    console.warn('[lhdao] availableEngagements failed', engRes.reason)
  }

  // —— tweets → sidebar 任务列表 ——
  if (tweetsRes.status === 'fulfilled') {
    const summaries = buildTweetCampaignSummaries(
      tweetsRes.value.availableTweets,
    )
    await sessionStore.set('tweetCampaigns', summaries)
  } else {
    console.warn('[lhdao] availableTweets failed', tweetsRes.reason)
    // 保留旧缓存 — 网络抖动时旧数据比空数据更可用
  }

  // —— me → sidebar 个人面板 ——
  if (meRes.status === 'fulfilled' && meRes.value.me) {
    const m = meRes.value.me
    // displayName 优先级: nickname > username > twitterUsername > null
    // (nickname 是用户主动设的;username 是登录名;twitter handle 兜底)
    const displayName = m.nickname ?? m.username ?? m.twitterUsername ?? null
    const profile: UserProfile = {
      id: m.id,
      displayName,
      avatar: m.avatar ?? null,
      twitterHandle: m.twitterUsername ?? null,
      tier: m.tier ?? null,
      // newLux 是 GraphQLDecimal scalar,后端传 string;显式转 number,
      // 不可解析(空串 / null / NaN)统一归一为 null,前端 formatBalance
      // 才能正确识别"无数据"显示横杠,而不是把 string "520" 当成 NaN
      newLux: parseNumber(m.newLux),
      // todayEarnings 后端 ResolveField 已 .toNumber(),是 number,直接用
      todayEarnings: m.todayEarnings ?? null,
    }
    await sessionStore.set('userProfile', profile)
  } else if (meRes.status === 'rejected') {
    console.warn('[lhdao] me failed', meRes.reason)
  }

  // —— 全局 sync 状态:任一关键 query 成功就算"同步过" ——
  // engagement 是 chip 的核心,优先用它的成功/失败做主判断;
  // 单 me 或 tweets 失败不算整体失败(部分降级展示)。
  if (engRes.status === 'fulfilled') {
    await sessionStore.set('lastSyncAt', Date.now())
    await sessionStore.set('lastSyncError', null)
    await sessionStore.set('lastSyncHttpStatus', null)
    broadcastToContent({ type: 'tasks-updated' })
  } else {
    const reason = engRes.reason
    const msg = reason instanceof Error ? reason.message : String(reason)
    const httpStatus =
      reason instanceof GqlError ? (reason.httpStatus ?? null) : null
    await sessionStore.set('lastSyncError', msg)
    await sessionStore.set('lastSyncHttpStatus', httpStatus)
  }
}

/**
 * 把 GraphQL response 里可能是 string(GraphQLDecimal)/ number(Float)/
 * null / undefined 的字段统一转 number。无法解析 → null。
 *
 * 用途:`me.newLux` 用 prisma-nestjs-graphql 的 GraphQLDecimal scalar,
 * 实际 wire 上是 string;别的地方有些字段是 Float。前端只想要 number。
 */
function parseNumber(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 把后端 availableTweets 整理成 sidebar 列表行数据。
 *
 * - 类型必须是 TWEET(防御性,后端 query 本来就只返 TWEET)
 * - **过滤已参与 (isParticipated) — 用户抢过 / 完成过的不再展示**
 * - **过滤已售罄 (isSoldOut) — 席位满的不再展示(KOL 抢不到了)**
 * - 奖励优先 myExpectedReward(我 tier 下的精确值),fallback expectedReward
 * - brief 优先 description,fallback title,都没就 null
 * - 按 myExpectedReward / expectedReward 降序排,值钱的靠前
 *
 * 后端 `listAvailableTweets` 会返回所有 ACTIVE TWEET campaign(包括用户已抢的
 * 和已售罄的),用 isParticipated / isSoldOut 字段标注。sidebar 是"我现在
 * 还能抢什么"视图,只展示**真正可抢**的。
 */
function buildTweetCampaignSummaries(
  tweets: AvailableTweet[],
): TweetCampaignSummary[] {
  const result: TweetCampaignSummary[] = []
  for (const t of tweets) {
    if (t.type !== 'TWEET') continue
    if (t.isParticipated) continue
    if (t.isSoldOut) continue
    const reward = t.myExpectedReward ?? t.expectedReward ?? 0
    result.push({
      campaignId: t.id,
      projectName: t.projectName ?? null,
      brief: t.description ?? t.title ?? null,
      rewardLux: reward,
      submitClose: t.submitClose ?? null,
      targetUrl: t.targetUrl ?? null,
    })
  }
  result.sort((a, b) => b.rewardLux - a.rewardLux)
  return result
}

/**
 * 把后端 engagement 列表整理成 sidebar 卡片用的精简 summary。
 *
 * 跟 flattenTasks 平行:flattenTasks 给推文页 chip 用 (per-tweetId),
 * 这个给 sidebar 列表用 (per-campaign)。两者**字段不同但来源相同**,
 * 一次 sync 同时算好。
 *
 * 过滤:
 *  - 非 ENGAGEMENT 类型
 *  - 没有 targetUrl / tweetId
 *  - actions 全是 unsupported 类型
 */
function buildActiveCampaignSummaries(
  engagements: AvailableEngagementsResult['availableEngagements'],
): ActiveCampaignSummary[] {
  const result: ActiveCampaignSummary[] = []
  for (const c of engagements) {
    if (c.type !== 'ENGAGEMENT') continue
    const tweetId =
      c.tweetId ?? (c.targetUrl ? extractTweetIdFromUrl(c.targetUrl) : null)
    if (!tweetId || !c.targetUrl) continue

    const supportedActions = c.actions.filter((a) =>
      SUPPORTED_ACTIONS.has(a.actionType),
    )
    if (supportedActions.length === 0) continue

    // dedupe action types
    const actionTypes = Array.from(
      new Set(supportedActions.map((a) => a.actionType)),
    )

    // COMMENT 关键字提示
    const isCommentish = actionTypes.some(
      (t) => t === 'COMMENT' || t === 'COMMENT_LIKE',
    )
    const commentKeyword = isCommentish ? (c.keywords?.[0] ?? null) : null

    // 文本预览 (前 100 字符)
    const tweetPreview = c.tweetText ? c.tweetText.slice(0, 100) : null

    result.push({
      campaignId: c.id,
      rewardLux:
        c.expectedReward ??
        supportedActions.reduce((acc, a) => acc + a.baseReward, 0),
      actionTypes,
      tweetId,
      targetUrl: c.targetUrl,
      authorName: c.tweetAuthorName ?? null,
      authorHandle: c.tweetAuthorHandle ?? null,
      authorAvatar: c.tweetAuthorAvatar ?? null,
      tweetPreview,
      commentKeyword,
    })
  }
  // 按奖励降序排,高价值任务靠前
  result.sort((a, b) => b.rewardLux - a.rewardLux)
  return result
}

/**
 * 把后端返的 engagement 列表扁平化成两个索引:
 *
 *   byTweet  : tweetId   → tasks[] (LIKE / RT / COMMENT / COMMENT_LIKE)
 *   byAuthor : handle    → tasks[] (FOLLOW)
 *
 * **为什么拆两个索引**:LIKE/RT/COMMENT 绑定到具体推文(tweetId),FOLLOW
 * 绑定到账户(handle)。同一作者的不同推文 article 都需要看到 follow 任务,
 * 用 author handle 索引让 content script O(1) 查询。
 *
 * 同一个 FOLLOW 任务仍然在 byTweet 里存一份(挂在 targetUrl 对应的"代表推文"
 * 上),让用户在 campaign 来源推文上看到合并 chip(Q3:复合任务合并显示)。
 */
function flattenTasks(
  engagements: AvailableEngagementsResult['availableEngagements'],
): {
  byTweet: Record<string, CampaignTaskCache[]>
  byAuthor: Record<string, CampaignTaskCache[]>
} {
  const byTweet: Record<string, CampaignTaskCache[]> = {}
  const byAuthor: Record<string, CampaignTaskCache[]> = {}

  for (const c of engagements) {
    if (c.type !== 'ENGAGEMENT') continue
    const tweetId = c.targetUrl ? extractTweetIdFromUrl(c.targetUrl) : null
    // 注意:FOLLOW-only campaign 也可能没有 targetUrl(纯粹是关注账户,
    // 没有"代表推文")。所以 tweetId null 不能直接 skip 整条 campaign,
    // 要看 FOLLOW action 能否落到 author 索引上。
    const firstKeyword = c.keywords?.[0] ?? null
    const supportedActions = c.actions.filter((a) =>
      SUPPORTED_ACTIONS.has(a.actionType),
    )
    if (supportedActions.length === 0) continue

    const effectiveTotal = c.expectedReward
    const perAction =
      effectiveTotal != null ? effectiveTotal / supportedActions.length : null

    const targetUsername = c.targetUsername?.toLowerCase() ?? null

    for (const a of supportedActions) {
      const isCommentish =
        a.actionType === 'COMMENT' || a.actionType === 'COMMENT_LIKE'
      const isFollow = a.actionType === 'FOLLOW'

      const task: CampaignTaskCache = {
        campaignId: c.id,
        // tweetId 可能 null(纯 FOLLOW campaign);byTweet 索引时跳过没 tweetId
        // 的,byAuthor 索引照常落入
        tweetId: tweetId ?? '',
        actionType: a.actionType,
        expectedReward: perAction ?? a.baseReward,
        commentKeyword: isCommentish ? firstKeyword : null,
        targetUsername: isFollow ? targetUsername : null,
      }

      // —— byTweet 索引 ——
      // 所有 supported action(包括 FOLLOW)只要有 tweetId 就挂在那条推文上,
      // 让"来源推文" article 显示完整的复合任务奖励(Q3=a 语义)。
      if (tweetId) {
        const bucket = byTweet[tweetId] ?? []
        bucket.push(task)
        byTweet[tweetId] = bucket
      }

      // —— byAuthor 索引(仅 FOLLOW)——
      // FOLLOW 任务**还要**挂在该作者的所有其他推文上(timeline 上同一作者
      // 的多条推文都要看到 ring + 第一条挂 claim)。LIKE/RT/COMMENT 不进
      // author 索引,因为它们绑定具体推文不能跨推文展示。
      if (isFollow && targetUsername) {
        const bucket = byAuthor[targetUsername] ?? []
        bucket.push(task)
        byAuthor[targetUsername] = bucket
      }
    }
  }
  return { byTweet, byAuthor }
}

// ── submit (reserve + verify) ────────────────────────────────────────

/**
 * Chip 点击的完整流程:
 *   1. reserveEngagementSlot — 占席位
 *      - "Already participated" 视为成功,跳到 verify
 *      - SLOT_FULL / BOT_BLOCKED 直接返回失败,UI 给特定文案
 *   2. verifyEngagement — 系统去 Twitter API 校验是否真做了
 *      - 失败一次,等 5s 重试一次(Twitter API 缓存延迟兜底)
 *      - 第二次还失败就返回错误 code
 *   3. 成功后 syncTasks() 刷新缓存,chip 自动消失
 */
async function submitTask(campaignId: string): Promise<MsgResponse> {
  // —— Reserve ——
  try {
    await gql<ReserveSlotResult>(RESERVE_SLOT_MUTATION, { campaignId })
  } catch (e) {
    if (e instanceof GqlError) {
      const msg = e.message
      // 已经 reserve 过 → 跳过,直接 verify(幂等)
      if (!/Already participated/i.test(msg)) {
        return reserveError(msg, e.httpStatus)
      }
    } else {
      return {
        type: 'submit-result',
        ok: false,
        code: 'INTERNAL',
        message: String(e),
      }
    }
  }

  // —— Verify (1 retry) ——
  for (let i = 0; i < 2; i++) {
    try {
      const data = await gql<VerifyEngagementResult>(
        VERIFY_ENGAGEMENT_MUTATION,
        {
          campaignId,
        },
      )
      const reward = Number(data.verifyEngagement?.actualReward ?? 0)
      void syncTasks() // 刷新缓存,完成的任务消失
      return { type: 'submit-result', ok: true, reward }
    } catch (e) {
      const isLast = i === 1
      if (isLast) {
        const msg = e instanceof Error ? e.message : String(e)
        const httpStatus = e instanceof GqlError ? e.httpStatus : undefined
        return verifyError(msg, httpStatus)
      }
      await sleep(VERIFY_RETRY_DELAY_MS)
    }
  }

  return {
    type: 'submit-result',
    ok: false,
    code: 'INTERNAL',
    message: 'unreachable',
  }
}

interface CodedError {
  code: SubmitErrorCode
  message: string
}

function reserveErrorCode(msg: string, httpStatus?: number): CodedError {
  let code: SubmitErrorCode = 'RESERVE_FAILED'
  if (httpStatus === 401) code = 'TOKEN_INVALID'
  else if (/Slot full/i.test(msg)) code = 'SLOT_FULL'
  else if (/BotUserBlocked/i.test(msg)) code = 'BOT_BLOCKED'
  return { code, message: msg }
}

function verifyErrorCode(msg: string, httpStatus?: number): CodedError {
  let code: SubmitErrorCode = 'VERIFY_FAILED'
  if (httpStatus === 401) code = 'TOKEN_INVALID'
  else if (/CommentMissingKeyword/i.test(msg)) code = 'COMMENT_MISSING'
  else if (/WrongTwitterAccount/i.test(msg)) code = 'WRONG_X_ACCOUNT'
  else if (/TwitterApiNotReady/i.test(msg)) code = 'API_NOT_READY'
  else if (/ActionNotDetected|NotDetected/i.test(msg))
    code = 'ACTION_NOT_DETECTED'
  return { code, message: msg }
}

function reserveError(msg: string, httpStatus?: number): MsgResponse {
  const { code, message } = reserveErrorCode(msg, httpStatus)
  return { type: 'submit-result', ok: false, code, message }
}

function verifyError(msg: string, httpStatus?: number): MsgResponse {
  const { code, message } = verifyErrorCode(msg, httpStatus)
  return { type: 'submit-result', ok: false, code, message }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── dwell time recording (anti-cheat) ───────────────────────────────

/**
 * 上报推文详情页停留时长。不抛异常(失败仅 warn),不返回结果给 content
 * script — content 是 fire-and-forget。
 *
 * 未绑 token 的用户:gql 内部会抛 'No API token configured',这里 catch
 * 静默 — 等用户绑了 token 之后的 dwell 自然能上报。
 */
async function recordDwell(
  tweetId: string,
  durationMs: number,
  tweetUrl: string | null,
  authorHandle: string | null,
): Promise<void> {
  try {
    await gql(RECORD_TWEET_DWELL_MUTATION, {
      tweetId,
      durationMs,
      tweetUrl,
      authorHandle,
    })
  } catch (e) {
    console.warn('[lhdao] record dwell failed', e)
  }
}

// ── reserve / verify split (两步抢单) ───────────────────────────────

/**
 * 只调 reserveEngagementSlot,占席位但不验证。让用户去 Twitter 真正做
 * 动作后再触发 verify。"Already participated" 视为成功(用户已经抢过)。
 */
async function reserveOnly(
  campaignId: string,
  confirmCascade?: boolean,
): Promise<MsgResponse> {
  try {
    const data = await gql<ReserveSlotResult>(RESERVE_SLOT_MUTATION, {
      campaignId,
      confirmCascade: confirmCascade ?? null,
    })
    const r = data.reserveEngagementSlot

    if (r?.reserved) {
      return {
        type: 'reserve-result',
        ok: true,
        cooldownSeconds: r.cooldownSeconds ?? undefined,
      }
    }

    // —— reserved:false 的多种软失败情况,逐一辨认给 UI 友好文案 ——
    if (r?.cascadeWarning) {
      // 用户 tier 满了,后端建议级联到 effectiveTier 但需要前端再确认
      const w = r.cascadeWarning
      return {
        type: 'reserve-result',
        ok: false,
        code: 'RESERVE_FAILED',
        message: `本档已满,可降到 ${w.effectiveTier} 档拿 ${w.effectiveTierRewardLux} LUX (原 ${w.userTierRewardLux})。点重抢确认降档。`,
      }
    }

    const cooldown = r?.cooldownSeconds ?? 0
    if (cooldown > 0) {
      // 批次未释放 / 曲线冷却中,backend 给了下次释放秒数
      const min = Math.floor(cooldown / 60)
      const sec = cooldown % 60
      const human = min > 0 ? `${min}m${sec}s` : `${sec}s`
      return {
        type: 'reserve-result',
        ok: false,
        code: 'SLOT_FULL',
        message: `席位未释放,${human} 后再试 (active=${r?.activeReservations ?? '?'}, released=${r?.releasedSeats ?? '?'})`,
      }
    }

    // 没 cooldown + 没 cascade + reserved:false 通常是:
    //   - 活动 expiresAt 过了
    //   - 完成名额已满 (completedCount >= totalSeats)
    //   - tier 不在 tierSeats 名单 (effectiveTier == null,且 cascade 也没了)
    return {
      type: 'reserve-result',
      ok: false,
      code: 'RESERVE_FAILED',
      message: 'Slot unavailable (expired / slots full / tier not eligible)',
    }
  } catch (e) {
    if (e instanceof GqlError) {
      if (/Already participated/i.test(e.message)) {
        return { type: 'reserve-result', ok: true } // 幂等成功
      }
      const { code, message } = reserveErrorCode(e.message, e.httpStatus)
      return { type: 'reserve-result', ok: false, code, message }
    }
    return {
      type: 'reserve-result',
      ok: false,
      code: 'INTERNAL',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 只调 verifyEngagement (1 次 5s 重试)。前提是用户已经 reserve 过且
 * 已经去 Twitter 完成动作。返回 actualReward。
 */
async function verifyOnly(campaignId: string): Promise<MsgResponse> {
  for (let i = 0; i < 2; i++) {
    try {
      const data = await gql<VerifyEngagementResult>(
        VERIFY_ENGAGEMENT_MUTATION,
        { campaignId },
      )
      const reward = Number(data.verifyEngagement?.actualReward ?? 0)
      void syncTasks()
      return { type: 'verify-result', ok: true, reward }
    } catch (e) {
      if (i === 1) {
        const msg = e instanceof Error ? e.message : String(e)
        const httpStatus = e instanceof GqlError ? e.httpStatus : undefined
        const { code, message } = verifyErrorCode(msg, httpStatus)
        return { type: 'verify-result', ok: false, code, message }
      }
      await sleep(VERIFY_RETRY_DELAY_MS)
    }
  }
  return {
    type: 'verify-result',
    ok: false,
    code: 'INTERNAL',
    message: 'unreachable',
  }
}

// ════════════════════════════════════════════════════════════════════════
// Extension Pairing (一键登录) state machine
// ════════════════════════════════════════════════════════════════════════
//
// Module-level mutable state — SW 重启会丢失,但 60s 内 polling 期间 fetch
// 活动让 SW 保活,实际不会发生。如果发生,用户重新点登录即可。
//
// Flow:
//   idle  ─start-pairing→  waiting ─poll READY→  success → (5s)→ idle
//                          waiting ─poll EXPIRED / 60s→ timeout
//                          waiting ─cancel→        cancelled
//                          any  ─exception→        error

let pairingState: PairingState = { kind: 'idle' }
let pollTimer: ReturnType<typeof setInterval> | null = null
let timeoutTimer: ReturnType<typeof setTimeout> | null = null
let resetTimer: ReturnType<typeof setTimeout> | null = null
let pairingTabId: number | null = null

const PAIRING_POLL_INTERVAL_MS = 2000
const PAIRING_TIMEOUT_MS = 60_000
const PAIRING_RESET_DELAY_MS = 5000

/**
 * 32-char hex code,~128 bit 熵 — 跟后端 ExtensionPairingService.CODE_REGEX
 * 一致。碰撞概率天文级低,3 次重试已经远超必要。
 */
function generatePairingCode(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 更新 state + 广播给所有 extension views(popup / options)。
 * popup 没开时 sendMessage 会 reject,silent 忽略。
 */
function setPairingState(next: PairingState): void {
  pairingState = next
  chrome.runtime
    .sendMessage({ type: 'pairing-status', state: next })
    .catch(() => {
      // popup / options 没打开是常态,no-op
    })
}

function clearPairingTimers(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (timeoutTimer !== null) {
    clearTimeout(timeoutTimer)
    timeoutTimer = null
  }
}

async function closePairingTab(): Promise<void> {
  if (pairingTabId === null) return
  const id = pairingTabId
  pairingTabId = null
  try {
    await chrome.tabs.remove(id)
  } catch {
    // tab 可能已被用户关掉,no-op
  }
}

/** 5s 后回 idle 让 UI 重置成"再来一次"状态 */
function scheduleReset(): void {
  if (resetTimer !== null) clearTimeout(resetTimer)
  resetTimer = setTimeout(() => {
    resetTimer = null
    if (
      pairingState.kind === 'success' ||
      pairingState.kind === 'timeout' ||
      pairingState.kind === 'cancelled' ||
      pairingState.kind === 'error'
    ) {
      setPairingState({ kind: 'idle' })
    }
  }, PAIRING_RESET_DELAY_MS)
}

async function startPairing(): Promise<
  { ok: true; code: string } | { ok: false; reason: string }
> {
  // 先清旧的(用户连点两次 / 上次没走完)
  if (pairingState.kind === 'waiting') {
    clearPairingTimers()
    await closePairingTab()
  }

  // 注册 code,极小概率冲突重试 3 次
  let code = ''
  let createOk = false
  for (let i = 0; i < 3; i++) {
    code = generatePairingCode()
    try {
      await gql<CreateExtensionPairingResult>(
        CREATE_EXTENSION_PAIRING_MUTATION,
        { code },
        { anonymous: true },
      )
      createOk = true
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/already in use/i.test(msg)) continue
      // 网络 / 其他错误 — 不重试,直接报
      const reason = msg
      setPairingState({ kind: 'error', reason })
      scheduleReset()
      return { ok: false, reason }
    }
  }
  if (!createOk) {
    const reason = 'Could not allocate pairing slot (3 collisions)'
    setPairingState({ kind: 'error', reason })
    scheduleReset()
    return { ok: false, reason }
  }

  // 开主站 connect 页
  const url = `${WEB_ENDPOINT}/extension/connect?code=${code}`
  try {
    const tab = await chrome.tabs.create({ url, active: true })
    pairingTabId = tab.id ?? null
  } catch (e) {
    const reason = `Failed to open authorization page: ${(e as Error).message}`
    setPairingState({ kind: 'error', reason })
    scheduleReset()
    return { ok: false, reason }
  }

  // state → waiting,启动 polling + 60s 超时
  setPairingState({ kind: 'waiting', code, startedAt: Date.now() })
  pollTimer = setInterval(() => {
    void pollPairingOnce(code)
  }, PAIRING_POLL_INTERVAL_MS)
  timeoutTimer = setTimeout(() => {
    void onPairingTimeout()
  }, PAIRING_TIMEOUT_MS)

  return { ok: true, code }
}

async function pollPairingOnce(code: string): Promise<void> {
  // 状态已变(取消 / 超时 / 完成),不再 poll
  if (pairingState.kind !== 'waiting' || pairingState.code !== code) return

  try {
    const r = await gql<PollExtensionPairingResult>(
      POLL_EXTENSION_PAIRING_QUERY,
      { code },
      { anonymous: true },
    )
    const { status, token } = r.pollExtensionPairing

    if (status === 'READY' && token) {
      clearPairingTimers()
      await localStore.set('apiToken', token)
      await closePairingTab()
      setPairingState({ kind: 'success' })
      scheduleReset()
      // storage.onChanged 监听器会自动 trigger syncTasks(),无需手动
      return
    }
    if (status === 'EXPIRED') {
      clearPairingTimers()
      await closePairingTab()
      setPairingState({ kind: 'timeout' })
      scheduleReset()
      return
    }
    // PENDING:继续下次 tick
  } catch (e) {
    // 网络偶发抖动不打断 polling — 等下次 tick 重试
    console.warn('[lhdao] poll pairing transient fail:', e)
  }
}

async function onPairingTimeout(): Promise<void> {
  if (pairingState.kind !== 'waiting') return
  clearPairingTimers()
  await closePairingTab()
  setPairingState({ kind: 'timeout' })
  scheduleReset()
}

async function cancelPairing(): Promise<void> {
  if (pairingState.kind !== 'waiting') return
  clearPairingTimers()
  await closePairingTab()
  setPairingState({ kind: 'cancelled' })
  scheduleReset()
}
