/**
 * 灯塔 backend GraphQL queries / mutations + 对应 TS 类型。
 *
 * Inline-typed pattern — codegen 在 lhdao 主仓暂时损坏,这里手写类型,
 * 跟主项目其他 page (kol-dao-app) 同样的写法。后端 schema 改动时,
 * 同步修改本文件。
 *
 * 后端字段定义见:
 *   - kol-dao-service/src/modules/users/users.resolver.ts (me)
 *   - kol-dao-service/src/modules/unified-campaign/...    (engagements)
 *   - kol-dao-service/src/modules/plugin-token/           (auth via Bearer)
 */

// ── me — 取当前用户(token 验证 + sidebar 个人面板数据) ────────────
//
// options 页只用最小 set (id / username / tier) 来验证 token。
// sidebar 卡片用扩展 set 来渲染:
//   - newLux       → "可用余额 +N LUX"(KOL 抢任务获得的劳动收入)
//   - tier         → "TIER A" chip
//   - todayEarnings → "今日 +N LUX"(后端 ResolveField 实时算)
//
// 注意:newLux / lux 是 Prisma Decimal,GraphQL 序列化为 number。
// 大额时精度有损但 sidebar 显示一位小数足够,不放大问题。

export const ME_QUERY = `
  query Me {
    me {
      id
      username
      nickname
      avatar
      tier
      newLux
      todayEarnings
      twitterUsername
    }
  }
`

export interface MeResult {
  me: {
    id: string
    username: string
    nickname: string | null
    /** 用户头像 URL — 主项目自家头像,可能 null(未上传)*/
    avatar: string | null
    tier: string | null
    /**
     * 劳动收入 LUX 余额。
     *
     * 注意:Prisma Decimal 在 prisma-nestjs-graphql 端注册为 `GraphQLDecimal`
     * scalar,**实际传输为 string**(避免 JS float 精度损失)。前端必须
     * `Number(value)` 转一下才能用,否则 `Number.isFinite` 校验失败。
     */
    newLux: number | string | null
    /** 当日新增 newLux 之和;后端 ResolveField 用 .toNumber() 返回 — 是 number */
    todayEarnings: number | null
    /** 用户绑定的 Twitter handle(无 @ 前缀);后端 ResolveField 从 OAuthAccount 拿 */
    twitterUsername: string | null
  } | null
}

// ── 拉可参与的 engagement 任务 ────────────────────────────────────────
//
// 字段来自 backend src/modules/unified-campaign/dto/campaign.model.ts:
//   - UnifiedCampaignModel.keywords: string[]   ← 评论关键字 (campaign 级)
//   - expectedReward / myExpectedReward:后端按当前用户可用 tier / 已预约
//     rewardTier 计算出的预期奖励。插件展示必须优先 myExpectedReward,避免
//     回落到 action.baseReward(高档/默认值)导致金额偏高。
//   - UnifiedCampaignActionModel.{actionType,baseReward,targetCount}

export const AVAILABLE_ENGAGEMENTS_QUERY = `
  query AvailableEngagements {
    availableEngagements {
      id
      type
      mode
      targetUrl
      tweetId
      tweetText
      tweetAuthorName
      tweetAuthorHandle
      tweetAuthorAvatar
      targetUsername
      keywords
      expectedReward
      myExpectedReward
      effectiveTier
      myEffectiveTier
      actions {
        actionType
        baseReward
        targetCount
      }
    }
  }
`

export type EngagementActionType =
  | 'LIKE'
  | 'RT'
  | 'COMMENT'
  | 'COMMENT_LIKE'
  | 'FOLLOW'

