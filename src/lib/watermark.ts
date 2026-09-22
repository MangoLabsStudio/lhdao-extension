import { getDeviceId } from './device-key'
import { API_ENDPOINT } from './env'
import { solvePow } from './pow'
import {
  MINT_WATERMARK_TOKEN_QUERY,
  type MintWatermarkTokenResult,
} from './queries'
import { localStore } from './storage'

// ════════════════════════════════════════════════════════════════════════
// Watermark client —— 把后端 watermark 防护接进插件的抢单/验证调用
// ════════════════════════════════════════════════════════════════════════
//
// 后端对插件 token 的 ReserveEngagementSlot / VerifyEngagement 启用了 watermark
// (加密信封 + jti 一次性防重放,reserve 额外加 MD5 PoW)。本模块在 gql() 发请求
// 前:① mint 一个 watermark token(自带 fetch,避免跟 gql 循环依赖)② reserve
// 的 PoW challenge 现场求解 ③ 把 x-watermark-token / x-pow-* 拼进请求头。
//
// 蓝本:frontend/src/lib/watermark.ts。差异:
//   - 跑在 MV3 SW,无 window/localStorage → deviceId 存 chrome.storage.local,
//     token 只用进程内 Map 缓存(SW 被 GC 丢了就重 mint,无副作用)。
//   - mint 用独立 fetch,不走 gql()(否则 gql→watermark→gql 循环 import)。

/** 插件路径下走 watermark 校验的操作(PascalCase,跟后端 PLUGIN_ENFORCED_OPS 对齐) */
const PROTECTED_OPS = new Set(['ReserveEngagementSlot', 'VerifyEngagement'])

/** 其中需要 PoW 的(跟后端 POW_PROTECTED_MUTATIONS 对齐):只有 reserve */
const POW_PROTECTED_OPS = new Set(['ReserveEngagementSlot'])

const MINT_TIMEOUT_MS = 3_000
const MINT_TTL_MS = 120_000

export function extractOperationName(query: string): string | null {
  const match = query.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/)
  return match?.[2] ?? null
}

function inferOpType(query: string): 'QUERY' | 'MUTATION' {
  return /\bmutation\b/i.test(query) ? 'MUTATION' : 'QUERY'
}

/**
 * 取(或首次生成并持久化)稳定 deviceId。watermark 的 `did` 维度,reserve/verify
 * 请求与 mint 请求必须带同一个值,否则 verify 时 binding 不匹配。
 */
export { getDeviceId } from './device-key'

interface MintResult {
  token: string
  expiresAt: string | null
  powChallenge: string | null
  powDifficulty: string | null
}

/**
 * mint 一个 watermark token。独立 fetch,带 plugin token 的 Bearer auth +
 * x-device-id(后端 mint resolver 要求 did,缺了直接 WATERMARK_DEVICE_REQUIRED)。
 *
 * mintWatermarkToken 本身不在保护名单,后端不会对它再要 watermark,所以不会递归。
 */
async function mint(
  operationName: string,
  opType: 'QUERY' | 'MUTATION',
  deviceId: string,
  signal?: AbortSignal,
): Promise<MintResult> {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, MINT_TIMEOUT_MS)

  try {
    const token = await runWithAbort(
      () => localStore.get('apiToken'),
      controller.signal,
    )
    if (!token) throw new Error('No API token configured')

    const res = await runWithAbort(
      () =>
        fetch(API_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apollo-require-preflight': 'true',
            'X-Apollo-Operation-Name': 'MintWatermarkToken',
            Authorization: `Bearer ${token}`,
            'x-device-id': deviceId,
          },
          signal: controller.signal,
          body: JSON.stringify({
            query: MINT_WATERMARK_TOKEN_QUERY,
            variables: { operationName, opType },
          }),
        }),
      controller.signal,
    )

    if (!res.ok) throw new Error(`WATERMARK_MINT_HTTP_${res.status}`)

    const json = (await runWithAbort(() => res.json(), controller.signal)) as {
      data?: MintWatermarkTokenResult
      errors?: { message: string }[]
    }
    if (json.errors?.length) {
      throw new Error(`WATERMARK_MINT_FAILED: ${json.errors[0]?.message ?? ''}`)
    }
    const result = json.data?.mintWatermarkToken
    if (!result?.token) throw new Error('WATERMARK_MINT_FAILED')

    return {
      token: result.token,
      expiresAt: result.expiresAt,
      powChallenge: result.powChallenge,
      powDifficulty: result.powDifficulty,
    }
  } catch (e) {
    if (signal?.aborted) throw e
    throw timedOut ? new Error('WATERMARK_MINT_TIMEOUT') : e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

function runWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }

    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let promise: Promise<T>
    try {
      promise = Promise.resolve(operation())
    } catch (error) {
      cleanup()
      reject(error)
      return
    }
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

