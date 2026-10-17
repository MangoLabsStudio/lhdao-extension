import type { MsgResponse } from '@/types/messages'
import { WEB_ENDPOINT } from './env'
import { GqlError, gql } from './gql'
import { MY_X_ANALYTICS_QUERY, type XAnalyticsStatusResult } from './queries'

const origin = new URL(WEB_ENDPOINT).origin
const key = (tabId: number) => `x-analytics-request:${tabId}`
const claiming = new Set<number>()
export interface CaptureRequest {
  windowId?: number
  phase: 'loading' | 'reading' | 'account' | 'saving' | 'error'
  message: string
  deadline: number
  sourceTabId: number
  twitterUsername: string
  expiresAt: number
  claimed: boolean
}

function isLighthouse(url: string | undefined): boolean {
  try {
    return new URL(url ?? '').origin === origin
  } catch {
    return false
  }
}

export async function pendingAnalyticsCapture(
  tabId: number,
): Promise<CaptureRequest | null> {
  const stored = (await chrome.storage.session.get(key(tabId)))[key(tabId)] as
    | CaptureRequest
    | undefined
  if (!stored) return null
  if (stored.expiresAt <= Date.now()) {
    await chrome.storage.session.remove(key(tabId))
    return null
  }
  return stored
}

export async function startAnalyticsCapture(
  twitterUsername: string,
  sender: chrome.runtime.MessageSender,
): Promise<MsgResponse> {
  const failure = (code: string): MsgResponse => ({
    type: 'x-analytics-start-result',
    ok: false,
    code,
  })
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !isLighthouse(sender.url) ||
    !isLighthouse(sender.tab.url) ||
    typeof twitterUsername !== 'string' ||
    !/^[A-Za-z0-9_]{1,15}$/.test(twitterUsername)
  )
    return failure('INVALID_REQUEST')
  let tabId: number | undefined
  try {
    const { myXAnalytics } =
      await gql<XAnalyticsStatusResult>(MY_X_ANALYTICS_QUERY)
    if (
      !myXAnalytics.twitterUserId ||
      myXAnalytics.twitterUsername?.toLowerCase() !==
        twitterUsername.toLowerCase()
    )
      return failure('WRONG_X_ACCOUNT')
    // Persist the one-shot request before navigating, so a fast content script cannot race it.
    tabId = (
      await chrome.tabs.create({
        url: 'about:blank',
        active: false,
        windowId: sender.tab.windowId,
      })
    ).id
    if (tabId === undefined) return failure('NETWORK')
    await chrome.storage.session.set({
      [key(tabId)]: {
        sourceTabId: sender.tab.id,
        twitterUsername: twitterUsername.toLowerCase(),
        expiresAt: Date.now() + 10 * 60_000,
        claimed: false,
        phase: 'loading',
        message: '正在打开 X 分析页…',
        deadline: Date.now() + 90_000,
      } satisfies CaptureRequest,
    })
    const sourceWindow =
      sender.tab.windowId === undefined
        ? null
        : await chrome.windows.get(sender.tab.windowId).catch(() => null)
    const popupOptions = {
      url: chrome.runtime.getURL(`analytics-capture.html?tabId=${tabId}`),
      type: 'popup' as const,
      width: 460,
      height: 740,
      focused: true,
      ...(sourceWindow?.width
        ? {
            left:
              (sourceWindow.left ?? 0) + Math.max(0, sourceWindow.width - 480),
            top: (sourceWindow.top ?? 0) + 40,
          }
        : {}),
    }
    const popup = await chrome.windows.create(popupOptions).catch((error) => {
      if (!/bounds/i.test(String(error))) throw error
      // A window can straddle screens; let Chrome place the popup if those bounds are off-screen.
      const { left: _left, top: _top, ...defaultPosition } = popupOptions
      return chrome.windows.create(defaultPosition)
    })
    if (popup?.id === undefined) throw new Error('Capture window unavailable')
    const request = await pendingAnalyticsCapture(tabId)
    if (!request) throw new Error('Capture expired')
    await chrome.storage.session.set({
      [key(tabId)]: { ...request, windowId: popup.id },
    })
    await chrome.tabs.update(tabId, {
      url: 'https://x.com/i/account_analytics',
      active: true,
    })
    await chrome.windows.update(popup.id, { focused: true })
    return { type: 'x-analytics-start-result', ok: true }
  } catch (error) {
    if (tabId !== undefined) {
      await cancelAnalyticsCapture(tabId).catch(() => {})
    }
    return failure(
      error instanceof GqlError && error.kind === 'CLIENT'
        ? 'NO_TOKEN'
        : 'NETWORK',
    )
  }
}