export interface AvailableEngagement {
  id: string
  type: string
  mode: string
  targetUrl: string | null
  tweetId: string | null
  tweetText: string | null
  tweetAuthorName: string | null
  tweetAuthorHandle: string | null
  tweetAuthorAvatar: string | null
  /**
   * FOLLOW action 的目标账户 handle(后端小写化储存)。
   * LIKE/RT/COMMENT 类 campaign 也可能有此字段(指推文作者),但 follow
   * 任务**必须**有此字段才能在 timeline 做作者匹配。
   */
  targetUsername: string | null
  keywords: string[]
  /** 用户级联后实际能拿到的总奖励 (LUX),后端 listAvailableCampaigns 计算 */
  expectedReward: number | null
  /** 当前用户 tier / 已预约 rewardTier 下的精确预期奖励;展示优先用它。 */
  myExpectedReward: number | null
  /** 用户实际能进的 tier 桶,如果级联了会跟 userTier 不同 */
  effectiveTier: string | null
  /** 当前用户实际奖励 tier;展示/诊断优先用它。 */
  myEffectiveTier: string | null
  actions: Array<{
    actionType: EngagementActionType
    baseReward: number
    targetCount: number | null
  }>
}

export interface AvailableEngagementsResult {
  availableEngagements: AvailableEngagement[]
}

// ── 我已预约的互动任务 ────────────────────────────────────────────────
// availableEngagements 会把已参与(含 RESERVED)的过滤掉,但卡片「当前任务」段
// 需要"已预约"的单(打开推文=已预约,直接检测/验证)。同 AvailableEngagement
// 形状,syncTasks 里和 available 合并进 tasksByTweetId。后端 @AllowPluginToken。
export const MY_RESERVED_ENGAGEMENTS_QUERY = `
  query MyReservedEngagements {
    myReservedEngagements {
      id
      type
      mode
      targetUrl
      tweetId
      tweetText
      tweetAuthorName
      tweetAuthorHandle
      tweetAuthorAvatar
      targetUsername
      keywords
      expectedReward
      myExpectedReward
      effectiveTier
      myEffectiveTier
      actions {
        actionType
        baseReward
        targetCount
      }
    }
  }
`

export interface MyReservedEngagementsResult {
  myReservedEngagements: AvailableEngagement[]
}

// ── 拉可参与的 TWEET 类型任务(创作类:原创推文 / 引用转推) ────────
//
// Sidebar v2 卡片专用 — 跟 availableEngagements 是平行 query,
// 后端 `availableTweets` 已贴 @AllowPluginToken()。
//
// 字段对应 UnifiedCampaignModel:
//   projectName        - 项目方名(可能 null,fallback 到 title)
//   description        - 任务 brief 描述(KOL 该写什么)
//   submitClose        - 截止时间(KOL 必须在此前完成提交)
//   myExpectedReward   - 我自己 tier 下的奖励数额(优先用,精确)
//   expectedReward     - 通用 tier 下的奖励(myExpectedReward 缺失时 fallback)
//   targetUrl          - 创建页 / 详情页 URL(点击 row 跳过去)

export const AVAILABLE_TWEETS_QUERY = `
  query AvailableTweets {
    availableTweets {
      id
      type
      title
      description
      projectName
      submitClose
      expectedReward
      myExpectedReward
      targetUrl
      isParticipated
      isSoldOut
    }
  }
`

export interface AvailableTweet {
  id: string
  type: string
  title: string | null
  description: string | null
  projectName: string | null
  /** ISO date string */
  submitClose: string | null
  expectedReward: number | null
  /** 我 tier 下的精确奖励;null 时 fallback 到 expectedReward */
  myExpectedReward: number | null
  targetUrl: string | null
  /**
   * 当前用户是不是已经参与过这个 campaign(抢过或完成过)。
   * sidebar 用来过滤"可抢单"列表 — 已参与的不展示。
   */
  isParticipated?: boolean | null
  /**
   * 席位是不是已经被抢光(totalParticipants + reservedCount >= seats)。
   * sidebar 用来过滤"可抢单"列表 — 已售罄的不展示。
   */
  isSoldOut?: boolean | null
}

export interface AvailableTweetsResult {
  availableTweets: AvailableTweet[]
}

// ── 预约 / 验证 ──────────────────────────────────────────────────────

export const RESERVE_SLOT_MUTATION = `
  mutation ReserveEngagementSlot($campaignId: String!, $confirmCascade: Boolean) {
    reserveEngagementSlot(campaignId: $campaignId, confirmCascade: $confirmCascade) {
      reserved
      reservedTier
      cooldownSeconds
      releasedSeats
      activeReservations
      cascadeWarning {
        userTier
        effectiveTier
        userTierRewardLux
        effectiveTierRewardLux
      }
    }
  }
`

