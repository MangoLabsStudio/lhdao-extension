/**
 * 编译时注入的常量。在 wxt.config.ts 的 `vite.define` 块声明,
 * 由 WXT_API_ENDPOINT / WXT_WEB_ENDPOINT 环境变量覆盖,默认指向 prod。
 */
declare const __API_ENDPOINT__: string
declare const __WEB_ENDPOINT__: string

/**
 * GraphQL 端点 (compile-time inject)。
 *   - prod  : https://service.lhdao.top/graphql
 *   - beta  : https://service.lhdaobeta.top/graphql
 *   - 切换  : `WXT_API_ENDPOINT=https://service.lhdaobeta.top/graphql pnpm build`
 */
export const API_ENDPOINT: string = __API_ENDPOINT__

/**
 * Web 端点 (compile-time inject) — 用于跳转到 lhdao 网站的所有外链
 * (options 页的 "打开设置" / popup 的 "浏览全部任务" 等)。
 *   - prod  : https://lhdao.top
 *   - beta  : https://lhdaobeta.top
 *   - 切换  : `WXT_WEB_ENDPOINT=https://lhdaobeta.top pnpm build`
 *
 * 注意 token 数据库是 per-environment 的:在 lhdaobeta.top 创建的 token
 * 只能配合 service.lhdaobeta.top 的 API_ENDPOINT 使用,反之亦然。两个
 * env var 应该一起切。
 */
export const WEB_ENDPOINT: string = __WEB_ENDPOINT__

/** 后台 alarm 拉取任务的间隔 (秒)。chrome.alarms 下限 60s;这里设 5 分钟。 */
export const SYNC_INTERVAL_SECONDS = 300

/** 验证 mutation 失败后等待重试的间隔 (毫秒)。 */
export const VERIFY_RETRY_DELAY_MS = 5000

/** 缓存任务的 TTL (毫秒) — 超过则视为 stale,触发后台主动 refetch。 */
export const TASK_CACHE_TTL_MS = SYNC_INTERVAL_SECONDS * 1000
