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
    public readonly retryAfterMs?: number,
  ) {
    super(msg)
    this.name = 'GqlError'
  }
}

interface GqlErrorEntry {
  message: string
  extensions?: { code?: string; [key: string]: unknown }
  path?: (string | number)[]
}

interface GqlResponse<T> {
  data?: T
  errors?: GqlErrorEntry[]
}

interface GqlOpts {
  /**
   * 匿名模式 — 不带 Authorization header,即便本地有 token 也忽略。
   *
   * 用于调 @IsPublic 的 endpoint(目前只有 extension pairing 三件套:
   * createExtensionPairing / completeExtensionPairing 主站调 /
   * pollExtensionPairing)。Pairing 流程里,扩展尚未持有 token,身份
   * 完全靠 32-char hex code 自证。
   */
  anonymous?: boolean
}

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
  const token = opts?.anonymous ? null : await localStore.get('apiToken')
  if (!opts?.anonymous && !token) {
    throw new GqlError('No API token configured')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Apollo Server 4 csrfPrevention 校验:任意一个非 CORS-safelisted
    // 请求头都会让 preflight 触发。我们已经因为 Authorization 触发了,
    // 但显式加上这个让任何 Apollo 配置都能通过。anonymous 模式下也加
    // 一个 custom header 触发 preflight(否则后端的 csrfPrevention
    // 会 reject simple POST)。
    'apollo-require-preflight': 'true',
    'X-Apollo-Operation-Name': inferOperationName(query) ?? 'unknown',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const operation = getPluginOperationByDocument(query)
  if (operation) {
    const identity = await getOrCreateDeviceIdentity()
    if (token) await ensureLegacyDeviceRegistered(token, identity)
    const signed = await signPluginRequest({
      operation,
      variables: variables ?? {},
      deviceId: identity.deviceId,
      privateKey: identity.privateKey,
    })
    Object.assign(headers, signed.headers)
  }

  // —— Watermark(抢单接口防护)————————————————————————————————
  // 给受保护的抢单/验证 mutation 拼上 watermark 头(mint token + reserve 的
  // PoW)。anonymous(pairing 三件套)不带 token、也不在保护名单,跳过。
  // x-device-id 统一在这里设,保证它跟 mint 内部用的是同一个 did。
  if (!opts?.anonymous && token) {
    headers['x-device-id'] = await getDeviceId()
    await maybeAttachWatermark(headers, query)
  }

  let res: Response
  try {
    res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    })
  } catch (e) {
    // 网络层失败 — DNS / 离线 / CORS 拒绝 etc.
    throw new GqlError(`Network error: ${(e as Error).message}`)
  }

  // 不管 res.ok,先尝试解析 body — Apollo 4xx 通常带 errors 数组
  let bodyText: string
  try {
    bodyText = await res.text()
  } catch {
    bodyText = ''
  }

  let json: GqlResponse<TResult> | null = null
  const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'))
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
    throw new GqlError(head + detailStr, json.errors, res.status, retryAfterMs)
  }

  // 没 errors 但 HTTP 状态非 2xx → 真的是 transport 层失败
  if (!res.ok) {
    const snippet = bodyText.slice(0, 200) || '(empty body)'
    throw new GqlError(
      `HTTP ${res.status}: ${snippet}`,
      undefined,
      res.status,
      retryAfterMs,
    )
  }

  if (!json || json.data === undefined) {
    throw new GqlError('GraphQL response missing data', undefined, res.status)
  }
  return json.data
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
