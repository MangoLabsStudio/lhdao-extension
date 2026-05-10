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

// ── me — 取当前用户(用 Bearer token 鉴权时验证 token 有效) ────────

export const ME_QUERY = `
  query Me {
    me {
      id
      username
      nickname
      tier
    }
  }
`

export interface MeResult {
  me: {
    id: string
    username: string
    nickname: string | null
    tier: string | null
  } | null
}

// ── 拉可参与的 engagement 任务 ────────────────────────────────────────

export const AVAILABLE_ENGAGEMENTS_QUERY = `
  query AvailableEngagements {
    availableEngagements {
      id
      type
      mode
      targetUrl
      effectiveTier
      actions {
        actionType
        baseReward
        targetCount
        commentGuide
      }
    }
  }
`

export type EngagementActionType = 'LIKE' | 'RT' | 'COMMENT' | 'COMMENT_LIKE'

export interface AvailableEngagement {
  id: string
  type: string
  mode: string
  targetUrl: string | null
  effectiveTier: string | null
  actions: Array<{
    actionType: EngagementActionType
    baseReward: number
    targetCount: number | null
    commentGuide: string | null
  }>
}

export interface AvailableEngagementsResult {
  availableEngagements: AvailableEngagement[]
}

// ── 预约 / 验证 ──────────────────────────────────────────────────────

export const RESERVE_SLOT_MUTATION = `
  mutation ReserveEngagementSlot($campaignId: String!) {
    reserveEngagementSlot(campaignId: $campaignId) {
      success
    }
  }
`

export interface ReserveSlotResult {
  reserveEngagementSlot: { success: boolean }
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
