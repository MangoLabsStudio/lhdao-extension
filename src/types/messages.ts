import type { CascadeWarning } from '@/lib/queries'
/**
 * Content script ↔ Background service worker RPC 协议。
 *
 * 设计:
 *   - 强类型 union,新加 message 必须同时改这里 + handler
 *   - 错误结果走显式分支(`ok: false` + 错误 code),不抛异常给 content
 *   - 单向广播(BG → CS)用 `tasks-updated`,响应永远是 `ack`
 */

import type {
  BinanceProbeObservation,
  BinanceProbeTarget,
} from '@/lib/binance-square-probe'
import type {
  EngagementCurrentMarketPrices,
  LighthouseMember,
  PromoteTweetPricingQuote,
} from '@/lib/queries'
import type {
  ActiveCampaignSummary,
  CampaignTaskCache,
  LighthouseSelectedStatus,
  TweetCampaignSummary,
  UserProfile,
} from '@/lib/storage'

// ── Requests (CS → BG, 偶尔反向) ─────────────────────────────────────

/** 一键推广可选的互动动作 */
export type PromoteAction = 'LIKE' | 'RT' | 'COMMENT'

export type MsgRequest =
  | { type: 'get-x-analytics-status' }
  | {
      type: 'save-x-analytics'
      captureId: string
      twitterUsername: string
      periodStart: string
      periodEnd: string
      capturedAt: string
      metrics: Record<string, number>
    }
  | { type: 'get-binance-probe-targets' }
  | {
      type: 'report-binance-probe-observation'
      observation: BinanceProbeObservation
    }
  | { type: 'export-binance-probe-observations' }
  | { type: 'clear-binance-probe-observations' }
  | { type: 'get-tasks-for-tweet'; tweetId: string }
  | { type: 'get-tasks-for-author'; authorHandle: string }
  | { type: 'get-tasks-snapshot' }
  | { type: 'get-captured-actions'; campaignId: string; tweetId?: string }
  | {
      type: 'reserve-task'
      campaignId: string
      confirmCascade?: boolean
      confirmedCascadeTier?: string
    }
  | { type: 'verify-task'; campaignId: string }
  | { type: 'submit-task'; campaignId: string }
  | {
      type: 'get-current-engagement-prices'
      actions: PromoteAction[]
    }
  | {
      type: 'preview-promote-tweet-pricing'
      tweetUrl: string
      actions: {
        actionType: PromoteAction
        tierSlots: Record<string, number>
      }[]
    }
  | {
      type: 'promote-tweet'
      tweetUrl: string
      quoteId: string
      /** 每动作 + 每 tier 招募人数(每动作建一个 ≥2 LUX 子单) */
      actions: {
        actionType: PromoteAction
        tierSlots: Record<string, number>
      }[]
      /** >0 则成功后给作者建 auto-reinvest 任务(持续复投 N 次) */
      reinvestCount?: number
      /** Explicitly false for ordinary promotion; never inherited. */
      lighthouseSelectedOnly: boolean
    }
  | { type: 'get-balance' }
  | { type: 'has-token' }
  | { type: 'force-sync' }
  | { type: 'open-task-hall' }
  | { type: 'open-campaign'; campaignId: string }
  | {
      type: 'record-dwell'
      tweetId: string
      durationMs: number
      tweetUrl?: string | null
      authorHandle?: string | null
    }
  | {
      type: 'report-engagement-capture'
      actionType: 'LIKE' | 'RT' | 'COMMENT' | 'FOLLOW'
      tweetId?: string
      handle?: string
      commentText?: string
      resultTweetId?: string
      capturedAt: string
    }
  | { type: 'get-active-campaigns' }
  | { type: 'get-sidebar-data' }
  | { type: 'get-popup-data' }
  | { type: 'start-pairing' }
  | { type: 'cancel-pairing' }
  | { type: 'get-pairing-status' }
  | { type: 'check-lighthouse-members'; handles: string[] }
  | { type: 'tasks-updated' }
  | { type: 'pairing-status'; state: PairingState }

// ── Responses ────────────────────────────────────────────────────────

