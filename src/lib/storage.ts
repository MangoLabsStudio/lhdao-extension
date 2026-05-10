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
  /** 是否同意上报错误日志 (placeholder,后续接 Sentry) */
  optInErrorReport: boolean
}

interface SessionSchema {
  /** key = tweetId, value = 这条推文上挂着的所有可参与任务 */
  tasksByTweetId: Record<string, CampaignTaskCache[]>
  /** 上次 background SW 拉取任务的时间戳 (ms since epoch) */
  lastSyncAt: number
  /** 上次同步的错误信息;成功时为 null */
  lastSyncError: string | null
  /** 上次同步的错误对应 HTTP status (401/403/...);非 HTTP 错误为 null */
  lastSyncHttpStatus: number | null
}

/**
 * 经 GraphQL 拉来再扁平化后的任务缓存 row。content script 拿到后渲染 chip。
 *
 * 注意:不放原始 tweet URL 进 cache(URL 由 content script 现场解析得到 tweetId,
 * 反向查这张表)— 减少冗余存储,缓存大小可控。
 */
export interface CampaignTaskCache {
  campaignId: string
  /** 目标推文 id (从 targetUrl 抽出) */
  tweetId: string
  actionType: 'LIKE' | 'RT' | 'COMMENT' | 'COMMENT_LIKE'
  /** 当前用户 effectiveTier 下应得的 LUX 奖励 */
  expectedReward: number
  /** COMMENT 类任务的关键词提示,non-comment 类型为 null */
  commentKeyword?: string | null
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
