export const ZKTLS_PAGE_CHANNEL = 'lighthouse-zktls-v1'

export type ZkTlsPageRequest = {
  channel: typeof ZKTLS_PAGE_CHANNEL
  type: 'prove'
  correlationId: string
  sessionId: string
  connectorId: string
}

export type ZkTlsPageResult = {
  channel: typeof ZKTLS_PAGE_CHANNEL
  type: 'prove-result'
  correlationId: string
  sessionId: string
  connectorId: string
  status: 'submitted' | 'pending_login' | 'error' | 'unsupported'
  code?: string
}

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/

export function createZkTlsPageResult(
  request: ZkTlsPageRequest,
  result: Pick<ZkTlsPageResult, 'status' | 'code'>,
): ZkTlsPageResult {
  return {
    channel: ZKTLS_PAGE_CHANNEL,
    type: 'prove-result',
    correlationId: request.correlationId,
    sessionId: request.sessionId,
    connectorId: request.connectorId,
    status: result.status,
    ...(result.code ? { code: result.code } : {}),
  }
}

export function parseZkTlsPageRequest(
  event: MessageEvent,
  page: Window,
  origin: string,
  pathname: string,
): ZkTlsPageRequest | null {
  if (event.source !== page || event.origin !== origin) return null
  const value = event.data
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 5 ||
    record.channel !== ZKTLS_PAGE_CHANNEL ||
    record.type !== 'prove'
  )
    return null
  if (
    ![record.correlationId, record.sessionId, record.connectorId].every(
      (item) => typeof item === 'string' && TOKEN.test(item),
    )
  )
    return null
  if (pathname !== `/verify/${record.sessionId}`) return null
  return record as ZkTlsPageRequest
}
