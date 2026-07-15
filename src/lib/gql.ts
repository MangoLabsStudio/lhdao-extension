import { getOrCreateDeviceIdentity } from './device-key'
import { ensureLegacyDeviceRegistered } from './device-registration'
import { API_ENDPOINT } from './env'
import { parseRetryAfterMs } from './gql-backoff'
import { getPluginOperationByDocument } from './plugin-operations'
import { signPluginRequest } from './request-signing'
import { localStore } from './storage'
import { getDeviceId, maybeAttachWatermark } from './watermark'

/**
 * GraphQL 错误的统一类型。区分 HTTP 层(httpStatus)与 GraphQL 层
 * (graphqlErrors),便于上层根据错误类型选择 UX:
 *
 *   - httpStatus === 401      → token 失效,跳吊销 / 重新粘贴流程
 *   - httpStatus === undefined → 网络层错误(离线 / DNS 等)
 *   - graphqlErrors           → 业务异常(如 BAD_USER_INPUT、SLOT_FULL)
 *
 * 注意 Apollo Server 4 有一些情况会返回 4xx 状态码 + JSON body 的
 * `{ errors: [...] }`(典型如 schema 校验失败、未知字段),所以即使 res.ok
 * 为 false 我们也要先尝试读 body 才能拿到真正错误信息。
 */
export class GqlError extends Error {
  constructor(
    msg: string,
    public readonly graphqlErrors?: GqlErrorEntry[],
    public readonly httpStatus?: number,
    public readonly kind: GqlErrorKind = 'PROTOCOL',
    public readonly uncertain = false,
    public readonly abortSource?: GqlAbortSource,
    public readonly retryAfterMs?: number,
  ) {
    super(msg)
    this.name = 'GqlError'
  }
}

export type GqlErrorKind =
  | 'ABORT'
  | 'CLIENT'
  | 'GRAPHQL'
  | 'HTTP'
  | 'NETWORK'
  | 'PROTOCOL'

export type GqlAbortSource = 'CALLER' | 'TIMEOUT'

interface GqlErrorEntry {
  message: string
  extensions?: { code?: string; [key: string]: unknown }
  path?: (string | number)[]
}

interface GqlResponse<T> {
  data?: T
  errors?: GqlErrorEntry[]
}

export interface GqlOpts {
  /**
   * 匿名模式 — 不带 Authorization header,即便本地有 token 也忽略。
   *
   * 用于调 @IsPublic 的 endpoint(目前只有 extension pairing 三件套:
   * createExtensionPairing / completeExtensionPairing 主站调 /
   * pollExtensionPairing)。Pairing 流程里,扩展尚未持有 token,身份
   * 完全靠 32-char hex code 自证。
   */
  anonymous?: boolean
  /** 花费类操作的持久化幂等键；普通读写请求不设置。 */
  idempotencyKey?: string
  /** GraphQL document 包含多个 operation 时必须显式指定。 */
  operationName?: string
  /** 调用方取消与内部 timeout 会合并到传给 fetch 的单一 signal。 */
  signal?: AbortSignal
  /** 默认 15 秒。超时后的 mutation 结果属于不确定状态。 */
  timeoutMs?: number
}

export const DEFAULT_GQL_TIMEOUT_MS = 15_000

/**
 * GraphQL fetcher。统一用 plugin token 走 Bearer auth,失败抛 GqlError。
 *
 * 仅在 background SW 内调用 — content script / popup 通过 messaging
 * 间接发起,token 永不泄露给 hostile page。
 *
 * @param opts.anonymous - 设为 true 时不带 token header,可调 @IsPublic
 *   endpoint。默认 false(走 plugin token Bearer auth)。
 */
