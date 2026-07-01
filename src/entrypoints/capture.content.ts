// ─────────────────────────────────────────────────────────────────────────
// [shadow 捕获] MAIN-world 网络拦截器(生产)。
// 拦 X 的 fetch/XHR → 从请求体判定互动动作(LIKE/RT/COMMENT)→ 仅在响应成功后
// postMessage 给 isolated bridge(capture-bridge)。
// **不读响应体、不发任何网络、不持久化、不碰 chrome.*(MAIN world 无此 API)。**
// 上报后端由 background 通过 isolated bridge 完成。
// ─────────────────────────────────────────────────────────────────────────
import { extractCapturedAction } from '@/lib/engagement-capture'

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    function opNameFrom(url?: string, body?: string): string | null {
      if (url) {
        const m = url.match(/\/graphql\/[^/]+\/([A-Za-z0-9_]+)/)
        if (m) return m[1]
      }
      if (body) {
        try {
          return JSON.parse(body).operationName ?? null
        } catch {}
      }
      return null
    }

    function emit(url: string | undefined, body: string | undefined) {
      try {
        if (!url) return
        const action = extractCapturedAction(opNameFrom(url, body), body)
        if (!action) return
        window.postMessage(
          {
            __lhcap: true,
            action: { ...action, capturedAt: new Date().toISOString() },
          },
          window.location.origin,
        )
      } catch {}
    }

    // ① fetch:动作看请求即可判定;仅在响应 ok 时上报(过滤失败/限流的请求)。
    const _fetch = window.fetch
    window.fetch = function (...args: Parameters<typeof fetch>) {
      const input = args[0]
      const init = args[1]
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request)?.url
      const body = typeof init?.body === 'string' ? init.body : undefined
      const p = _fetch.apply(this, args)
      p.then((res) => {
        if (res.ok) emit(url, body)
      }).catch(() => {})
      return p
    }

    // ② XHR:同理,load 后按 2xx 判定。
    const _open = XMLHttpRequest.prototype.open
    const _send = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (...args: unknown[]) {
      ;(this as unknown as { __lhcapUrl?: unknown }).__lhcapUrl = args[1]
      return (_open as (...a: unknown[]) => void).apply(this, args)
    }
    XMLHttpRequest.prototype.send = function (...args: unknown[]) {
      const self = this as XMLHttpRequest & { __lhcapUrl?: string }
      const b = args[0]
      this.addEventListener('load', () => {
        if (self.status >= 200 && self.status < 300) {
          emit(self.__lhcapUrl, typeof b === 'string' ? b : undefined)
        }
      })
      return (_send as (...a: unknown[]) => void).apply(this, args)
    }
  },
})
