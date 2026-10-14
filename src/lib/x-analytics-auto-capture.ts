import type { MsgResponse } from '@/types/messages'
import { WEB_ENDPOINT } from './env'
import { GqlError, gql } from './gql'
import { MY_X_ANALYTICS_QUERY, type XAnalyticsStatusResult } from './queries'

const origin = new URL(WEB_ENDPOINT).origin
const key = (tabId: number) => `x-analytics-request:${tabId}`
const claiming = new Set<number>()
interface CaptureRequest {
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
    tabId = (await chrome.tabs.create({ url: 'about:blank', active: false })).id
    if (tabId === undefined) return failure('NETWORK')
    await chrome.storage.session.set({
      [key(tabId)]: {
        sourceTabId: sender.tab.id,
        twitterUsername: twitterUsername.toLowerCase(),
        expiresAt: Date.now() + 10 * 60_000,
        claimed: false,
      } satisfies CaptureRequest,
    })
    await chrome.tabs.update(tabId, {
      url: 'https://x.com/i/account_analytics',
      active: true,
    })
    return { type: 'x-analytics-start-result', ok: true }
  } catch (error) {
    if (tabId !== undefined) {
      await chrome.storage.session.remove(key(tabId)).catch(() => {})
      await chrome.tabs.remove(tabId).catch(() => {})
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
    if (!request || request.claimed) return none
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
    if (isLighthouse(source.url))
      await chrome.tabs.update(request.sourceTabId, { active: true })
  } catch {
    // The user can return to Lighthouse from the success message.
  }
}
