/**
 * Content script ↔ Background service worker RPC 协议。
 *
 * 设计:
 *   - 强类型 union,新加 message 必须同时改这里 + handler
 *   - 错误结果走显式分支(`ok: false` + 错误 code),不抛异常给 content
 *   - 单向广播(BG → CS)用 `tasks-updated`,响应永远是 `ack`
 */

import type {
  ActiveCampaignSummary,
  CampaignTaskCache,
  TweetCampaignSummary,
  UserProfile,
} from '@/lib/storage'

// ── Requests (CS → BG, 偶尔反向) ─────────────────────────────────────

export type MsgRequest =
  /** content script 询问某条推文上挂着哪些任务(LIKE/RT/COMMENT 等 tweet-level)*/
  | { type: 'get-tasks-for-tweet'; tweetId: string }
  /**
   * content script 询问某作者作为目标的 FOLLOW 任务列表。authorHandle 应
   * 已小写化(后端 targetUsername 字段就是小写存的)。
   */
  | { type: 'get-tasks-for-author'; authorHandle: string }
  /**
   * [perf] content script 启动 + 每次 tasks-updated 广播后一次性拉全量
   * 索引,本地缓存,scan 时同步查 — 避免每条 article 单独 RPC 串行 await
   * 带来的肉眼可见延迟。
   */
  | { type: 'get-tasks-snapshot' }
  /** 抢单第一步:仅占席位 (reserveEngagementSlot)。confirmCascade 让用户
   *  在收到 cascadeWarning 后点重抢时确认降档接受 */
  | { type: 'reserve-task'; campaignId: string; confirmCascade?: boolean }
  /** 抢单第二步:仅验证 + 发奖 (verifyEngagement) */
  | { type: 'verify-task'; campaignId: string }
  /** [legacy] reserve + verify 一锅炖 — 兼容老调用,新代码用 reserve / verify 分两步 */
  | { type: 'submit-task'; campaignId: string }
  /** content script 询问当前是否已配置 token (popup 也用) */
  | { type: 'has-token' }
  /** popup 触发立即同步 — 不等 60s alarm,等 sync 跑完再返回结果 */
  | { type: 'force-sync' }
  /** content script 上报推文详情页停留时长 (anti-cheat 信号) */
  | { type: 'record-dwell'; tweetId: string; durationMs: number }
  /** [legacy] sidebar 卡片询问当前可抢 ENGAGEMENT campaign 列表 */
  | { type: 'get-active-campaigns' }
  /** [v2] sidebar 卡片询问个人面板数据 + TWEET 任务列表(一次拿全) */
  | { type: 'get-sidebar-data' }
  /** BG → CS 广播:任务列表已更新,请重新查询 */
  | { type: 'tasks-updated' }

// ── Responses ────────────────────────────────────────────────────────

export type MsgResponse =
  | { type: 'tasks'; tasks: CampaignTaskCache[] }
  | {
      type: 'tasks-snapshot'
      byTweet: Record<string, CampaignTaskCache[]>
      byAuthor: Record<string, CampaignTaskCache[]>
    }
  | { type: 'reserve-result'; ok: true; cooldownSeconds?: number }
  | {
      type: 'reserve-result'
      ok: false
      code: SubmitErrorCode
      message: string
    }
  | { type: 'verify-result'; ok: true; reward: number }
  | { type: 'verify-result'; ok: false; code: SubmitErrorCode; message: string }
  | { type: 'submit-result'; ok: true; reward: number }
  | { type: 'submit-result'; ok: false; code: SubmitErrorCode; message: string }
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
    }
  | {
      type: 'sync-result'
      ok: true
      lastSyncAt: number
      taskCount: number
      tweetCount: number
    }
  | { type: 'sync-result'; ok: false; error: string; httpStatus?: number }
  | { type: 'ack' }

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
  | 'RESERVE_FAILED'
  | 'ALREADY_DONE'
  | 'COMMENT_MISSING'
  | 'WRONG_X_ACCOUNT'
  | 'API_NOT_READY'
  | 'ACTION_NOT_DETECTED'
  | 'VERIFY_FAILED'
  | 'NETWORK'
  | 'INTERNAL'
