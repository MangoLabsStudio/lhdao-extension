// ─────────────────────────────────────────────────────────────────────────
// [网页存在标记] 只跑在 Lighthouse 网页域(app.lhdao.top / app.lhdaobeta.top),
// 向网页宣告「插件已安装」+ 版本。网页据此做「做任务前必须装插件」的门槛。
//
// 两种探测通道(网页任选):
//   ① DOM 标记:document.documentElement[data-lhdao-ext]=<version>(document_start
//      即设,网页 React 挂载后直接读)。
//   ② postMessage 握手:网页发 {__lhdaoExtPing__:true} → 回 {__lhdaoExtPong__:true,version}。
// isolated world(默认)—— 有 chrome.* 取版本,又能改共享 DOM / 用共享 window。
// 不碰 token、不发网络、不读页面数据,纯存在性宣告。
// ─────────────────────────────────────────────────────────────────────────

import { WEB_ENDPOINT, WEB_MATCH_PATTERN } from '@/lib/env'
import {
  PRODUCT_EXPERIENCE_PAGE_CHANNEL,
  parseProductExperiencePageRequest,
} from '@/lib/product-experience-task-bridge'
import type { MsgResponse } from '@/types/messages'

const MARK_ATTR = 'data-lhdao-ext'
const LIGHTHOUSE_ORIGIN = new URL(WEB_ENDPOINT).origin

