import { dbg } from '@/lib/capture-debug'
import { getOrCreateDeviceIdentity } from '@/lib/device-key'
import {
  type CapturedAction,
  mapCaptureToCampaigns,
  mergeAction,
} from '@/lib/engagement-capture'
import {
  SYNC_INTERVAL_SECONDS,
  VERIFY_RETRY_DELAY_MS,
  WEB_ENDPOINT,
} from '@/lib/env'
import { GqlError, gql } from '@/lib/gql'
import { withBackoffJitter } from '@/lib/gql-backoff'
import { broadcastToContent, onMessage } from '@/lib/messaging'
import {
  controllerStateToPublicSource,
  ProductExperienceController,
  type ProductExperienceRuntimeSender,
} from '@/lib/product-experience-controller'
import { signProductExperienceProof } from '@/lib/product-experience-proof'
import { projectPublicProductExperienceState } from '@/lib/product-experience-task-bridge'
import {
  buildProofCanonical,
  hmacSignProof,
  randomProofNonce,
} from '@/lib/proof'
import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  AVAILABLE_TWEETS_QUERY,
  type AvailableEngagementsResult,
  type AvailableTweet,
  type AvailableTweetsResult,
  CREATE_AUTO_REINVEST_MUTATION,
  CREATE_EXTENSION_PAIRING_MUTATION,
  type CreateAutoReinvestResult,
  type CreateAutoReinvestVars,
  type CreateExtensionPairingResult,
  type CreateExtensionPairingVars,
  type EngagementActionType,
  LIGHTHOUSE_MEMBERS_QUERY,
  type LighthouseMember,
  type LighthouseMembersResult,
  ME_QUERY,
  type MeResult,
  MINT_ENGAGEMENT_TICKET_MUTATION,
  type MintEngagementTicketResult,
  MintProductExperienceTestTicketOperationName,
  type MintProductExperienceTestTicketVariables,
  MintProductExperienceTicketOperationName,
  type MintProductExperienceTicketVariables,
  MY_RESERVED_ENGAGEMENTS_QUERY,
  type MyReservedEngagementsResult,
  POLL_EXTENSION_PAIRING_QUERY,
  type PollExtensionPairingResult,
  PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
  PROMOTE_TWEET_MUTATION,
  type PromoteTweetResult,
  type PromoteTweetVars,
  parseMintProductExperienceTestTicketResult,
  parseMintProductExperienceTicketResult,
  parseSubmitProductExperienceProofResult,
  RECORD_TWEET_DWELL_MUTATION,
  REPORT_ENGAGEMENT_CAPTURE_MUTATION,
  RESERVE_SLOT_MUTATION,
  type ReportEngagementCaptureResult,
  type ReserveSlotResult,
  SUBMIT_ENGAGEMENT_PROOF_MUTATION,
  type SubmitEngagementProofResult,
  SubmitProductExperienceProofOperationName,
  type SubmitProductExperienceProofVariables,
  VERIFY_ENGAGEMENT_MUTATION,
  type VerifyEngagementResult,
} from '@/lib/queries'
import {
  childSpendActionKey,
  releaseSpendActionKey,
  releaseSpendActionKeyAfterDefiniteFailure,
  spendActionKey,
} from '@/lib/spend-idempotency'
import {
  type ActiveCampaignSummary,
  type CampaignTaskCache,
  localStore,
  productExperienceStore,
  type RawCapturedAction,
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
const RAW_CAPTURE_TTL_MS = 10 * 60 * 1000
const MAX_RAW_CAPTURES = 80
const SUPPORTED_ACTIONS = new Set<EngagementActionType>([
  'LIKE',
  'RT',
  'COMMENT',
  'COMMENT_LIKE',
  'FOLLOW',
])

function engagementReward(c: {
  myExpectedReward?: number | null
  expectedReward?: number | null
}): number | null {
  return c.myExpectedReward ?? c.expectedReward ?? null
}

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

function productRuntimeSender(
  sender: chrome.runtime.MessageSender,
): ProductExperienceRuntimeSender {
  let origin = sender.origin
  if (!origin && sender.url) {
    try {
      origin = new URL(sender.url).origin
    } catch {
      origin = undefined
    }
  }
  return {
    extensionId: sender.id,
    tabId: sender.tab?.id,
    frameId: sender.frameId,
    origin,
  }
}

function createProductExperienceController(): ProductExperienceController {
  return new ProductExperienceController({
    storage: productExperienceStore,
    async getActiveTab() {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      })
      return tab?.id != null && typeof tab.url === 'string'
        ? { id: tab.id, url: tab.url }
        : null
    },
    async inject(tabId) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/product-experience.js'],
      })
    },
    async mintParticipant(campaignId) {
      const result = await gql<unknown, MintProductExperienceTicketVariables>(
        PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
        { campaignId },
        { operationName: MintProductExperienceTicketOperationName },
      )
      return parseMintProductExperienceTicketResult(result)
        .mintProductExperienceTicket
    },
    async mintTest(campaignId) {
      const result = await gql<
        unknown,
        MintProductExperienceTestTicketVariables
      >(
        PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
        { campaignId },
        { operationName: MintProductExperienceTestTicketOperationName },
      )
      return parseMintProductExperienceTestTicketResult(result)
        .mintProductExperienceTestTicket
    },
    async submit(input: SubmitProductExperienceProofVariables) {
      const result = await gql<unknown, SubmitProductExperienceProofVariables>(
        PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
        input,
        { operationName: SubmitProductExperienceProofOperationName },
      )
      return parseSubmitProductExperienceProofResult(result)
    },
    now: () => Date.now(),
    randomNonce: randomProofNonce,
    randomSessionId: () => crypto.randomUUID(),
    runtimeId: () => chrome.runtime.id,
    sign: signProductExperienceProof,
    notifyStateChanged: async () => {
      broadcastToContent({ type: 'product-experience-state-changed' })
      await chrome.runtime
        .sendMessage({ type: 'product-experience-state-changed' })
        .catch(() => {
          // Popup and Lighthouse pages are usually closed.
        })
    },
  })
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

  const productExperienceController = createProductExperienceController()
  void productExperienceController.resumePendingSubmit()

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void productExperienceController.handleTabUpdated(tabId, {
      status: changeInfo.status,
      url: changeInfo.url ?? tab.url,
    })
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    void productExperienceController.handleTabRemoved(tabId)
  })

  // 启动立刻 sync 一次,然后每 60s
  void syncTasks()
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: SYNC_INTERVAL_SECONDS / 60,
  })
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM_NAME) void syncTasks()
  })

  onMessage(async (req, sender): Promise<MsgResponse> => {
    if (req.type === 'save-product-experience-task') {
      const result = await productExperienceController.saveTask(req.task)
      if (!result.saved) {
        return {
          type: 'save-product-experience-task-result',
          ok: false,
          correlationId: req.correlationId,
          error: 'SUBMISSION_PENDING',
          state: result.state,
        }
      }
      return {
        type: 'save-product-experience-task-result',
        ok: true,
        correlationId: req.correlationId,
        state: result.state,
      }
    }
    if (req.type === 'get-product-experience-state') {
      return {
        type: 'product-experience-state-result',
        state: await productExperienceController.getState(),
      }
    }
    if (req.type === 'get-public-product-experience-state') {
      const state = await productExperienceController.getState()
      return {
        type: 'public-product-experience-state-result',
        correlationId: req.correlationId,
        state: projectPublicProductExperienceState(
          req.campaignId,
          controllerStateToPublicSource(state),
          chrome.runtime.getManifest().version,
        ),
      }
    }
    if (req.type === 'start-product-experience') {
      return {
        type: 'product-experience-state-result',
        state: await productExperienceController.start(),
      }
    }
    if (req.type === 'product-experience-bootstrap') {
      const response = await productExperienceController.bootstrap(
        productRuntimeSender(sender),
      )
      return { type: 'product-experience-bootstrap-result', ...response }
    }
    if (req.type === 'product-experience-ready') {
      await productExperienceController.ready(
        productRuntimeSender(sender),
        req.sessionId,
      )
      return { type: 'product-experience-ack' }
    }
    if (req.type === 'product-experience-evidence') {
      await productExperienceController.handleEvidence(
        productRuntimeSender(sender),
        req.sessionId,
        req.matches,
      )
      return { type: 'product-experience-ack' }
    }
    if (req.type === 'product-experience-state-changed') {
      return { type: 'product-experience-ack' }
    }
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
      // ready = 是否至少同步成功过一次。消费方(CurrentTaskSection)用它区分
      // 「冷启未同步的空快照」与「已同步的真·无任务」,避免把前者误判成后者。
      const ready = (await sessionStore.get('lastSyncAt')) != null
      return { type: 'tasks-snapshot', byTweet, byAuthor, ready }
    }
    if (req.type === 'get-captured-actions') {
      // [网页 gate] 返回某 campaign 已捕获的动作类型。网页验证前预检:没捕获就
      // 直接判「未检测到动作」失败,不走异步乐观提交。tweetId 作别名兜底(捕获
      // 可能挂在另一 campaign 键上,按推文 id 扫一遍)。
      const cap = (await sessionStore.get('capturedActions')) ?? {}
      const types = new Set<string>()
      for (const a of cap[req.campaignId] ?? []) types.add(a.actionType)
      if (req.tweetId) {
        for (const acts of Object.values(cap)) {
          for (const a of acts) {
            if (a.tweetId === req.tweetId) types.add(a.actionType)
          }
        }
      }
      const pending = await getRawCapturedActions()
      if (pending.length > 0) {
        const byTweet = (await sessionStore.get('tasksByTweetId')) ?? {}
        const byAuthor = (await sessionStore.get('tasksByAuthorHandle')) ?? {}
        for (const raw of pending) {
          const mapped = mapCaptureToCampaigns(raw, { byTweet, byAuthor })
          if (mapped.some((m) => m.campaignId === req.campaignId)) {
            types.add(raw.actionType)
            continue
          }
          // 如果任务快照仍然慢半拍,网页 gate 至少能通过同 tweetId 的
          // tweet-level 动作预检;真正发奖仍会在 proof/worker 层按 campaign 校验。
          if (req.tweetId && raw.tweetId === req.tweetId) {
            types.add(raw.actionType)
          }
        }
      }
      return { type: 'captured-actions', actions: Array.from(types) }
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
    if (req.type === 'promote-tweet') {
      return promoteTweetHandler(req)
    }
    if (req.type === 'get-balance') {
      const p = await sessionStore.get('userProfile')
      return { type: 'balance-result', balance: p?.newLux ?? null }
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
    if (req.type === 'report-engagement-capture') {
      // fire-and-forget:非资金影子上报,失败静默(同 record-dwell)
      void handleEngagementCapture(req, req.capturedAt)
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
    if (req.type === 'open-task-hall') {
      // [B3] 验证成功后去任务广场:先查已开的本站标签页——
      //   已在任务广场(/campaigns)→ 直接聚焦(不 reload);
      //   有本站其它页 → 复用该标签,聚焦并导航到 /campaigns;
      //   都没有 → 才新建标签。避免每次验证都堆一个新标签。
      // URL 由后台自算(不接收 content 传入的任意 url)。查标签 URL 依赖
      // WEB_ENDPOINT 的 host_permission(见 wxt.config)。
      await openTaskHall()
      return { type: 'ack' }
    }
    if (req.type === 'open-campaign') {
      // [profile 关注卡] 验证成功后跳该 campaign 详情页(任务观察界面)。同
      // openTaskHall 的复用逻辑,只是 URL 带上 campaignId。
      await openCampaignDetail(req.campaignId)
      return { type: 'ack' }
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
    // ── Lighthouse member lookup(灯塔成员识别) ──────────────────────
    if (req.type === 'check-lighthouse-members') {
      const members = await checkLighthouseMembers(req.handles)
      return { type: 'lighthouse-members-result', members }
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

let syncInFlight: Promise<void> | null = null
let syncRetryTimer: ReturnType<typeof setTimeout> | null = null

function syncTasks(): Promise<void> {
  if (syncInFlight) return syncInFlight
  syncInFlight = performSyncTasks().finally(() => {
    syncInFlight = null
  })
  return syncInFlight
}

async function performSyncTasks(): Promise<void> {
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

  // 并行拉,allSettled 让部分失败不阻塞其他成功的结果。
  // engagements(可参与)+ reserved(我已预约)→ chip / 卡片当前任务;
  // tweets → sidebar 列表;me → sidebar 个人面板。
  // reserved 是关键:预约后该单会从 availableEngagements 消失,但卡片"当前任务"
  // 段需要它(打开推文=已预约)。两者合并进 tasksByTweetId。
  const [engRes, reservedRes, tweetsRes, meRes] = await Promise.allSettled([
    gql<AvailableEngagementsResult>(AVAILABLE_ENGAGEMENTS_QUERY),
    gql<MyReservedEngagementsResult>(MY_RESERVED_ENGAGEMENTS_QUERY),
    gql<AvailableTweetsResult>(AVAILABLE_TWEETS_QUERY),
    gql<MeResult>(ME_QUERY),
  ])

  // —— engagement(available + 我已预约)→ chip / card / activeCampaigns ——
  if (engRes.status === 'fulfilled') {
    const available = engRes.value.availableEngagements
    const reserved =
      reservedRes.status === 'fulfilled'
        ? reservedRes.value.myReservedEngagements
        : []
    if (reservedRes.status !== 'fulfilled') {
      console.warn('[lhdao] myReservedEngagements failed', reservedRes.reason)
    }
    const merged = [...available, ...reserved]
    // 已预约的 campaignId 集合 → flattenTasks 标进 task.reserved,让同推文多单时
    // 「当前任务」优先显示用户实际预约的那个(修 NO_ACTIVE_RESERVATION)。
    const reservedIds = new Set<string>(reserved.map((c) => c.id))
    const { byTweet, byAuthor } = flattenTasks(merged, reservedIds)
    const activeCampaigns = buildActiveCampaignSummaries(merged)
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
    queueRawCaptureReconcile()
    broadcastToContent({ type: 'tasks-updated' })
  } else {
    const reason = engRes.reason
    const msg = reason instanceof Error ? reason.message : String(reason)
    const httpStatus =
      reason instanceof GqlError ? (reason.httpStatus ?? null) : null
    await sessionStore.set('lastSyncError', msg)
    await sessionStore.set('lastSyncHttpStatus', httpStatus)
    if (reason instanceof GqlError && reason.retryAfterMs !== undefined) {
      scheduleSyncRetry(reason.retryAfterMs)
    }
  }
}

function scheduleSyncRetry(retryAfterMs: number): void {
  if (syncRetryTimer) clearTimeout(syncRetryTimer)
  syncRetryTimer = setTimeout(() => {
    syncRetryTimer = null
    void syncTasks()
  }, withBackoffJitter(retryAfterMs))
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
        engagementReward(c) ??
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
  /** 当前用户已预约(RESERVED)的 campaignId 集合(来自 myReservedEngagements)。
   *  标进 task.reserved,让「当前任务」在同推文多单时优先显示已预约的那个。 */
  reservedIds: Set<string> = new Set(),
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

    const effectiveTotal = engagementReward(c)
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
        authorName: c.tweetAuthorName ?? null,
        authorHandle: c.tweetAuthorHandle ?? null,
        reserved: reservedIds.has(c.id),
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
/**
 * 一键推广:调后端 promoteTweet(带 plugin token)建 ENGAGEMENT 商单。
 * 后端按平台价格表 + 余额校验 + 10% 手续费处理;前端只传 预算/动作/档位。
 */
async function promoteTweetHandler(req: {
  tweetUrl: string
  actions: { actionType: string; tierSlots: Record<string, number> }[]
  reinvestCount?: number
}): Promise<MsgResponse> {
  const token = await localStore.get('apiToken')
  if (!token) {
    return {
      type: 'promote-result',
      ok: false,
      code: 'NO_TOKEN',
      message: '请先在插件 options 配置 plugin token',
    }
  }
  const promoteVariables: PromoteTweetVars = {
    input: { tweetUrl: req.tweetUrl, actions: req.actions },
  }
  const promoteKey = spendActionKey('promote', promoteVariables)
  try {
    const data = await gql<PromoteTweetResult, PromoteTweetVars>(
      PROMOTE_TWEET_MUTATION,
      promoteVariables,
      { idempotencyKey: promoteKey },
    )
    const campaignIds = data.promoteTweet.map((c) => c.id)

    // 持续复投:给每个子单建 auto-reinvest 任务(best-effort,失败不影响推广成功)
    let reinvested = false
    if (req.reinvestCount && req.reinvestCount > 0 && campaignIds.length) {
      try {
        for (const id of campaignIds) {
          await gql<CreateAutoReinvestResult, CreateAutoReinvestVars>(
            CREATE_AUTO_REINVEST_MUTATION,
            { input: { campaignId: id, reinvestCount: req.reinvestCount } },
            { idempotencyKey: childSpendActionKey(promoteKey, id) },
          )
        }
        reinvested = true
      } catch (e) {
        console.warn('[lhdao] auto-reinvest setup failed:', e)
      }
    }

    releaseSpendActionKey('promote', promoteVariables)
    void syncTasks() // 刷新余额缓存
    return { type: 'promote-result', ok: true, campaignIds, reinvested }
  } catch (e) {
    // 只有确定性失败才换新键。5xx / internal / network / abort 可能发生在
    // 服务端已扣款建单、但成功响应丢失之后，必须保留原键供安全重试。
    if (e instanceof GqlError) {
      releaseSpendActionKeyAfterDefiniteFailure('promote', promoteVariables, e)
    }
    const msg = e instanceof GqlError ? e.message : String(e)
    const httpStatus = e instanceof GqlError ? e.httpStatus : undefined
    let code = 'INTERNAL'
    if (httpStatus === 401) code = 'TOKEN_INVALID'
    else if (/Insufficient|余额/.test(msg)) code = 'INSUFFICIENT_BALANCE'
    else if (/DUPLICATE/.test(msg)) code = 'DUPLICATE'
    else if (/最低|MIN_BUDGET/.test(msg)) code = 'MIN_BUDGET'
    return { type: 'promote-result', ok: false, code, message: msg }
  }
}

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

/**
 * [shadow 捕获] 串行化闸门:doHandleEngagementCapture 是异步 read-modify-write
 * (读 capturedActions → 合并 → 写回),并发调用会互相覆盖内存累积。用一条
 * promise 链串起来消除竞态(shadow 非资金,串行代价可接受)。
 */
let captureChain: Promise<void> = Promise.resolve()

function rawCaptureKey(cap: {
  actionType: string
  tweetId?: string
  handle?: string
  commentText?: string
  resultTweetId?: string
  capturedAt: string
}): string {
  return [
    cap.actionType,
    cap.tweetId ?? '',
    cap.handle?.toLowerCase() ?? '',
    cap.commentText ?? '',
    cap.resultTweetId ?? '',
    cap.capturedAt,
  ].join('|')
}

function toRawCapturedAction(
  cap: CapturedAction,
  capturedAt: string,
): RawCapturedAction {
  return {
    actionType: cap.actionType,
    ...(cap.tweetId ? { tweetId: cap.tweetId } : {}),
    ...(cap.handle ? { handle: cap.handle.toLowerCase() } : {}),
    ...(cap.commentText ? { commentText: cap.commentText } : {}),
    ...(cap.resultTweetId ? { resultTweetId: cap.resultTweetId } : {}),
    capturedAt,
    expiresAt: Date.now() + RAW_CAPTURE_TTL_MS,
  }
}

async function getRawCapturedActions(): Promise<RawCapturedAction[]> {
  const now = Date.now()
  const raw = (await sessionStore.get('rawCapturedActions')) ?? []
  const alive = raw.filter((a) => a.expiresAt > now).slice(-MAX_RAW_CAPTURES)
  if (alive.length !== raw.length) {
    await sessionStore.set('rawCapturedActions', alive)
  }
  return alive
}

async function saveRawCapturedAction(
  cap: CapturedAction,
  capturedAt: string,
): Promise<RawCapturedAction> {
  const raw = toRawCapturedAction(cap, capturedAt)
  const pending = await getRawCapturedActions()
  const key = rawCaptureKey(raw)
  const next = pending.filter((a) => rawCaptureKey(a) !== key)
  next.push(raw)
  await sessionStore.set('rawCapturedActions', next.slice(-MAX_RAW_CAPTURES))
  return raw
}

async function removeRawCapturedAction(raw: RawCapturedAction): Promise<void> {
  const key = rawCaptureKey(raw)
  const pending = await getRawCapturedActions()
  await sessionStore.set(
    'rawCapturedActions',
    pending.filter((a) => rawCaptureKey(a) !== key),
  )
}

function queueRawCaptureReconcile(): void {
  captureChain = captureChain
    .then(() => reconcileRawCapturedActions())
    .catch(() => {})
}

async function reportMappedCaptures(
  mapped: ReturnType<typeof mapCaptureToCampaigns>,
  capturedAt: string,
  snapshot: {
    byTweet: Record<string, CampaignTaskCache[]>
    byAuthor: Record<string, CampaignTaskCache[]>
  },
): Promise<void> {
  if (mapped.length === 0) return

  dbg('bg 映射到', mapped.length, '个 campaign,开始上报')
  const acc = (await sessionStore.get('capturedActions')) ?? {}
  for (const m of mapped) {
    const next =
      m.actionType === 'FOLLOW' && m.handle
        ? {
            actionType: m.actionType,
            handle: m.handle.toLowerCase(),
            capturedAt,
          }
        : m.tweetId
          ? {
              actionType: m.actionType,
              tweetId: m.tweetId,
              // COMMENT/COMMENT_LIKE 持久化评论正文,供 verifyOnly 随签名提交
              ...(m.commentText ? { commentText: m.commentText } : {}),
              ...(m.resultTweetId ? { resultTweetId: m.resultTweetId } : {}),
              capturedAt,
            }
          : { actionType: m.actionType, capturedAt }
    const merged = mergeAction(acc[m.campaignId], next)
    acc[m.campaignId] = merged // session 保留 commentText,供 verifyOnly 随签名提交
    await gql<ReportEngagementCaptureResult>(
      REPORT_ENGAGEMENT_CAPTURE_MUTATION,
      {
        input: {
          campaignId: m.campaignId,
          // 后端 CapturedActionInput 不接受每动作 commentText —— 剥掉,只发它认的
          // 字段;评论正文走下面顶层 input.commentText(否则 GraphQL 校验整条上报被拒,
          // 导致捕获没落库、验证提交 0 动作被拒)。
          actions: merged.map((a) => ({
            actionType: a.actionType,
            ...(a.tweetId ? { tweetId: a.tweetId } : {}),
            ...(a.handle ? { handle: a.handle } : {}),
            ...(a.resultTweetId ? { resultTweetId: a.resultTweetId } : {}),
            capturedAt: a.capturedAt,
          })),
          ...(m.commentText ? { commentText: m.commentText } : {}),
        },
      },
    )
    dbg(
      'bg 上报成功',
      m.campaignId,
      merged.map((x) => x.actionType),
    )
  }

  // 剪枝:只留仍在当前活跃任务集(byTweet + byAuthor)里的 campaign,防
  // capturedActions 无界增长(chrome.storage.session 跨 SW 重启不清)。
  const activeIds = new Set<string>()
  for (const tasks of Object.values(snapshot.byTweet)) {
    for (const t of tasks) activeIds.add(t.campaignId)
  }
  for (const tasks of Object.values(snapshot.byAuthor)) {
    for (const t of tasks) activeIds.add(t.campaignId)
  }
  const pruned: typeof acc = {}
  for (const id of Object.keys(acc)) {
    if (activeIds.has(id)) pruned[id] = acc[id]
  }
  await sessionStore.set('capturedActions', pruned)
}

async function reconcileRawCapturedActions(): Promise<void> {
  const token = await localStore.get('apiToken')
  if (!token) return

  const pending = await getRawCapturedActions()
  if (pending.length === 0) return

  const byTweet = (await sessionStore.get('tasksByTweetId')) ?? {}
  const byAuthor = (await sessionStore.get('tasksByAuthorHandle')) ?? {}
  const keep: RawCapturedAction[] = []
  let replayed = 0

  for (const raw of pending) {
    const mapped = mapCaptureToCampaigns(raw, { byTweet, byAuthor })
    if (mapped.length === 0) {
      keep.push(raw)
      continue
    }
    try {
      await reportMappedCaptures(mapped, raw.capturedAt, { byTweet, byAuthor })
      replayed += 1
    } catch (e) {
      console.warn('[lhdao] replay raw engagement capture failed', e)
      keep.push(raw)
    }
  }

  if (replayed > 0) {
    dbg('bg 重放原始捕获成功', replayed, '条')
  }
  await sessionStore.set('rawCapturedActions', keep.slice(-MAX_RAW_CAPTURES))
}

/**
 * [shadow 捕获] 把插件捕获到的一个互动动作映射到命中的 campaign 并上报后端。
 * 无 token → 静默(同 dwell);该 tweet 暂无匹配任务 → 先暂存原始动作并强制
 * sync,等 RESERVED campaign 进入快照后重放。多动作累积上报(session
 * capturedActions),避免后端 latest-wins 覆盖漏判。fire-and-forget,串行。
 */
function handleEngagementCapture(
  cap: CapturedAction,
  capturedAt: string,
): Promise<void> {
  captureChain = captureChain
    .then(() => doHandleEngagementCapture(cap, capturedAt))
    .catch(() => {})
  return captureChain
}

async function doHandleEngagementCapture(
  cap: CapturedAction,
  capturedAt: string,
): Promise<void> {
  try {
    dbg('bg 收到捕获', cap.actionType, cap.tweetId ?? cap.handle)
    const token = await localStore.get('apiToken')
    if (!token) {
      dbg('bg 丢弃:无 apiToken')
      return
    }
    const raw = await saveRawCapturedAction(cap, capturedAt)
    const byTweet = (await sessionStore.get('tasksByTweetId')) ?? {}
    const byAuthor = (await sessionStore.get('tasksByAuthorHandle')) ?? {}
    const mapped = mapCaptureToCampaigns(cap, { byTweet, byAuthor })
    if (mapped.length === 0) {
      dbg(
        'bg 暂存:无匹配任务(tweet 不在快照,或该任务动作类型与捕获不符),触发同步后重放。',
        'tweetId=',
        cap.tweetId,
        '快照该推任务=',
        cap.tweetId
          ? (byTweet[cap.tweetId] ?? []).map((t) => t.actionType)
          : '-',
      )
      await syncTasks()
      return
    }
    await reportMappedCaptures(mapped, capturedAt, { byTweet, byAuthor })
    await removeRawCapturedAction(raw)
  } catch (e) {
    console.warn('[lhdao] report engagement capture failed', e)
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
 * [B3] 插件专用验证:mint 票据 → 组装捕获证明(actions + nonce + ts + HMAC 签名)
 * → submitEngagementProof。取代对 plugin token 403 的 verifyEngagement。
 *
 * 前提:用户已在**网页**预约该 campaign(mint 要求 RESERVED)且已去 Twitter 做动作。
 * 发奖仍在后端 worker(Phase3 Twitter 权威 / Phase4 插件权威),故 submit 只回
 * accepted/status,不返 reward —— UI 显"已提交,发放中",余额由 syncTasks 稍后刷新。
 */
async function verifyOnly(campaignId: string): Promise<MsgResponse> {
  try {
    // 验证前先尝试把短缓存里的原始捕获重放一次,避免"刚完成动作但
    // capturedActions 还没落 campaignId"时提交空 proof。
    queueRawCaptureReconcile()
    await captureChain

    // 1) mint 票据(要求已 RESERVED;返回 ticket + 一次性 macKey)
    const mint = await gql<MintEngagementTicketResult>(
      MINT_ENGAGEMENT_TICKET_MUTATION,
      { campaignId },
    )
    const { ticket, macKey } = mint.mintEngagementTicket

    // 2) 该 campaign 已捕获的动作(session 累积,来自 __lhcap)
    const capMap = (await sessionStore.get('capturedActions')) ?? {}
    const actions = (capMap[campaignId] ?? []).map((a) => ({
      actionType: a.actionType,
      tweetId: a.tweetId,
      handle: a.handle, // FOLLOW 被关注 handle,后端 recordCapture + canonical 需要
      resultTweetId: a.resultTweetId,
      capturedAt: a.capturedAt,
    }))
    if (actions.length === 0) {
      return {
        type: 'verify-result',
        ok: false,
        code: 'ACTION_NOT_DETECTED',
        message:
          '插件还没有检测到你的动作。请确认 X 页面已完成点赞/转发/评论/关注,等待几秒或点击插件刷新后再验证。',
      }
    }
    // 评论正文:取本 campaign 捕获里第一个带 commentText 的动作。随签名提交,后端
    // 插件权威路径落库 / auto-title 才拿得到(否则发奖后评论正文丢失)。commentText
    // 也进 canonical(sha256),故两端必须一致带上。
    const commentText = (capMap[campaignId] ?? []).find(
      (a) => a.commentText,
    )?.commentText

    // 3) 组装证明 + 签名(canonical 与后端逐字节一致)
    const ts = Math.floor(Date.now() / 1000)
    const nonce = randomProofNonce()
    const canonical = await buildProofCanonical({
      campaignId,
      ts,
      nonce,
      actions: actions.map((a) => ({
        actionType: a.actionType,
        tweetId: a.tweetId ?? null,
        handle: a.handle ?? null,
        resultTweetId: a.resultTweetId ?? null,
      })),
      commentText,
    })
    const sig = await hmacSignProof(macKey, canonical)

    // 4) 提交证明(commentText 随签名一并提交,后端 recordCapture 落库供权威路径读)
    const res = await gql<SubmitEngagementProofResult>(
      SUBMIT_ENGAGEMENT_PROOF_MUTATION,
      {
        input: {
          campaignId,
          ticket,
          sig,
          nonce,
          ts,
          actions,
          ...(commentText ? { commentText } : {}),
        },
      },
    )
    const r = res.submitEngagementProof
    if (r.accepted) {
      void syncTasks()
      // reward 异步发放,submit 不返金额 → reward:0,UI 回退显示预期奖励/发放中。
      return { type: 'verify-result', ok: true, reward: 0 }
    }
    const { code, message } = verifyErrorCode(
      r.reason ?? r.status ?? 'VERIFY_FAILED',
      undefined,
    )
    return { type: 'verify-result', ok: false, code, message }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const httpStatus = e instanceof GqlError ? e.httpStatus : undefined
    const { code, message } = verifyErrorCode(msg, httpStatus)
    return { type: 'verify-result', ok: false, code, message }
  }
}

/**
 * [B3] 去任务广场:优先复用已开的本站标签页,避免每次验证堆新标签。
 *   - 已在 /campaigns → 只聚焦(不 reload)
 *   - 有本站其它页 → 复用该标签,聚焦并导航到 /campaigns
 *   - 都没有 → 新建标签
 * 任何查询/聚焦失败一律兜底为直接新建。查标签 URL 依赖 WEB_ENDPOINT 的
 * host_permission(见 wxt.config)。
 */
async function openTaskHall(): Promise<void> {
  const origin = new URL(WEB_ENDPOINT).origin
  const url = `${WEB_ENDPOINT}/campaigns`
  try {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` })
    const onHall = tabs.find(
      (t) => t.id != null && (t.url ?? '').startsWith(url),
    )
    const target = onHall ?? tabs.find((t) => t.id != null)
    if (target?.id != null) {
      await chrome.tabs.update(
        target.id,
        onHall ? { active: true } : { active: true, url },
      )
      if (target.windowId != null) {
        await chrome.windows.update(target.windowId, { focused: true })
      }
      return
    }
  } catch {
    // 查询/聚焦失败 → 落到新建
  }
  try {
    await chrome.tabs.create({ url, active: true })
  } catch {
    // ignore — 开标签失败不影响主流程
  }
}

/** 跳该 campaign 详情页(任务观察界面)。复用 openTaskHall 的「复用已开标签」逻辑。 */
async function openCampaignDetail(campaignId: string): Promise<void> {
  const origin = new URL(WEB_ENDPOINT).origin
  const url = `${WEB_ENDPOINT}/campaigns/${encodeURIComponent(campaignId)}`
  try {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` })
    const onDetail = tabs.find(
      (t) => t.id != null && (t.url ?? '').startsWith(url),
    )
    const target = onDetail ?? tabs.find((t) => t.id != null)
    if (target?.id != null) {
      await chrome.tabs.update(
        target.id,
        onDetail ? { active: true } : { active: true, url },
      )
      if (target.windowId != null) {
        await chrome.windows.update(target.windowId, { focused: true })
      }
      return
    }
  } catch {
    // 查询/聚焦失败 → 落到新建
  }
  try {
    await chrome.tabs.create({ url, active: true })
  } catch {
    // ignore
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
  const identity = await getOrCreateDeviceIdentity()
  let code = ''
  let createOk = false
  for (let i = 0; i < 3; i++) {
    code = generatePairingCode()
    try {
      await gql<CreateExtensionPairingResult, CreateExtensionPairingVars>(
        CREATE_EXTENSION_PAIRING_MUTATION,
        {
          code,
          deviceId: identity.deviceId,
          publicKeyJwk: identity.publicKeyJwk,
        },
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

// ════════════════════════════════════════════════════════════════════════
// Lighthouse member lookup cache(灯塔成员识别)
// ════════════════════════════════════════════════════════════════════════
//
// Content script 频繁批查"这些 X handle 是不是灯塔成员"。简单的 in-memory
// cache + 5min TTL 已经够:
//   - 同一个用户 timeline 滚动通常重复出现同样的 author handle
//   - SW 在 idle 时被 GC,cache 丢失也无所谓(下次重查即可)
//   - 不需要持久化(成员状态变化频率远高于 5min,持久化反而 stale)
//
// cache entry 同时记录 hit / miss — miss 也缓存,避免对 known-non-member
// 反复打后端。

interface MemberCacheEntry {
  cachedAt: number
  /** null = 非成员 / undefined = 未查 */
  info: LighthouseMember | null
}

const MEMBER_CACHE_TTL_MS = 5 * 60 * 1000
const MEMBER_QUERY_BATCH_SIZE = 50

const memberCache = new Map<string, MemberCacheEntry>()

/**
 * 批查 Twitter handle → LighthouseMember 映射。
 *
 *   1. 输入 lowercase + dedupe
 *   2. 先 cache lookup,过期 / 不存在的入 missing
 *   3. missing chunk 成 ≤50 一批,调 lighthouseMembers query
 *   4. 合并所有结果,refresh cache(hit 和 miss 都记)
 *   5. 返回:**只含成员**的 map
 *
 * 任何一批查询失败 → 那一批 handles 留作未知(不缓存 miss,下次重试),
 * 已有的 cached hits 仍正常返回。
 */
async function checkLighthouseMembers(
  handles: string[],
): Promise<Record<string, LighthouseMember>> {
  if (!handles || handles.length === 0) return {}

  // 没 token 时跳过(成员识别需要鉴权 query,虽然 @AllowPluginToken 也允许)
  const token = await localStore.get('apiToken')
  if (!token) return {}

  // 标准化 + 去重
  const normalized = Array.from(
    new Set(
      handles
        .filter((h): h is string => typeof h === 'string')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0 && h.length <= 40),
    ),
  )
  if (normalized.length === 0) return {}

  const now = Date.now()
  const result: Record<string, LighthouseMember> = {}
  const missing: string[] = []

  // Cache lookup
  for (const h of normalized) {
    const cached = memberCache.get(h)
    if (cached && now - cached.cachedAt < MEMBER_CACHE_TTL_MS) {
      if (cached.info) result[h] = cached.info
      // null = cached non-member,跳过
    } else {
      missing.push(h)
    }
  }

  // 全部命中 cache
  if (missing.length === 0) return result

  // chunk + query
  for (let i = 0; i < missing.length; i += MEMBER_QUERY_BATCH_SIZE) {
    const batch = missing.slice(i, i + MEMBER_QUERY_BATCH_SIZE)
    try {
      const r = await gql<LighthouseMembersResult, { handles: string[] }>(
        LIGHTHOUSE_MEMBERS_QUERY,
        { handles: batch },
      )
      const hits = new Set(
        r.lighthouseMembers.map((m) => m.twitterHandle.toLowerCase()),
      )
      // 命中的写 cache + result
      for (const m of r.lighthouseMembers) {
        const key = m.twitterHandle.toLowerCase()
        memberCache.set(key, { cachedAt: now, info: m })
        result[key] = m
      }
      // 这一批没命中的也写 cache (info=null),避免反复查
      for (const h of batch) {
        if (!hits.has(h)) {
          memberCache.set(h, { cachedAt: now, info: null })
        }
      }
    } catch (e) {
      // 单批失败不打断其他批次,只是这些 handle 这次不入 cache,下次重试
      console.warn(
        '[lhdao] lighthouseMembers batch failed:',
        (e as Error).message,
      )
    }
  }

  // cache 太大时简单截断(运行很久后保护内存,不是性能瓶颈)
  if (memberCache.size > 5000) {
    const entries = Array.from(memberCache.entries())
    entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt)
    for (let i = 0; i < 2500; i++) {
      memberCache.delete(entries[i][0])
    }
  }

  return result
}
