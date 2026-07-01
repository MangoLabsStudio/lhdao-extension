// ─────────────────────────────────────────────────────────────────────────
// [shadow 捕获] isolated-world 桥:接 MAIN 世界 capture.content 的 __lhcap 消息,
// 转成 report-engagement-capture RPC 发给 background(background 负责 token /
// tweetId→campaign 映射 / 上报后端)。fire-and-forget,失败静默。
// 放 isolated world = 能用 chrome.* 但仍不接触 x.com 页面 JS 的密钥/token。
// ─────────────────────────────────────────────────────────────────────────
import { sendMessage } from '@/lib/messaging'

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  world: 'ISOLATED',
  runAt: 'document_start',
  main() {
    window.addEventListener('message', (e) => {
      if (e.source !== window) return
      const d = e.data as
        | { __lhcap?: boolean; action?: Record<string, unknown> }
        | undefined
      if (!d || d.__lhcap !== true || !d.action) return
      const a = d.action
      if (typeof a.actionType !== 'string' || typeof a.tweetId !== 'string')
        return
      void sendMessage({
        type: 'report-engagement-capture',
        actionType: a.actionType as 'LIKE' | 'RT' | 'COMMENT',
        tweetId: a.tweetId,
        commentText:
          typeof a.commentText === 'string' ? a.commentText : undefined,
        capturedAt:
          typeof a.capturedAt === 'string'
            ? a.capturedAt
            : new Date().toISOString(),
      }).catch(() => {})
    })
  },
})