export default defineContentScript({
  matches: [WEB_MATCH_PATTERN],
  runAt: 'document_start',
  main(ctx) {
    let version = '0'
    try {
      version = chrome.runtime.getManifest().version
    } catch {
      // 上下文失效兜底
    }

    const mark = (): void => {
      try {
        document.documentElement?.setAttribute(MARK_ATTR, version)
      } catch {
        // ignore
      }
    }
    // document_start 时 <html> 已存在;DOMContentLoaded 再兜一次防极端时序。
    mark()
    document.addEventListener('DOMContentLoaded', mark, { once: true })

    // ping/pong 握手 —— 网页监听可能晚于 content script,故既响应 ping 也主动广播。
    const pong = (): void => {
      try {
        window.postMessage(
          { __lhdaoExtPong__: true, version },
          window.location.origin,
        )
      } catch {
        // ignore
      }
    }
    const postProductError = (
      correlationId: string,
      requestType: string,
    ): void => {
      window.postMessage(
        {
          channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
          type: 'product-experience-error',
          requestType,
          correlationId,
          error: 'EXTENSION_ERROR',
        },
        LIGHTHOUSE_ORIGIN,
      )
    }

    const forwardProductRequest = (e: MessageEvent): boolean => {
      const request = parseProductExperiencePageRequest(
        e,
        window,
        LIGHTHOUSE_ORIGIN,
      )
      if (!request) return false

      if (request.type === 'save-product-experience-task') {
        void chrome.runtime
          .sendMessage({
            type: request.type,
            task: request.task,
            correlationId: request.correlationId,
          })
          .then((response: MsgResponse) => {
            if (
              response.type !== 'save-product-experience-task-result' ||
              response.correlationId !== request.correlationId ||
              !response.ok
            ) {
              postProductError(request.correlationId, request.type)
              return
            }
            window.postMessage(
              {
                channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
                type: 'save-product-experience-task-result',
                correlationId: request.correlationId,
                ok: true,
              },
              LIGHTHOUSE_ORIGIN,
            )
          })
          .catch(() => postProductError(request.correlationId, request.type))
        return true
      }

      void chrome.runtime
        .sendMessage({
          type: request.type,
          campaignId: request.campaignId,
          correlationId: request.correlationId,
        })
        .then((response: MsgResponse) => {
          if (
            response.type !== 'public-product-experience-state-result' ||
            response.correlationId !== request.correlationId
          ) {
            postProductError(request.correlationId, request.type)
            return
          }
          const state = response.state
          window.postMessage(
            {
              channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
              type: 'public-product-experience-state-result',
              correlationId: request.correlationId,
              state: {
                campaignId: state.campaignId,
                status: state.status,
                matchedRuleIds: [...state.matchedRuleIds],
                totalRuleCount: state.totalRuleCount,
                authorizationRequired: state.authorizationRequired,
                currentOriginAllowed: state.currentOriginAllowed,
                version: state.version,
                capabilities: [...state.capabilities],
                error: state.error,
              },
            },
            LIGHTHOUSE_ORIGIN,
          )
        })
        .catch(() => postProductError(request.correlationId, request.type))
      return true
    }

    const onWindowMessage = (e: MessageEvent): void => {
      if (e.source !== window || e.origin !== LIGHTHOUSE_ORIGIN) return
      if (forwardProductRequest(e)) return
      const d = e.data as
        | {
            __lhdaoExtPing__?: boolean
            __lhdaoExtQuery__?: string
            id?: string
            campaignId?: string
            tweetId?: string
          }
        | undefined
      if (!d || typeof d !== 'object') return
      if (d.__lhdaoExtPing__ === true) {
        pong()
        return
      }
      // [网页走插件签名验证] 网页发 {__lhdaoExtQuery__:'verify', id, campaignId}
      // → 转 background 的 verify-task(= verifyOnly:mint 票据→签名→submitEngagementProof
      // →后端 recordCapture(signed)+requestVerify 入队)→ 回
      // {__lhdaoExtResult__:'verify', id, ok, code, message}。让网页点验证也能走插件
      // 权威签名(否则读不到签名键、回落 Twitter)。复用现成 verify-task,无需改 background。
      if (d.__lhdaoExtQuery__ === 'verify' && d.campaignId) {
        const id = d.id
        chrome.runtime
          .sendMessage({ type: 'verify-task', campaignId: d.campaignId })
          .then(
            (
              r:
                | {
                    type?: string
                    ok?: boolean
                    code?: string
                    message?: string
                  }
                | undefined,
            ) => {
              window.postMessage(
                {
                  __lhdaoExtResult__: 'verify',
                  id,
                  ok: r?.type === 'verify-result' ? !!r.ok : false,
                  code: r?.code,
                  message: r?.message,
                },
                window.location.origin,
              )
            },
          )
          .catch((err: unknown) => {
            // 上下文失效 / 消息失败 → 回 ok:false,网页显示验证失败(不静默通过)
            window.postMessage(
              {
                __lhdaoExtResult__: 'verify',
                id,
                ok: false,
                code: 'EXT_BRIDGE_ERROR',
                message: err instanceof Error ? err.message : 'plugin error',
              },
              window.location.origin,
            )
          })
        return
      }
      // [网页 gate] 查捕获:网页发 {__lhdaoExtQuery__:'captured', id, campaignId, tweetId}
      // → 转 background 查 capMap → 回 {__lhdaoExtResult__:'captured', id, actions}。
      if (d.__lhdaoExtQuery__ === 'captured' && d.campaignId) {
        const id = d.id
        chrome.runtime
          .sendMessage({
            type: 'get-captured-actions',
            campaignId: d.campaignId,
            tweetId: d.tweetId,
          })
          .then((r: { type?: string; actions?: string[] } | undefined) => {
            window.postMessage(
              {
                __lhdaoExtResult__: 'captured',
                id,
                actions:
                  r?.type === 'captured-actions' ? (r.actions ?? []) : [],
              },
              window.location.origin,
            )
          })
          .catch(() => {
            // 上下文失效等 → 回空(网页按未捕获处理)
            window.postMessage(
              { __lhdaoExtResult__: 'captured', id, actions: [] },
              window.location.origin,
            )
          })
      }
    }
    window.addEventListener('message', onWindowMessage)

    const onRuntimeMessage = (message: unknown): void => {
      if (
        typeof message !== 'object' ||
        message === null ||
        (message as { type?: unknown }).type !==
          'product-experience-state-changed'
      ) {
        return
      }
      window.postMessage(
        {
          channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
          type: 'product-experience-state-changed',
        },
        LIGHTHOUSE_ORIGIN,
      )
    }
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    ctx.onInvalidated(() => {
      window.removeEventListener('message', onWindowMessage)
      document.removeEventListener('DOMContentLoaded', mark)
      chrome.runtime.onMessage.removeListener(onRuntimeMessage)
    })
    pong()
  },
})
