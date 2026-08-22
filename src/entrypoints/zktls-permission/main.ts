import { publicDnsHost } from '@/lib/zktls/interpreter'

const originElement = document.querySelector<HTMLParagraphElement>('#origin')!
const connector = document.querySelector<HTMLParagraphElement>('#connector')!
const allow = document.querySelector<HTMLButtonElement>('#allow')!
const statusElement = document.querySelector<HTMLParagraphElement>('#status')!
const requestId = new URLSearchParams(location.search).get('request_id')
type Preview = {
  origins: readonly [string] | readonly [string, string]
  connectorId: string
}
let preview: Preview | null = null

function parsePreview(value: unknown): Preview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    Object.keys(raw).length !== 2 ||
    !Object.hasOwn(raw, 'origins') ||
    !Object.hasOwn(raw, 'connectorId') ||
    !Array.isArray(raw.origins) ||
    (raw.origins.length !== 1 && raw.origins.length !== 2) ||
    typeof raw.connectorId !== 'string' ||
    !raw.connectorId ||
    raw.connectorId.length > 128
  )
    return null
  const origins = raw.origins as unknown[]
  if (origins.some((origin) => typeof origin !== 'string')) return null
  const normalized = [...new Set(origins as string[])].sort()
  if (
    normalized.length !== origins.length ||
    normalized.some((origin, index) => origin !== origins[index])
  )
    return null
  for (const origin of normalized) {
    try {
      const url = new URL(origin)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.origin !== origin ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.hostname.includes('*') ||
        !publicDnsHost(url.hostname)
      )
        return null
    } catch {
      return null
    }
  }
  return {
    origins: normalized as [string] | [string, string],
    connectorId: raw.connectorId,
  }
}

void (async () => {
  if (!requestId) {
    statusElement.textContent = 'Permission request is invalid.'
    return
  }
  preview = parsePreview(
    await chrome.runtime.sendMessage({
      type: 'zktls-permission-preview',
      requestId,
    }),
  )
  if (!preview) {
    statusElement.textContent = 'Permission request has expired.'
    return
  }
  originElement.textContent = `Origins: ${preview.origins
    .map((origin) => new URL(origin).host)
    .join(', ')}`
  connector.textContent = `Connector: ${preview.connectorId}`
  allow.disabled = false
})()

allow.addEventListener('click', () => {
  if (!preview || !requestId) return
  allow.disabled = true
  void chrome.permissions
    .request({ origins: preview.origins.map((origin) => `${origin}/*`) })
    .then(async (granted) => {
      await chrome.runtime.sendMessage({
        type: 'zktls-permission-result',
        requestId,
        granted,
      })
      statusElement.textContent = granted
        ? 'Allowed. Return to Lighthouse.'
        : 'Denied. Return to Lighthouse.'
    })
})
