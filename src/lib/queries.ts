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
//   - UnifiedCampaignActionModel.{actionType,baseReward,targetCount}
//
// 没有 effectiveTier / commentGuide(我之前 queries 拍脑袋写的)。
// 真实的 user-tier 奖励数额会在 verifyEngagement 完成后由后端返回。

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
      effectiveTier
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
  /** 用户实际能进的 tier 桶,如果级联了会跟 userTier 不同 */
  effectiveTier: string | null
  actions: Array<{
    actionType: EngagementActionType
    baseReward: number
    targetCount: number | null
  }>
}

export interface AvailableEngagementsResult {
  availableEngagements: AvailableEngagement[]
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
