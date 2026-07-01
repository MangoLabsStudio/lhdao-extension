// ─────────────────────────────────────────────────────────────────────────
// [shadow 捕获] MAIN-world 网络拦截器(生产)。
// 拦 X 的 fetch/XHR → 判定互动动作(LIKE/RT/COMMENT 看请求体;FOLLOW 读
// friendships/create 响应体拿 handle)→ 仅在响应成功后 postMessage 给 isolated
// bridge(capture-bridge)。**不发任何网络、不持久化、不碰 chrome.*(MAIN 无此
// API)。** 上报后端由 background 通过 isolated bridge 完成。
// ─────────────────────────────────────────────────────────────────────────
import {
  type CapturedAction,
  extractCapturedAction,
  extractFollowFromResponse,
} from '@/lib/engagement-capture'

const FOLLOW_RE = /\/friendships\/create/

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

    function post(action: CapturedAction) {
      try {
        window.postMessage(
          {
            __lhcap: true,
            action: { ...action, capturedAt: new Date().toISOString() },
          },
          window.location.origin,
        )
      } catch {}
    }

    // LIKE/RT/COMMENT:看请求体即可判定。
    function emitAction(url: string | undefined, body: string | undefined) {
      if (!url) return
      const action = extractCapturedAction(opNameFrom(url, body), body)
      if (action) post(action)
    }

    // FOLLOW:friendships/create 的响应体 = 被关注用户对象(带 screen_name)。
    function emitFollow(url: string | undefined, json: unknown) {
      const action = extractFollowFromResponse(url, json)
      if (action) post(action)
    }

    // ① fetch:仅在响应 ok 时上报(过滤失败/限流的请求)。
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
        if (!res.ok) return
        emitAction(url, body)
        if (url && FOLLOW_RE.test(url)) {
          res
            .clone()
            .json()
            .then((json) => emitFollow(url, json))
            .catch(() => {})
        }
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
        try {
          if (self.status < 200 || self.status >= 300) return
          const url = self.__lhcapUrl
          emitAction(url, typeof b === 'string' ? b : undefined)
          if (url && FOLLOW_RE.test(url)) {
            emitFollow(url, JSON.parse(self.responseText))
          }
        } catch {}
      })
      return (_send as (...a: unknown[]) => void).apply(this, args)
    }
  },
})
