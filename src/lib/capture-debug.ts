import { API_ENDPOINT } from './env'

/**
 * [shadow 捕获] 调试日志开关:beta 构建(endpoint 含 lhdaobeta)自动开,
 * 生产构建自动关。用于定位「捕获→桥→background→上报」链断在哪一跳。
 */
export const CAPTURE_DEBUG = API_ENDPOINT.includes('lhdaobeta')

export function dbg(...args: unknown[]) {
  if (CAPTURE_DEBUG) console.log('[lhcap]', ...args)
}
