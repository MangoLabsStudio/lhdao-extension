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
import type { ProductExperienceControllerState } from '@/lib/product-experience-controller'
import type { PublicProductExperienceState } from '@/lib/product-experience-task-bridge'
import type {
  EngagementCurrentMarketPrices,
  LighthouseMember,
  PromoteTweetPricingQuote,
} from '@/lib/queries'
import type {
  ActiveCampaignSummary,
  CampaignTaskCache,
  TweetCampaignSummary,
  UserProfile,
} from '@/lib/storage'
import type {
  ProductExperienceRule,
  ProductExperienceTaskRef,
  ProductRuleMatch,
  ProductZkTlsDiagnosticEvent,
} from './product-experience'

// ── Requests (CS → BG, 偶尔反向) ─────────────────────────────────────

/** 一键推广可选的互动动作 */
export type PromoteAction = 'LIKE' | 'RT' | 'COMMENT'

export type MsgRequest =
  | {
      type: 'zktls-prove'
      correlationId: string
      sessionId: string
      connectorId: string
    }
  | {
      type: 'save-product-experience-task'
      task: ProductExperienceTaskRef
      correlationId: string
    }
  | { type: 'get-product-experience-state' }
  | { type: 'get-binance-probe-targets' }
  | {
      type: 'report-binance-probe-observation'
      observation: BinanceProbeObservation
    }
  | { type: 'export-binance-probe-observations' }
  | { type: 'clear-binance-probe-observations' }
  | {
      type: 'get-public-product-experience-state'
      campaignId: string
      correlationId: string
    }
  | { type: 'start-product-experience' }
  | { type: 'product-experience-bootstrap' }
  | { type: 'product-experience-ready'; sessionId: string }
  | {
      type: 'product-experience-diagnostic'
      sessionId: string
      event: ProductZkTlsDiagnosticEvent
    }
  | {
      type: 'product-experience-proof-diagnostic'
      sessionId: string
      connectorId: string
      correlationId: string
      event: ProductZkTlsDiagnosticEvent
    }
  | {
      type: 'product-experience-evidence'
      sessionId: string
      matches: ProductRuleMatch[]
    }
  | { type: 'product-experience-state-changed' }
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
  /** [网页 gate] 查某 campaign 已捕获到的动作类型(网页验证前预检:没捕获
   *  就直接判「未检测到动作」失败,不走异步)。tweetId 作别名兜底。 */
  | { type: 'get-captured-actions'; campaignId: string; tweetId?: string }
  /** 抢单第一步:仅占席位 (reserveEngagementSlot)。confirmCascade 让用户
   *  在收到 cascadeWarning 后点重抢时确认降档接受 */
  | { type: 'reserve-task'; campaignId: string; confirmCascade?: boolean }
  /** 抢单第二步:仅验证 + 发奖 (verifyEngagement) */
  | { type: 'verify-task'; campaignId: string }
  /** [legacy] reserve + verify 一锅炖 — 兼容老调用,新代码用 reserve / verify 分两步 */
  | { type: 'submit-task'; campaignId: string }
  /** 一键推广:先取服务端冻结报价,再显式确认 promoteTweet。 */
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
    }
  /** 取当前缓存的余额(newLux),给推广弹窗显示 */
  | { type: 'get-balance' }
  /** content script 询问当前是否已配置 token (popup 也用) */
  | { type: 'has-token' }
  /** popup 触发立即同步 — 不等 60s alarm,等 sync 跑完再返回结果 */
  | { type: 'force-sync' }
  /**
   * [B3] 验证成功后:新开一个任务广场标签页并切过去(不跳转当前 X 页)。
   * 内容脚本不能直接开标签页,委托后台 chrome.tabs.create。返回 ack。
   */
  | { type: 'open-task-hall' }
  /**
   * [profile 关注卡] 验证成功后跳回 lhdao 某 campaign 详情页(任务观察界面):
   * 复用已开的 lhdao 标签(有则聚焦并导航,无则新建)。返回 ack。
   */
  | { type: 'open-campaign'; campaignId: string }
  /**
   * content script 上报推文详情页停留时长 (anti-cheat 信号)。
   *
   * tweetUrl / authorHandle 在 v2026-05-17 新增 — content script 在 dwell
   * start 时从 DOM 顺手 capture,运营后台直接看到完整 URL + 作者 handle,
   * 不用反查 Twitter API。两个字段都是可选(没拿到时不传,后端兼容)。
   */
  | {
      type: 'record-dwell'
      tweetId: string
      durationMs: number
      tweetUrl?: string | null
      authorHandle?: string | null
    }
  /**
   * [shadow 捕获] MAIN-world 捕获到用户互动动作(LIKE/RT/COMMENT/FOLLOW)→
   * isolated bridge 转发到 background 上报后端 reportEngagementCapture(非资金,
   * 供 API-vs-插件 一致率影子对比)。fire-and-forget,background 回 ack。
   * tweetId(LIKE/RT/COMMENT)与 handle(FOLLOW,被关注者)二选一。
   */
  | {
      type: 'report-engagement-capture'
      actionType: 'LIKE' | 'RT' | 'COMMENT' | 'FOLLOW'
      tweetId?: string
      handle?: string
      commentText?: string
      resultTweetId?: string
      capturedAt: string
    }
  /** [legacy] sidebar 卡片询问当前可抢 ENGAGEMENT campaign 列表 */
  | { type: 'get-active-campaigns' }
  /** [v2] sidebar 卡片询问个人面板数据 + TWEET 任务列表(一次拿全) */
  | { type: 'get-sidebar-data' }
  /**
   * [v3] popup 询问完整概览数据 — token mask + profile + 任务计数 +
   * sync 状态,一次拿全。
   *
   * 跟 sidebar-data 的区别:
   *   - 多 tokenMasked(脱敏后的 token,popup 展示用)
   *   - 多 taskCount / tweetCount(从 tasksByTweetId 算的总数)
   *   - 多 lastSync* 三件套(同步状态)
   *   - 不返回 tweetCampaigns(popup 不展示任务列表)
   */
  | { type: 'get-popup-data' }
  /**
   * [v4] 一键登录 — UI 触发 pairing 流程。
   *
   * BG 生成 32-char hex code → 调 createExtensionPairing 占 slot →
   * 打开 app.lhdao.top/extension/connect?code=xxx 新 tab → 启动 polling
   * state machine(每 2s,60s 超时)。
   *
   * 异步过程,结果通过 `pairing-status` 单向广播(BG → UI)告知 UI。
   * 同步 response 为 `pairing-started`(确认 BG 已收到指令)。
   */
  | { type: 'start-pairing' }
  /** 用户取消 / popup 关闭 — 终止当前 polling,关 tab(如还开着) */
  | { type: 'cancel-pairing' }
  /** UI 重新打开时查询当前 pairing state,避免 popup close 期间错过广播 */
  | { type: 'get-pairing-status' }
  /**
   * Content script 批查"这些 handles 哪些是灯塔成员"。
   *
   * BG SW 内置 LRU cache(5min TTL),去重 + chunk(50/批)后调后端
   * lighthouseMembers query。返回只包含真正命中的 handle → 成员信息映射;
   * 不在结果里的 handle = 非成员(扩展端 set difference 推断)。
   */
  | { type: 'check-lighthouse-members'; handles: string[] }
  /** BG → CS 广播:任务列表已更新,请重新查询 */
  | { type: 'tasks-updated' }
  /**
   * BG → UI 广播 pairing 状态变化。
   *
   * 状态:
   *   - idle      :未启动 / 已完成 / 已取消(可以重新开始)
   *   - waiting   :已开 tab,polling 中
   *   - success   :拿到 token,storage 写入完毕,准备关 tab + sync
   *   - timeout   :60s 超时
   *   - error     :网络 / code 冲突 / 其他异常
   *   - cancelled :用户主动取消
   */
  | { type: 'pairing-status'; state: PairingState }