// ── 进程内 token 缓存(非 PoW 操作复用,降低 mint 频率)─────────────────
interface CachedEntry {
  token: string
  expiresAt: number
}
const tokenCache = new Map<string, CachedEntry>()
const pendingMints = new Map<string, Promise<MintResult>>()

function cacheKey(op: string, deviceId: string): string {
  return `${op}:${deviceId}`
}

/**
 * 给一个 GraphQL 请求拼上 watermark 头(就地修改 headers)。
 *
 *   - 非保护操作:直接返回,零开销。
 *   - 保护操作:mint → 拼 x-watermark-token + x-device-id;reserve 还要解 PoW
 *     拼 x-pow-nonce / x-pow-cost-ms。
 *   - mint 失败:拼 x-wm-status: mint-failed(后端据此区分 mint 故障 vs 机器人,
 *     observe 模式放行,enforce 模式才拒)——不阻断,降级交给后端策略决定。
 *
 * headers 必须已带 x-device-id(由 gql() 统一设置),这里复用同一个值保证
 * mint 与实际请求的 did 一致。
 */
export async function maybeAttachWatermark(
  headers: Record<string, string>,
  query: string,
  signal?: AbortSignal,
): Promise<void> {
  const op = extractOperationName(query)
  if (!op || !PROTECTED_OPS.has(op)) return

  const deviceId = headers['x-device-id'] ?? (await getDeviceId())
  headers['x-device-id'] = deviceId

  const isPowOp = POW_PROTECTED_OPS.has(op)
  const key = cacheKey(op, deviceId)

  let result: MintResult | null = null

  // 非 PoW 操作先查缓存(PoW token 是单次 jti,后端强制一次性,不缓存)
  if (!isPowOp) {
    const cached = tokenCache.get(key)
    if (cached && Date.now() < cached.expiresAt) {
      headers['x-watermark-token'] = cached.token
      return
    }
  }

  try {
    if (signal) {
      // 每个 gql 调用有独立 deadline，不能让一个调用的 abort 取消其他
      // 调用正在共享的 mint。带 signal 时不复用 pending promise。
      result = await mint(op, inferOpType(query), deviceId, signal)
    } else {
      // 无调用方 signal 的旧路径仍按 (op, device) 去重。
      let p = pendingMints.get(key)
      if (!p) {
        p = mint(op, inferOpType(query), deviceId).finally(() => {
          pendingMints.delete(key)
        })
        pendingMints.set(key, p)
      }
      result = await p
    }
  } catch (error) {
    if (signal?.aborted) throw error
    // 降级:mint 不成就让后端按 enforcement 模式决定收不收
    headers['x-wm-status'] = 'mint-failed'
    return
  }

  headers['x-watermark-token'] = result.token

  // 缓存非 PoW token 到 80% TTL,留网络抖动缓冲
  if (!isPowOp) {
    let ttlMs = MINT_TTL_MS
    if (result.expiresAt) {
      ttlMs = Math.max(0, new Date(result.expiresAt).getTime() - Date.now())
    }
    tokenCache.set(key, {
      token: result.token,
      expiresAt: Date.now() + ttlMs * 0.8,
    })
  }

  // PoW:reserve 才有 challenge,现场解出 nonce
  if (result.powChallenge && isPowOp) {
    try {
      const { nonce, cost } = solvePow(
        result.powChallenge,
        result.powDifficulty ?? '0000',
      )
      headers['x-pow-nonce'] = nonce
      headers['x-pow-cost-ms'] = String(cost)
    } catch {
      // 解不出(难度异常)→ 不带 nonce,后端记 WM_POW_MISSING
    }
  }
}