export async function gql<TResult, TVars = Record<string, unknown>>(
  query: string,
  variables?: TVars,
  opts?: GqlOpts,
): Promise<TResult> {
  const controller = new AbortController()
  let abortSource: GqlAbortSource | undefined
  const abortFromCaller = () => {
    if (controller.signal.aborted) return
    abortSource = 'CALLER'
    controller.abort()
  }

  if (opts?.signal?.aborted) abortFromCaller()
  else opts?.signal?.addEventListener('abort', abortFromCaller, { once: true })

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_GQL_TIMEOUT_MS
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return
    abortSource = 'TIMEOUT'
    controller.abort()
  }, timeoutMs)
  const waitForDeadline = <T>(operation: () => Promise<T>): Promise<T> =>
    runWithAbort(operation, controller.signal, () =>
      abortError(abortSource ?? 'CALLER', timeoutMs),
    )

  try {
    const token = opts?.anonymous
      ? null
      : await waitForDeadline(() => localStore.get('apiToken'))
    if (!opts?.anonymous && !token) {
      throw new GqlError(
        'No API token configured',
        undefined,
        undefined,
        'CLIENT',
      )
    }

    const operationName = opts?.operationName ?? inferOperationName(query)
    const mutationMayHaveCommitted = isMutationOperation(query, operationName)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Apollo Server 4 csrfPrevention 校验:任意一个非 CORS-safelisted
      // 请求头都会让 preflight 触发。我们已经因为 Authorization 触发了,
      // 但显式加上这个让任何 Apollo 配置都能通过。anonymous 模式下也加
      // 一个 custom header 触发 preflight(否则后端的 csrfPrevention
      // 会 reject simple POST)。
      'apollo-require-preflight': 'true',
      'X-Apollo-Operation-Name': operationName ?? 'unknown',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.idempotencyKey
        ? { 'x-idempotency-key': opts.idempotencyKey }
        : {}),
    }

    const operation = operationName
      ? getPluginOperationByDocument(query, operationName)
      : undefined
    if (operation) {
      const identity = await waitForDeadline(() => getOrCreateDeviceIdentity())
      if (token) {
        await waitForDeadline(() =>
          ensureLegacyDeviceRegistered(token, identity, controller.signal),
        )
      }
      const signed = await waitForDeadline(() =>
        signPluginRequest({
          operation,
          variables: variables ?? {},
          deviceId: identity.deviceId,
          privateKey: identity.privateKey,
        }),
      )
      Object.assign(headers, signed.headers)
    }

    // —— Watermark(抢单接口防护)————————————————————————————————
    // 给受保护的抢单/验证 mutation 拼上 watermark 头(mint token + reserve 的
    // PoW)。anonymous(pairing 三件套)不带 token、也不在保护名单,跳过。
    // x-device-id 统一在这里设,保证它跟 mint 内部用的是同一个 did。
    if (!opts?.anonymous && token) {
      headers['x-device-id'] = await waitForDeadline(() => getDeviceId())
      await waitForDeadline(() =>
        maybeAttachWatermark(headers, query, controller.signal),
      )
    }
    let res: Response
    try {
      res = await waitForDeadline(() =>
        fetch(API_ENDPOINT, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            query,
            variables,
            ...(opts?.operationName
              ? { operationName: opts.operationName }
              : {}),
          }),
        }),
      )
    } catch (error) {
      if (controller.signal.aborted) {
        throw abortError(abortSource ?? 'CALLER', timeoutMs)
      }
      // 网络层失败 — DNS / 离线 / CORS 拒绝 etc.。服务端是否已写入未知。
      throw new GqlError(
        `Network error: ${errorMessage(error)}`,
        undefined,
        undefined,
        'NETWORK',
        true,
      )
    }

    // 不管 res.ok,先尝试解析 body — Apollo 4xx 通常带 errors 数组
    const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'))
    let bodyText: string
    try {
      bodyText = await waitForDeadline(() => res.text())
    } catch (error) {
      if (controller.signal.aborted) {
        throw abortError(abortSource ?? 'CALLER', timeoutMs)
      }
      throw new GqlError(
        `Network error while reading response: ${errorMessage(error)}`,
        undefined,
        undefined,
        'NETWORK',
        true,
      )
    }

    if (controller.signal.aborted) {
      throw abortError(abortSource ?? 'CALLER', timeoutMs)
    }

    let json: GqlResponse<TResult> | null = null
    if (bodyText) {
      try {
        json = JSON.parse(bodyText) as GqlResponse<TResult>
      } catch {
        // 不是 JSON — 可能是 nginx / cloudflare 返回的 HTML 错误页
        json = null
      }
    }
    // GraphQL 层 errors(无论 status 如何都要冒泡)
    if (json?.errors?.length) {
      const first = json.errors[0]
      const code = first?.extensions?.code
      const message = first?.message ?? 'GraphQL error'
      // NestJS GraphQLExceptionFilter 对 BadRequest/Forbidden 等会把原始
      // response 塞进 extensions.details。当 message 退化成 code 字面量
      // (e.g. 'BAD_USER_INPUT: BAD_USER_INPUT')时,details 通常才是真凶。
      const details = first?.extensions?.details
      let detailStr = ''
      if (details && typeof details === 'object') {
        try {
          detailStr = ` · ${JSON.stringify(details).slice(0, 300)}`
        } catch {
          detailStr = ''
        }
      }
      const head = code ? `${code}: ${message}` : message
      throw new GqlError(
        head + detailStr,
        json.errors,
        res.status,
        'GRAPHQL',
        res.status >= 500 || code === 'INTERNAL_SERVER_ERROR',
        undefined,
        retryAfterMs,
      )
    }

    // 没 errors 但 HTTP 状态非 2xx → 真的是 transport 层失败
    if (!res.ok) {
      const snippet = bodyText.slice(0, 200) || '(empty body)'
      throw new GqlError(
        `HTTP ${res.status}: ${snippet}`,
        undefined,
        res.status,
        'HTTP',
        // A gateway/server 5xx can be emitted after the upstream mutation
        // committed but before its success response reached the extension.
        res.status >= 500,
        undefined,
        retryAfterMs,
      )
    }

    if (!json || json.data === undefined) {
      throw new GqlError(
        'GraphQL response missing data',
        undefined,
        res.status,
        'PROTOCOL',
        mutationMayHaveCommitted,
      )
    }
    return json.data
  } finally {
    clearTimeout(timer)
    opts?.signal?.removeEventListener('abort', abortFromCaller)
  }
}

function abortError(source: GqlAbortSource, timeoutMs: number): GqlError {
  const message =
    source === 'TIMEOUT'
      ? `Request timed out after ${timeoutMs}ms`
      : 'Request aborted by caller'
  return new GqlError(message, undefined, undefined, 'ABORT', true, source)
}

function runWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  createAbortError: () => GqlError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }

    if (signal.aborted) {
      reject(createAbortError())
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMutationOperation(
  query: string,
  operationName: string | null,
): boolean {
  if (!operationName) return /^\s*mutation\b/m.test(query)
  const escapedName = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\bmutation\\s+${escapedName}\\b`).test(query)
}

/**
 * 从 query 字符串里 sniff operation name(给 X-Apollo-Operation-Name header
 * 用)。失败返回 null,header 那边走 'unknown' fallback。
 */
function inferOperationName(query: string): string | null {
  const m = query.match(
    /^\s*(?:query|mutation|subscription)\s+([_A-Za-z][_A-Za-z0-9]*)/m,
  )
  return m ? m[1] : null
}
