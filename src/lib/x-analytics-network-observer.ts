import {
  ANALYTICS_EVENT,
  analyticsRequest,
  parseAnalyticsResponse,
} from './x-analytics-network'

const MAX_BYTES = 2_000_000
export function installAnalyticsNetworkObserver(
  enabled = () => /^\/i\/account_analytics(?:[/?#]|$)/.test(location.pathname),
): () => void {
  const originalFetch = window.fetch
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  const urls = new WeakMap<XMLHttpRequest, string>()
  let latest = 0
  const candidate = (url: string) =>
    enabled() && /\/accountOverviewDailyQuery(?:\?|$)/.test(url)
  const bodyText = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      if (typeof init?.body === 'string')
        return init.body.length <= 20_000 ? init.body : undefined
      if (input instanceof Request && input.body) {
        const text = await input.clone().text()
        return text.length <= 20_000 ? text : undefined
      }
    } catch {}
    return undefined
  }
  const publish = (
    url: string,
    body: string | undefined,
    status: number,
    json: unknown,
    startedAt: number,
    sequence: number,
  ) => {
    if (!enabled() || sequence !== latest) return
    const request = analyticsRequest(url, body, startedAt)
    if (!request) return
    window.postMessage(
      {
        type: ANALYTICS_EVENT,
        startedAt,
        result: parseAnalyticsResponse(request, status, json),
      },
      location.origin,
    )
  }
  const wrappedFetch: typeof fetch = function (this: Window, ...args) {
    const [input, init] = args
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (!candidate(url)) return originalFetch.apply(this, args)
    const startedAt = Date.now()
    const sequence = ++latest
    const body = bodyText(input, init)
    const promise = originalFetch.apply(this, args)
    void promise
      .then(
        async (response) => {
          const requestBody = await body
          if (!analyticsRequest(url, requestBody, startedAt)) return
          if (!response.ok)
            return publish(
              url,
              requestBody,
              response.status,
              null,
              startedAt,
              sequence,
            )
          if (Number(response.headers.get('content-length')) > MAX_BYTES)
            return publish(url, requestBody, 200, null, startedAt, sequence)
          const reader = response.clone().body?.getReader()
          if (!reader)
            return publish(url, requestBody, 200, null, startedAt, sequence)
          const decoder = new TextDecoder()
          let size = 0
          let text = ''
          try {
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done) break
              size += chunk.value.byteLength
              if (size > MAX_BYTES) {
                void reader.cancel().catch(() => {})
                return publish(url, requestBody, 200, null, startedAt, sequence)
              }
              text += decoder.decode(chunk.value, { stream: true })
            }
            text += decoder.decode()
            publish(
              url,
              requestBody,
              response.status,
              JSON.parse(text),
              startedAt,
              sequence,
            )
          } catch {
            publish(url, requestBody, 200, null, startedAt, sequence)
          } finally {
            reader.releaseLock()
          }
        },
        async () => publish(url, await body, 0, null, startedAt, sequence),
      )
      .catch(() => {})
    return promise
  }
  window.fetch = wrappedFetch
  const wrappedOpen = function (this: XMLHttpRequest, ...args: unknown[]) {
    urls.set(this, String(args[1]))
    return (originalOpen as (...args: unknown[]) => void).apply(this, args)
  } as typeof originalOpen
  const wrappedSend = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const url = urls.get(this)
    const text =
      typeof body === 'string' && body.length <= 20_000 ? body : undefined
    const startedAt = Date.now()
    if (url && candidate(url) && analyticsRequest(url, text, startedAt)) {
      const sequence = ++latest
      this.addEventListener(
        'loadend',
        () => {
          let json: unknown
          try {
            if (this.responseType === 'json') json = this.response
            else if (
              (!this.responseType || this.responseType === 'text') &&
              this.responseText.length <= MAX_BYTES
            )
              json = JSON.parse(this.responseText)
          } catch {}
          publish(url, text, this.status, json, startedAt, sequence)
        },
        { once: true },
      )
    }
    return originalSend.call(this, body)
  }
  XMLHttpRequest.prototype.open = wrappedOpen
  XMLHttpRequest.prototype.send = wrappedSend
  return () => {
    if (window.fetch === wrappedFetch) window.fetch = originalFetch
    if (XMLHttpRequest.prototype.open === wrappedOpen)
      XMLHttpRequest.prototype.open = originalOpen
    if (XMLHttpRequest.prototype.send === wrappedSend)
      XMLHttpRequest.prototype.send = originalSend
  }
}