export async function claimAnalyticsCapture(
  sender: chrome.runtime.MessageSender,
): Promise<MsgResponse> {
  const none: MsgResponse = {
    type: 'x-analytics-auto-capture',
    autoCapture: false,
  }
  const tabId = sender.tab?.id
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    tabId === undefined ||
    !/^https:\/\/(?:x|twitter)\.com\/i\/account_analytics(?:[/?#]|$)/.test(
      sender.url ?? '',
    ) ||
    claiming.has(tabId)
  )
    return none
  claiming.add(tabId)
  try {
    const request = await pendingAnalyticsCapture(tabId)
    if (!request || request.claimed || request.deadline <= Date.now())
      return none
    await chrome.storage.session.set({
      [key(tabId)]: { ...request, claimed: true },
    })
    return {
      type: 'x-analytics-auto-capture',
      autoCapture: true,
      twitterUsername: request.twitterUsername,
    }
  } finally {
    claiming.delete(tabId)
  }
}

export async function finishAnalyticsCapture(tabId: number): Promise<void> {
  const request = await pendingAnalyticsCapture(tabId)
  if (!request) return
  await chrome.storage.session.remove(key(tabId))
  // Saving has already succeeded; closing or navigating the original tab must not turn it into a failure.
  try {
    const source = await chrome.tabs.get(request.sourceTabId)
    if (isLighthouse(source.url)) {
      await chrome.tabs.update(request.sourceTabId, { active: true })
      if (source.windowId !== undefined)
        await chrome.windows.update(source.windowId, { focused: true })
    }
  } catch {
    // Saving succeeded even if the original tab has closed.
  }
  if (request.windowId !== undefined)
    await chrome.windows.remove(request.windowId).catch(() => {})
  await chrome.tabs.remove(tabId).catch(() => {})
}

async function cancelAnalyticsCapture(tabId: number): Promise<void> {
  const request = (await chrome.storage.session.get(key(tabId)))[key(tabId)] as
    | CaptureRequest
    | undefined
  await chrome.storage.session.remove(key(tabId))
  if (request?.windowId !== undefined)
    await chrome.windows.remove(request.windowId).catch(() => {})
  await chrome.tabs.remove(tabId).catch(() => {})
}

export async function closeAnalyticsCaptureWindow(
  windowId: number,
): Promise<void> {
  const requests = await chrome.storage.session.get(null)
  for (const [name, request] of Object.entries(requests)) {
    if (
      name.startsWith('x-analytics-request:') &&
      request.windowId === windowId
    ) {
      await cancelAnalyticsCapture(Number(name.split(':')[1]))
    }
  }
}

export async function closeAnalyticsCaptureTab(tabId: number): Promise<void> {
  if ((await chrome.storage.session.get(key(tabId)))[key(tabId)])
    await cancelAnalyticsCapture(tabId)
}

export async function reportAnalyticsCapture(
  sender: chrome.runtime.MessageSender,
  phase: CaptureRequest['phase'],
  message: string,
): Promise<MsgResponse> {
  const tabId = sender.tab?.id
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    tabId === undefined ||
    !/^https:\/\/(?:x|twitter)\.com\/i\/account_analytics(?:[/?#]|$)/.test(
      sender.url ?? '',
    ) ||
    !['reading', 'account', 'saving', 'error'].includes(phase) ||
    typeof message !== 'string'
  )
    return { type: 'x-analytics-start-result', ok: false }
  const request = await pendingAnalyticsCapture(tabId)
  if (!request?.claimed || request.phase === 'error')
    return { type: 'x-analytics-start-result', ok: false }
  await chrome.storage.session.set({
    [key(tabId)]: { ...request, phase, message: message.slice(0, 600) },
  })
  return { type: 'ack' }
}

export async function analyticsWindowAction(
  sender: chrome.runtime.MessageSender,
  tabId: number,
  action: 'retry' | 'show-page',
): Promise<MsgResponse> {
  const failure: MsgResponse = { type: 'x-analytics-start-result', ok: false }
  if (
    !Number.isSafeInteger(tabId) ||
    sender.id !== chrome.runtime.id ||
    sender.url !==
      chrome.runtime.getURL(`analytics-capture.html?tabId=${tabId}`)
  )
    return failure
  const request = await pendingAnalyticsCapture(tabId)
  if (!request) return failure
  try {
    if (action === 'show-page') {
      const tab = await chrome.tabs.update(tabId, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
    } else if (
      action === 'retry' &&
      (request.phase === 'error' || request.deadline <= Date.now())
    ) {
      await chrome.tabs.update(tabId, { url: 'about:blank' })
      await chrome.storage.session.set({
        [key(tabId)]: {
          ...request,
          claimed: false,
          phase: 'loading',
          message: '正在重新打开 X 分析页…',
          deadline: Date.now() + 90_000,
          expiresAt: Date.now() + 10 * 60_000,
        },
      })
      await chrome.tabs.update(tabId, {
        url: 'https://x.com/i/account_analytics',
      })
    } else return failure
    return { type: 'ack' }
  } catch {
    await chrome.storage.session.set({
      [key(tabId)]: {
        ...request,
        phase: 'error',
        message: '无法打开 X 分析页，请关闭采集窗口后从 Lighthouse 重新开始。',
      },
    })
    return failure
  }
}