export type MsgResponse =
  | {
      type: 'x-analytics-status'
      twitterUserId: string | null
      twitterUsername: string | null
      completed: boolean
    }
  | { type: 'x-analytics-save-result'; ok: true; savedAt: string }
  | {
      type: 'x-analytics-save-result'
      ok: false
      code: 'NO_TOKEN' | 'WRONG_X_ACCOUNT' | 'INCOMPLETE' | 'NETWORK'
    }
  | { type: 'binance-probe-targets'; targets: BinanceProbeTarget[] }
  | {
      type: 'binance-probe-observations'
      observations: BinanceProbeObservation[]
    }
  | { type: 'tasks'; tasks: CampaignTaskCache[] }
  | {
      type: 'tasks-snapshot'
      byTweet: Record<string, CampaignTaskCache[]>
      byAuthor: Record<string, CampaignTaskCache[]>
      // BG 是否至少成功同步过一次(lastSyncAt != null)。冷启动尚未同步时
      // 为 false —— 消费方据此区分「已同步但该推文无任务」(空 = 真无任务)
      // 与「还没同步完」(空 = 不确定,应保持加载/重试),避免把冷启空快照
      // 误判为无任务。可选字段,老消费方忽略即可,向后兼容。
      ready?: boolean
      /** A failed source must not be interpreted as an empty guide/task list. */
      syncFailed?: boolean
    }
  | { type: 'captured-actions'; actions: string[] }
  | { type: 'reserve-result'; ok: true; cooldownSeconds?: number }
  | {
      type: 'reserve-result'
      cascadeWarning?: CascadeWarning
      ok: false
      code: SubmitErrorCode
      message: string
    }
  | { type: 'verify-result'; ok: true; reward: number }
  | { type: 'verify-result'; ok: false; code: SubmitErrorCode; message: string }
  | { type: 'submit-result'; ok: true; reward: number }
  | { type: 'submit-result'; ok: false; code: SubmitErrorCode; message: string }
  | {
      type: 'current-engagement-prices-result'
      ok: true
      prices: EngagementCurrentMarketPrices
    }
  | {
      type: 'current-engagement-prices-result'
      ok: false
      code: string
      message: string
    }
  | {
      type: 'promote-pricing-result'
      ok: true
      quote: PromoteTweetPricingQuote
    }
  | {
      type: 'promote-pricing-result'
      ok: false
      code: string
      message: string
    }
  | {
      type: 'promote-result'
      ok: true
      campaignIds: string[]
      reinvested: boolean
    }
  | { type: 'promote-result'; ok: false; code: string; message: string }
  | { type: 'balance-result'; balance: number | null }
  | { type: 'token-status'; configured: boolean }
  | { type: 'active-campaigns'; campaigns: ActiveCampaignSummary[] }
  | {
      type: 'sidebar-data'
      /** 个人面板;未配置 token 或同步失败时 null */
      profile: UserProfile | null
      /** TWEET 类任务列表;空数组 = 暂无任务,null = 同步失败 */
      tweetCampaigns: TweetCampaignSummary[] | null
      /** 是否已配置 plugin token — sidebar 据此渲染 unauth 态 */
      tokenConfigured: boolean
      /** 严选资格本轮确认状态;confirmed false 仍为 available。 */
      lighthouseSelectedStatus: LighthouseSelectedStatus
    }
  | {
      type: 'popup-data'
      /** 是否已配置 token */
      hasToken: boolean
      /** 脱敏 token,形如 `lhdao_pk_••••••••8f3d`;无 token 时 null */
      tokenMasked: string | null
      /** 个人面板;未配置 token / 未同步过时 null */
      profile: UserProfile | null
      /** 当前覆盖到的 engagement 任务总数(LIKE+RT+COMMENT+FOLLOW…) */
      taskCount: number
      /** 当前覆盖到的推文数(去重) */
      tweetCount: number
      /** 上次成功同步时间戳(ms);从未同步过则 null */
      lastSyncAt: number | null
      /** 上次同步错误文案;成功后清空为 null */
      lastSyncError: string | null
      /** 上次同步 HTTP 状态码(用于诊断 401 / 403 / 5xx) */
      lastSyncHttpStatus: number | null
    }
  | {
      type: 'sync-result'
      ok: true
      lastSyncAt: number
      taskCount: number
      tweetCount: number
    }
  | { type: 'sync-result'; ok: false; error: string; httpStatus?: number }
  | {
      type: 'pairing-started'
      ok: true
      /** 32-char hex code,UI 可以展示前 8 位让用户在 tab 上确认 */
      code: string
    }
  | {
      type: 'pairing-started'
      ok: false
      /** 启动失败原因 — 网络 / code 冲突重试用尽 / 等 */
      reason: string
    }
  | { type: 'pairing-status-result'; state: PairingState }
  | {
      type: 'lighthouse-members-result'
      members: Record<string, LighthouseMember>
    }
  | { type: 'ack' }

/**
 * Pairing flow 状态机。
 *
 *   idle      ─start-pairing→  waiting ─poll READY→  success → (auto idle)
 *                              waiting ─poll EXPIRED/60s→ timeout
 *                              waiting ─cancel→     cancelled → (auto idle)
 *                              *       ─exception→  error
 *
 * success / timeout / error / cancelled 都是 terminal state,会在 5s 后
 * 自动回 idle,让 UI 可以重新开始一轮。
 */
export type PairingState =
  | { kind: 'idle' }
  | { kind: 'waiting'; code: string; startedAt: number }
  | { kind: 'success' }
  | { kind: 'timeout' }
  | { kind: 'error'; reason: string }
  | { kind: 'cancelled' }

/**
 * submit-task 失败的标准 code。让 content script 决定 toast 文案,
 * 后端 GraphQL 错误 message 走正则 match → 这些 code,UI 渲染查表。
 *
 * 通用类:
 *   - NO_TOKEN / TOKEN_INVALID  — auth 失败,引导去 options 页
 *   - NETWORK / INTERNAL        — 系统错,请用户重试
 *
 * Reserve 阶段:
 *   - SLOT_FULL          — 席位满 (高频)
 *   - BOT_BLOCKED        — 用户被反作弊系统拒绝
 *   - RESERVE_FAILED     — 其他预约失败兜底
 *
 * Verify 阶段:
 *   - ALREADY_DONE       — 已完成,幂等成功
 *   - COMMENT_MISSING    — 评论没含规定关键字
 *   - WRONG_X_ACCOUNT    — 用了非绑定的 X 账号
 *   - API_NOT_READY      — Twitter API 缓存延迟,5s 后会重试
 *   - ACTION_NOT_DETECTED — 没检测到对应动作 (用户没真的点赞 / RT 等)
 *   - VERIFY_FAILED      — 其他验证失败兜底
 */
export type SubmitErrorCode =
  | 'NO_TOKEN'
  | 'TOKEN_INVALID'
  | 'SLOT_FULL'
  | 'BOT_BLOCKED'
  | 'LIGHTHOUSE_SELECTED_REQUIRED'
  | 'RESERVE_FAILED'
  | 'ALREADY_DONE'
  | 'COMMENT_MISSING'
  | 'WRONG_X_ACCOUNT'
  | 'API_NOT_READY'
  | 'ACTION_NOT_DETECTED'
  | 'VERIFY_FAILED'
  | 'NETWORK'
  | 'INTERNAL'
