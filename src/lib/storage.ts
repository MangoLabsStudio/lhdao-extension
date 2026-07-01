/**
 * 类型化的 chrome.storage 封装。
 *
 *  - **local**:持久(用户数据,跨浏览器会话保留)。装 plugin token、用户偏好。
 *  - **session**:浏览器一关就清(MV3 SW 重启可活下来,但用户关浏览器会失效)。
 *    装可重新拉取的任务缓存。
 *
 * 不暴露 raw chrome.storage.* — 调用方只看到 typed get/set,违法 key
 * 直接 TS 编译期就报错。
 */

// ── Schemas ───────────────────────────────────────────────────────────

interface LocalSchema {
  /** 用户在 web 端创建的 plugin token (lhdao_pk_*) */
  apiToken: string | null
  /**
   * 稳定的设备标识 (UUID v4),首次需要时生成并持久化。
   *
   * 作为 watermark 的 `did` 维度:抢单/验证请求带 `x-device-id`,后端 mint +
   * verify 时绑定它(防 token 跨设备共享)。SW 重启不丢(存 local),换浏览器
   * 才会重生成。详见 src/lib/watermark.ts。
   */
  deviceId: string | null
  /** 是否同意上报错误日志 (placeholder,后续接 Sentry) */
  optInErrorReport: boolean
  /**
   * 是否自动屏蔽 X 上的 sensitive(成人/软色情/暴力等)推文。
   * 默认 true — 装上立即生效,Options 里可反勾。
   *
   * Content script 扫到 article 内有 [data-testid*="sensitive"] 就贴
   * data-lhdao-hide-sensitive,highlight.css 把整条 display:none。
   *
   * 设置变化通过 chrome.storage.onChanged 通知 content script 实时
   * apply / un-apply,不需要刷页。
   */
  hideSensitiveTweets: boolean
}

interface SessionSchema {
  /**
   * key = tweetId, value = 这条推文上挂着的"推文级"任务(LIKE/RT/COMMENT)。
   * content script 拿到 tweetId 时 O(1) 查询。
   */
  tasksByTweetId: Record<string, CampaignTaskCache[]>
  /**
   * key = author handle(全小写),value = 该作者作为目标的 FOLLOW 任务列表。
   *
   * Twitter timeline 里同一作者可能出现多条推文,所有 article 共享同一组
   * follow tasks。content script 提取 article 作者 handle 后 O(1) 查询,
   * 跟 tasksByTweetId 合并起来挂 chip。
   */
  tasksByAuthorHandle: Record<string, CampaignTaskCache[]>
  /**
   * [shadow 捕获] key = campaignId,value = 该 campaign 至今捕获到的动作(按
   * actionType 去重)。累积上报:后端 recordCapture 是 latest-wins 覆盖,故每次
   * 报「该 campaign 全部已捕获动作」,避免多动作任务互相覆盖漏判。session 级
   * (SW 重启清空,后端 Redis 本就有 TTL)。
   */
  capturedActions: Record<
    string,
    { actionType: string; tweetId: string; capturedAt: string }[]
  >
  /** 上次 background SW 拉取任务的时间戳 (ms since epoch) */
  lastSyncAt: number
  /** 上次同步的错误信息;成功时为 null */
  lastSyncError: string | null
  /** 上次同步的错误对应 HTTP status (401/403/...);非 HTTP 错误为 null */
  lastSyncHttpStatus: number | null
  /** [legacy v1] 当前用户可抢的全部 ENGAGEMENT campaign 摘要,chip 仍可用 */
  activeCampaigns: ActiveCampaignSummary[]
  /** [v2] 当前用户可抢的 TWEET 类 campaign(创作任务),sidebar 列表用 */
  tweetCampaigns: TweetCampaignSummary[]
  /** [v2] 个人面板数据:余额 / Tier / 今日收益 — sidebar 顶部三件套 */
  userProfile: UserProfile | null
}

/** Sidebar v2 顶部个人面板用 — 全是 me query 拉来的字段 */
export interface UserProfile {
  /** 用户 ID,fallback 用 */
  id: string
  /** 显示名:优先 nickname,fallback username,再 fallback twitterHandle */
  displayName: string | null
  /** 头像 URL,可能 null(未上传 + 没绑 Twitter)*/
  avatar: string | null
  /** Twitter handle(无 @ 前缀)— sidebar 第二行小字 */
  twitterHandle: string | null
  /** 用户 tier — S / A / B / C / D / E */
  tier: string | null
  /** 劳动收入 LUX 余额(可用余额)— sidebar 大字显示 */
  newLux: number | null
  /** 今日新增 newLux — sidebar 小字显示 */
  todayEarnings: number | null
}

