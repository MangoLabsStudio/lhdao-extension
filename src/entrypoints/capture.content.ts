// ─────────────────────────────────────────────────────────────────────────
// [shadow 捕获] MAIN-world 网络拦截器(生产)。
// 拦 X 的 fetch/XHR → 判定互动动作(LIKE/RT/COMMENT 看请求体;FOLLOW 读
// friendships/create 响应体拿 handle)→ 仅在响应成功后 postMessage 给 isolated
// bridge(capture-bridge)。**不发任何网络、不持久化、不碰 chrome.*(MAIN 无此
// API)。** 上报后端由 background 通过 isolated bridge 完成。
// ─────────────────────────────────────────────────────────────────────────
import { dbg } from '@/lib/capture-debug'
import {
  CAPTURE_OPS,
  type CapturedAction,
  extractCapturedAction,
  extractCreatedCommentTweetId,
  extractFollowFromResponse,
} from '@/lib/engagement-capture'

const FOLLOW_RE = /\/friendships\/create/
const GQL_OP_RE = /\/graphql\/[^/]+\/([A-Za-z0-9_]+)/
const CAPTURE_OP_SET = new Set<string>(CAPTURE_OPS as readonly string[])

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    dbg('capture.content 已注入 (MAIN world)')

    const opFromUrl = (url?: string): string | null => {
      if (!url) return null
      const m = url.match(GQL_OP_RE)
      return m ? m[1] : null
    }

    // 只对我们关心的请求做(相对贵的)body 读取:互动 GraphQL op 或 关注接口。
    const isRelevant = (url?: string): boolean => {
      if (!url) return false
      if (FOLLOW_RE.test(url)) return true
      const op = opFromUrl(url)
      return op != null && CAPTURE_OP_SET.has(op)
    }

    // 尽量把请求体读成字符串。原实现只认 `init.body` 为 string,漏掉:
    //   ① fetch(new Request(url,{body})) —— body 在 Request 对象里(评论从某些
    //      入口发出正是这种)→ 之前读成 undefined → 判不出评论 → 漏捕获;
    //   ② body 是 URLSearchParams / Blob / ArrayBuffer / TypedArray。
    // Request 对象必须在真正 fetch **之前** clone(body 会被 fetch 消费)。
    // biome-ignore lint/suspicious/noExplicitAny: fetch input/init 类型宽泛
    const readBody = (input: any, init: any): Promise<string | undefined> => {
      const b = init?.body
      if (typeof b === 'string') return Promise.resolve(b)
      try {
        if (b instanceof URLSearchParams) return Promise.resolve(b.toString())
        if (b instanceof Blob) return b.text().catch(() => undefined)
        if (b instanceof ArrayBuffer)
          return Promise.resolve(new TextDecoder().decode(b))
        if (ArrayBuffer.isView(b))
          return Promise.resolve(new TextDecoder().decode(b as ArrayBufferView))
      } catch {}
      if (
        input &&
        typeof input === 'object' &&
        typeof input.clone === 'function' &&
        input.body != null
      ) {
        try {
          return input
            .clone()
            .text()
            .catch(() => undefined)
        } catch {}
      }
      return Promise.resolve(undefined)
    }

    const post = (action: CapturedAction): void => {
      try {
        dbg('MAIN 捕获到动作 →', action)
        window.postMessage(
          {
            __lhcap: true,
            action: { ...action, capturedAt: new Date().toISOString() },
          },
          window.location.origin,
        )
      } catch {}
    }

    // LIKE/RT/COMMENT:看请求体即可判定。相关 op 却抽不出动作 → 打诊断日志
    // (beta 才输出),便于定位「评论了没捕获」到底断在哪一步。
    const emitAction = (
      url: string,
      body: string | undefined,
      responseJson?: unknown,
    ): void => {
      const op = opFromUrl(url)
      const action = extractCapturedAction(op, body)
      if (action) {
        const resultTweetId = extractCreatedCommentTweetId(op, responseJson)
        post(resultTweetId ? { ...action, resultTweetId } : action)
        return
      }
      if (op && CAPTURE_OP_SET.has(op)) {
        dbg(
          'MAIN 相关 op 未抽出动作',
          op,
          'bodyRead?',
          body != null,
          body ? body.slice(0, 300) : '(空)',
        )
      }
    }

    // FOLLOW:friendships/create 的响应体 = 被关注用户对象(带 screen_name)。
    const emitFollow = (url: string | undefined, json: unknown): void => {
      const action = extractFollowFromResponse(url, json)
      if (action) post(action)
    }

    const urlOf = (input: unknown): string | undefined =>
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request)?.url

    // ① fetch:仅在响应 ok 时上报(过滤失败/限流的请求)。
    const _fetch = window.fetch
    window.fetch = function (...args: Parameters<typeof fetch>) {
      const input = args[0]
      const init = args[1]
      const url = urlOf(input)
      const relevant = isRelevant(url)
      // 在真正 fetch 前就读/clone body(Request body 会被 fetch 消费)。
      const bodyP = relevant ? readBody(input, init) : null
      const p = _fetch.apply(this, args)
      if (relevant && url) {
        p.then(async (res) => {
          if (!res.ok) return
          const body = bodyP ? await bodyP : undefined
          const responseJson = await res
            .clone()
            .json()
            .catch(() => undefined)
          emitAction(url, body, responseJson)
          if (FOLLOW_RE.test(url)) {
            res
              .clone()
              .json()
              .then((json) => emitFollow(url, json))
              .catch(() => {})
          }
        }).catch(() => {})
      }
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
      const url = self.__lhcapUrl
      if (isRelevant(url)) {
        // Blob/ArrayBuffer 等不可变体,load 后再读也拿得到;字符串直接给。
        const bodyP = readBody(undefined, { body: args[0] })
        this.addEventListener('load', () => {
          void (async () => {
            try {
              if (self.status < 200 || self.status >= 300) return
              const body = await bodyP
              if (!url) return
              let responseJson: unknown
              try {
                responseJson = JSON.parse(self.responseText)
              } catch {}
              emitAction(url, body, responseJson)
              if (FOLLOW_RE.test(url)) {
                emitFollow(url, JSON.parse(self.responseText))
              }
            } catch {}
          })()
        })
      }
      return (_send as (...a: unknown[]) => void).apply(this, args)
    }
  },
})
