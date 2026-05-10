import type { MsgRequest, MsgResponse } from '@/types/messages'

/**
 * Content script / popup 端发消息给 background SW。
 * 注意:在 SW 没启动的极端情况下 chrome.runtime.sendMessage 会先唤醒,
 * Promise reject 极少见(通常发生在 extension 被禁/重载时)。
 */
export function sendMessage(msg: MsgRequest): Promise<MsgResponse> {
  return chrome.runtime.sendMessage(msg)
}

/**
 * Background SW 端注册 RPC handler。返回 `true` 让 chrome 保持 channel
 * 打开等异步响应 — 这是 MV3 service worker 的硬要求,否则消息丢弃。
 *
 * Handler 抛异常会被 catch 成 INTERNAL 错误,不会 crash SW。
 */
export function onMessage(
  handler: (
    req: MsgRequest,
    sender: chrome.runtime.MessageSender,
  ) => Promise<MsgResponse> | MsgResponse,
) {
  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    Promise.resolve(handler(req as MsgRequest, sender))
      .then(sendResponse)
      .catch((e) => {
        sendResponse({
          type: 'submit-result',
          ok: false,
          code: 'INTERNAL',
          message: String(e),
        } satisfies MsgResponse)
      })
    return true // 异步响应
  })
}

/**
 * BG 主动广播给所有 content script(目前只用 `tasks-updated`)。
 * 不等待响应,失败仅 console.warn — 没活的 tab 是常态。
 */
export function broadcastToContent(
  msg: Extract<MsgRequest, { type: 'tasks-updated' }>,
) {
  chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {
        // No-op:tab 还没注入 content script 是正常情况。
      })
    }
  })
}
