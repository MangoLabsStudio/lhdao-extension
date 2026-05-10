/**
 * 编译时注入的常量。在 wxt.config.ts 的 `vite.define` 块声明,
 * 由 `WXT_API_ENDPOINT` 环境变量覆盖,默认指向 prod。
 */
declare const __API_ENDPOINT__: string

/** GraphQL 端点 (compile-time inject) */
export const API_ENDPOINT: string = __API_ENDPOINT__

/** 后台 alarm 拉取任务的间隔 (秒)。<60s 会被 chrome 限制为 60s。 */
export const SYNC_INTERVAL_SECONDS = 60

/** 验证 mutation 失败后等待重试的间隔 (毫秒)。 */
export const VERIFY_RETRY_DELAY_MS = 5000

/** 缓存任务的 TTL (毫秒) — 超过则视为 stale,触发后台主动 refetch。 */
export const TASK_CACHE_TTL_MS = SYNC_INTERVAL_SECONDS * 1000