export interface CascadeWarning {
  userTier: string
  effectiveTier: string
  userTierRewardLux: number
  effectiveTierRewardLux: number
}

export interface ReserveSlotResult {
  reserveEngagementSlot: {
    reserved: boolean
    reservedTier: string | null
    cooldownSeconds: number | null
    releasedSeats: number | null
    activeReservations: number | null
    cascadeWarning: CascadeWarning | null
  }
}

export const VERIFY_ENGAGEMENT_MUTATION = `
  mutation VerifyEngagement($campaignId: String!) {
    verifyEngagement(campaignId: $campaignId) {
      actualReward
    }
  }
`

export interface VerifyEngagementResult {
  verifyEngagement: { actualReward: number }
}

// ── [B3 插件专用验证] 票据签发 + 证明提交(取代对 plugin token 403 的 verifyEngagement)──
// 预约仍在网页;插件先 mint 票据(要求已 RESERVED),再带票据 + 捕获结果 + HMAC 签名
// 提交证明。发奖仍在后端 worker(Phase3 Twitter 权威 / Phase4 插件权威),故 submit
// 只返回 accepted/status,不返 reward。

export const MINT_ENGAGEMENT_TICKET_MUTATION = `
  mutation MintEngagementTicket($campaignId: String!) {
    mintEngagementTicket(campaignId: $campaignId) {
      ticket
      macKey
      expiresAt
    }
  }
`

export interface MintEngagementTicketResult {
  mintEngagementTicket: {
    ticket: string
    macKey: string
    expiresAt: string
  }
}

export const SUBMIT_ENGAGEMENT_PROOF_MUTATION = `
  mutation SubmitEngagementProof($input: SubmitEngagementProofInput!) {
    submitEngagementProof(input: $input) {
      accepted
      status
      reason
    }
  }
`

export interface SubmitEngagementProofResult {
  submitEngagementProof: {
    accepted: boolean
    status: string
    reason?: string | null
  }
}

// ── [shadow 捕获] 上报插件捕获到的互动动作(非资金,供一致率影子对比) ──────
// 后端 @AllowPluginToken,不发奖、不动钱;background 累积某 campaign 已捕获动作
// 后调用,返回 Boolean。input 见后端 ReportEngagementCaptureInput。
export const REPORT_ENGAGEMENT_CAPTURE_MUTATION = `
  mutation ReportEngagementCapture($input: ReportEngagementCaptureInput!) {
    reportEngagementCapture(input: $input)
  }
`

export interface ReportEngagementCaptureVars {
  input: {
    campaignId: string
    actions: {
      actionType: string
      tweetId?: string
      handle?: string
      capturedAt?: string
    }[]
    commentText?: string
    dwellMs?: number
  }
}

export interface ReportEngagementCaptureResult {
  reportEngagementCapture: boolean
}

// ── Lighthouse member lookup(灯塔成员识别) ─────────────────────────
//
// 用途:扩展扫 X timeline + profile 页面时,批量查询哪些 Twitter handle
// 是 Lighthouse 平台已激活成员,然后给这些推文 / 个人主页加 chip / badge。
//
// 后端 @AllowPluginToken,扩展用现有 plugin token 调即可。每次最多 50 个
// handle(后端校验),所以扩展端需要 chunk + LRU cache 去重。
//
// 返回的是**只有成员**的列表 — 非成员不在结果里。扩展用 set difference
// 推断 "input - output = 非成员",省传输流量。

export const LIGHTHOUSE_MEMBERS_QUERY = `
  query LighthouseMembers($handles: [String!]!) {
    lighthouseMembers(handles: $handles) {
      twitterHandle
      displayName
      avatar
      tier
    }
  }
`

export interface LighthouseMember {
  /** 小写化的 Twitter handle(不带 @) */
  twitterHandle: string
  /** 显示名 — 优先 nickname / fallback username / fallback handle */
  displayName: string
  /** 头像 URL,可能 null */
  avatar: string | null
  /** Tier 等级 S/A/B/C/D/E,可能 null(新注册未评级) */
  tier: string | null
}

export interface LighthouseMembersResult {
  lighthouseMembers: LighthouseMember[]
}