/** Sidebar v2 列表行数据 — TWEET 类型 campaign 精简摘要 */
export interface TweetCampaignSummary {
  campaignId: string
  /** 项目方名,可能 null fallback 到 "Lighthouse 任务" */
  projectName: string | null
  /** 任务描述(brief)— 优先 description,fallback title */
  brief: string | null
  /** 我 tier 下的奖励数额 (LUX) — 优先 myExpectedReward */
  rewardLux: number
  /** ISO date string,截止时间 — 用于显示"截止 N h 后" */
  submitClose: string | null
  /** 点击 row 跳转的 URL — 通常 lhdao.top/campaigns/<id> */
  targetUrl: string | null
}

/** Sidebar 列表卡片单条数据 — 展示用,跟 chip 用的 task cache 解耦 */
export interface ActiveCampaignSummary {
  campaignId: string
  /** 用户级联后实际能拿到的总奖励 */
  rewardLux: number
  /** 该 campaign 涉及的动作类型集合 (LIKE / RT / COMMENT / COMMENT_LIKE) */
  actionTypes: CampaignTaskCache['actionType'][]
  /** 目标推文 id (URL 抽出),供点击卡片跳转 */
  tweetId: string
  /** 目标推文完整 URL (https://x.com/<user>/status/<id>) */
  targetUrl: string
  /** 推文作者 display name,可能 null (尚未被 hourly cron 抓到) */
  authorName: string | null
  /** 推文作者 handle (无 @) */
  authorHandle: string | null
  /** 推文作者头像 URL */
  authorAvatar: string | null
  /** 推文正文摘要 (前 100 字符) */
  tweetPreview: string | null
  /** COMMENT 类任务的关键字提示 */
  commentKeyword: string | null
}

/**
 * 经 GraphQL 拉来再扁平化后的任务缓存 row。content script 拿到后渲染 chip。
 *
 * 注意:不放原始 tweet URL 进 cache(URL 由 content script 现场解析得到 tweetId,
 * 反向查这张表)— 减少冗余存储,缓存大小可控。
 */
export interface CampaignTaskCache {
  campaignId: string
  /**
   * 目标推文 id (从 targetUrl 抽出)。
   *
   * 注意:FOLLOW 任务**没有具体推文目标**,这种情况下 tweetId 仍然取 campaign
   * 的 targetUrl 推文 id(作为"挂在哪条推文的 article 上"的 reference),但
   * **匹配逻辑用 targetUsername 而非 tweetId**。flattenTasks 同时把 FOLLOW
   * 任务索引进 tasksByAuthorHandle,跨该作者的所有 article 都能命中。
   */
  tweetId: string
  actionType: 'LIKE' | 'RT' | 'COMMENT' | 'COMMENT_LIKE' | 'FOLLOW'
  /** 当前用户 effectiveTier 下应得的 LUX 奖励 */
  expectedReward: number
  /** COMMENT 类任务的关键词提示,non-comment 类型为 null */
  commentKeyword?: string | null
  /** FOLLOW 任务的目标账户 handle(小写)。non-FOLLOW 为 null */
  targetUsername?: string | null
}

// ── Stores ────────────────────────────────────────────────────────────

export const localStore = {
  async get<K extends keyof LocalSchema>(
    key: K,
  ): Promise<LocalSchema[K] | null> {
    const r = await chrome.storage.local.get(key)
    return (r[key] ?? null) as LocalSchema[K] | null
  },
  async set<K extends keyof LocalSchema>(key: K, val: LocalSchema[K]) {
    await chrome.storage.local.set({ [key]: val })
  },
  async remove(key: keyof LocalSchema) {
    await chrome.storage.local.remove(key)
  },
}

export const sessionStore = {
  async get<K extends keyof SessionSchema>(
    key: K,
  ): Promise<SessionSchema[K] | null> {
    const r = await chrome.storage.session.get(key)
    return (r[key] ?? null) as SessionSchema[K] | null
  },
  async set<K extends keyof SessionSchema>(key: K, val: SessionSchema[K]) {
    await chrome.storage.session.set({ [key]: val })
  },
  async clear() {
    await chrome.storage.session.clear()
  },
}
