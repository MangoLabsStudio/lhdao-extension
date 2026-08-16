import { ZKTLS_PAGE_CHANNEL, type ZkTlsPageRequest } from './page-bridge'
import { zktlsVerificationPath } from './profile'

export function parseZkTlsRuntimeRequest(
  value: unknown,
  sender: chrome.runtime.MessageSender,
  origin: string,
): ZkTlsPageRequest | null {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.url)
    return null
  let url: URL
  try {
    url = new URL(sender.url)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 4 || record.type !== 'zktls-prove')
    return null
  const strings = [record.correlationId, record.sessionId, record.connectorId]
  if (
    !strings.every(
      (item) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item),
    )
  )
    return null
  if (url.pathname !== zktlsVerificationPath(record.sessionId as string))
    return null
  return {
    channel: ZKTLS_PAGE_CHANNEL,
    type: 'prove',
    correlationId: record.correlationId as string,
    sessionId: record.sessionId as string,
    connectorId: record.connectorId as string,
  }
}