// ── Extension Pairing (一键登录) ─────────────────────────────────────
//
// 流程见 kol-dao-service 后端 ExtensionPairingService doc。
//
// 扩展端只调 2 个 endpoint:
//   - createExtensionPairing(code) — 占 code slot,扩展 BG 调,@IsPublic
//   - pollExtensionPairing(code)    — polling 拿 token,@IsPublic
//
// completeExtensionPairing 是主站调的(用户在 connect 页点 Allow),扩展
// 不调,所以不在这里。

export const CREATE_EXTENSION_PAIRING_MUTATION = `
  mutation CreateExtensionPairing($code: String!, $deviceId: String!, $publicKeyJwk: JSON!) {
    createExtensionPairing(code: $code, deviceId: $deviceId, publicKeyJwk: $publicKeyJwk)
  }
`

export interface CreateExtensionPairingResult {
  createExtensionPairing: boolean
}

export interface CreateExtensionPairingVars {
  code: string
  deviceId: string
  publicKeyJwk: JsonWebKey
}

export const POLL_EXTENSION_PAIRING_QUERY = `
  query PollExtensionPairing($code: String!) {
    pollExtensionPairing(code: $code) {
      status
      token
    }
  }
`

export type ExtensionPairingStatus = 'PENDING' | 'READY' | 'EXPIRED'

export interface PollExtensionPairingResult {
  pollExtensionPairing: {
    status: ExtensionPairingStatus
    /** 仅当 status === 'READY' 时非 null,返回明文 plugin token */
    token: string | null
  }
}

// ── 推文停留时长上报 (anti-cheat 信号) ────────────────────────────────

export const RECORD_TWEET_DWELL_MUTATION = `
  mutation RecordTweetDwell(
    $tweetId: String!
    $durationMs: Int!
    $tweetUrl: String
    $authorHandle: String
  ) {
    recordTweetDwell(
      tweetId: $tweetId
      durationMs: $durationMs
      tweetUrl: $tweetUrl
      authorHandle: $authorHandle
    )
  }
`

export interface RecordTweetDwellResult {
  recordTweetDwell: boolean
}

// ── Watermark mint (抢单接口防护) ─────────────────────────────────────
//
// 抢单/验证 mutation 在后端被 WatermarkInterceptor 保护(加密信封 + jti 防重放
// + reserve 的 PoW)。扩展在调 ReserveEngagementSlot / VerifyEngagement 前,先
// mint 一个 watermark token 并拼进请求头。详见 src/lib/watermark.ts。

export const MINT_WATERMARK_TOKEN_QUERY = `
  query MintWatermarkToken($operationName: String!, $opType: String!) {
    mintWatermarkToken(operationName: $operationName, opType: $opType) {
      token
      expiresAt
      kid
      powChallenge
      powDifficulty
    }
  }
`

export interface MintWatermarkTokenResult {
  mintWatermarkToken: {
    token: string
    expiresAt: string | null
    kid: string | null
    powChallenge: string | null
    powDifficulty: string | null
  }
}

// ── 一键推广(promoteTweet)──────────────────────────────────────────
// 后端按平台价格表把 预算+动作+档位 折成 ENGAGEMENT 商单(余额校验/10% 手续费)。
// promoteTweet 返回创建的子单数组(每动作一个)。
export const PROMOTE_TWEET_MUTATION = `
  mutation PromoteTweet($input: PromoteTweetInput!) {
    promoteTweet(input: $input) {
      id
    }
  }
`

export interface PromoteTweetVars {
  input: {
    tweetUrl: string
    actions: { actionType: string; tierSlots: Record<string, number> }[]
  }
}

export interface PromoteTweetResult {
  promoteTweet: { id: string }[]
}

// 持续复投:给某子单建 auto-reinvest 任务(作者发新推文自动复投 N 次)。
export const CREATE_AUTO_REINVEST_MUTATION = `
  mutation CreateAutoReinvestTask($input: CreateAutoReinvestTaskInput!) {
    createAutoReinvestTask(input: $input) {
      id
    }
  }
`

export interface CreateAutoReinvestVars {
  input: { campaignId: string; reinvestCount: number }
}

export interface CreateAutoReinvestResult {
  createAutoReinvestTask: { id: string }
}