// ── Responses ────────────────────────────────────────────────────────

export type MsgResponse =
  | {
      type: 'zktls-prove-result'
      correlationId: string
      status: 'submitted' | 'pending_login' | 'error' | 'unsupported'
      code?: string
    }
  | {
      type: 'save-product-experience-task-result'
      ok: true
      correlationId: string
      state: ProductExperienceControllerState
    }
  | {
      type: 'save-product-experience-task-result'
      ok: false
      correlationId: string
      error: 'SUBMISSION_PENDING'
      state: ProductExperienceControllerState
    }
  | {
      type: 'product-experience-state-result'
      state: ProductExperienceControllerState
    }
  | { type: 'binance-probe-targets'; targets: BinanceProbeTarget[] }
  | {
      type: 'binance-probe-observations'
      observations: BinanceProbeObservation[]
    }
  | {
      type: 'public-product-experience-state-result'
      correlationId: string
      state: PublicProductExperienceState
    }
  | {
      type: 'product-experience-bootstrap-result'
      ok: true
      sessionId: string
      ruleSetVersion: number
      allowedOrigins: string[]
      completionMode: 'ALL'
      evaluationMode: 'STRICT' | 'SELECTOR_ONLY'
      rules: ProductExperienceRule[]
    }
  | {
      type: 'product-experience-bootstrap-result'
      ok: false
      error: 'INVALID_SENDER' | 'NO_ACTIVE_SESSION'
    }
  | { type: 'product-experience-ack' }
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
  /** [网页 gate] 某 campaign 已捕获的动作类型列表(get-captured-actions 的响应)。 */
  | { type: 'captured-actions'; actions: string[] }
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
  /** start-pairing 同步 ack:BG 已收到指令并已开始 pairing 流程 */
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
  /** get-pairing-status 响应:返回当前 state */
  | { type: 'pairing-status-result'; state: PairingState }
  /**
   * check-lighthouse-members 响应。
   *
   * `members`:只包含真正命中的成员 — key 是 lowercase handle,value 是
   *   该用户的 LighthouseMember 公开信息。未命中的 handle 不在 map 里。
   *
   * 调用方拿到后:
   *   - input handles 中,在 map 里的 → 灯塔成员,渲染 chip
   *   - 不在 map 里的 → 非成员,跳过
   */
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
  | 'RESERVE_FAILED'
  | 'ALREADY_DONE'
  | 'COMMENT_MISSING'
  | 'WRONG_X_ACCOUNT'
  | 'API_NOT_READY'
  | 'ACTION_NOT_DETECTED'
  | 'VERIFY_FAILED'
  | 'NETWORK'
  | 'INTERNAL'
