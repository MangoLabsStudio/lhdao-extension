import { API_ENDPOINT } from './env'
import { localStore } from './storage'

/**
 * GraphQL 错误的统一类型。区分 HTTP 层(httpStatus)与 GraphQL 层
 * (graphqlErrors),便于上层根据错误类型选择 UX:
 *
 *   - httpStatus === 401      → token 失效,跳吊销 / 重新粘贴流程
 *   - httpStatus === undefined → 网络层错误(离线 / DNS 等)
 *   - graphqlErrors           → 业务异常(如 BAD_USER_INPUT、SLOT_FULL)
 */
export class GqlError extends Error {
  constructor(
    msg: string,
    public readonly graphqlErrors?: GqlErrorEntry[],
    public readonly httpStatus?: number,
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

/**
 * GraphQL fetcher。统一用 plugin token 走 Bearer auth,失败抛 GqlError。
 *
 * 仅在 background SW 内调用 — content script / popup 通过 messaging
 * 间接发起,token 永不泄露给 hostile page。
 */
export async function gql<TResult, TVars = Record<string, unknown>>(
  query: string,
  variables?: TVars,
): Promise<TResult> {
  const token = await localStore.get('apiToken')
  if (!token) {
    throw new GqlError('No API token configured')
  }

  let res: Response
  try {
    res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch (e) {
    // 网络层失败 — DNS / 离线 / CORS 拒绝 etc.
    throw new GqlError(`Network error: ${(e as Error).message}`)
  }

  if (!res.ok) {
    throw new GqlError(`HTTP ${res.status}`, undefined, res.status)
  }

  const json = (await res.json()) as GqlResponse<TResult>
  if (json.errors?.length) {
    throw new GqlError(
      json.errors[0]?.message ?? 'GraphQL error',
      json.errors,
      res.status,
    )
  }
  if (json.data === undefined) {
    throw new GqlError('GraphQL response missing data', undefined, res.status)
  }
  return json.data
}
