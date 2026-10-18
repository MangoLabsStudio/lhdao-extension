import type { MsgResponse } from '@/types/messages'
import { WEB_ENDPOINT } from './env'
import { GqlError, gql } from './gql'
import { MY_X_ANALYTICS_QUERY, type XAnalyticsStatusResult } from './queries'
import {
  type AnalyticsPreview,
  type AnalyticsSavePayload,
  type CaptureProgress,
  MAX_CAPTURE_ATTEMPTS,
  mergePreview,
  missingMetrics,
  normalizePreview,
  retryDelay,
} from './x-analytics-recovery'

const origin = new URL(WEB_ENDPOINT).origin
const key = (tabId: number) => `x-analytics-request:${tabId}`
const claiming = new Set<number>()
const retrying = new Set<number>()
export interface CaptureRequest {
  windowId?: number
  phase: 'loading' | 'reading' | 'account' | 'saving' | 'retrying' | 'error'
  runId: string
  attempt: number
  retryAt?: number
  preview?: AnalyticsPreview
  missing?: string[]
  savePayload?: AnalyticsSavePayload
  twitterUserId: string
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
        runId: crypto.randomUUID(),
        attempt: 1,
        twitterUserId: myXAnalytics.twitterUserId,
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

async function claimAnalyticsCaptureUnlocked(
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
      runId: request.runId,
      resume: request.savePayload,
    }
  } finally {
    claiming.delete(tabId)
  }
}

async function finishAnalyticsCaptureUnlocked(
  tabId: number,
  runId?: string,
): Promise<void> {
  const request = await pendingAnalyticsCapture(tabId)
  if (!request || (runId !== undefined && request.runId !== runId)) return
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

async function cancelAnalyticsCaptureUnlocked(tabId: number): Promise<void> {
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

async function reportAnalyticsCaptureUnlocked(
  sender: chrome.runtime.MessageSender,
  phase: CaptureRequest['phase'],
  message: string,
  details: CaptureProgress = {},
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
  if (
    !request?.claimed ||
    request.runId !== details.runId ||
    ['error', 'retrying'].includes(request.phase)
  )
    return { type: 'x-analytics-start-result', ok: false }
  const incoming = normalizePreview(details.preview)
  const todayTo = (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000
  const preview =
    incoming?.twitterUserId === request.twitterUserId && incoming.to === todayTo
      ? mergePreview(request.preview, incoming)
      : request.preview
  const recover =
    phase === 'error' &&
    details.retryable === true &&
    request.attempt < MAX_CAPTURE_ATTEMPTS
  await chrome.storage.session.set({
    [key(tabId)]: {
      ...request,
      preview,
      missing:
        incoming?.twitterUserId === request.twitterUserId &&
        incoming.to === todayTo
          ? missingMetrics(incoming)
          : request.missing,
      phase: recover ? 'retrying' : phase,
      message: message.slice(0, 600),
      retryAt: recover ? Date.now() + retryDelay(request.attempt) : undefined,
      savePayload:
        phase === 'error' && details.discardSave === true
          ? undefined
          : request.savePayload,
    },
  })
  return { type: 'ack' }
}

async function analyticsWindowActionUnlocked(
  sender: chrome.runtime.MessageSender,
  tabId: number,
  action: 'retry' | 'auto-retry' | 'show-page',
): Promise<MsgResponse> {
  const failure: MsgResponse = { type: 'x-analytics-start-result', ok: false }
  if (
    !Number.isSafeInteger(tabId) ||
    sender.id !== chrome.runtime.id ||
    sender.url !==
      chrome.runtime.getURL(`analytics-capture.html?tabId=${tabId}`)
  )
    return failure
  if (retrying.has(tabId)) return failure
  retrying.add(tabId)
  const request = await pendingAnalyticsCapture(tabId)
  if (!request) {
    retrying.delete(tabId)
    return failure
  }
  try {
    if (action === 'show-page') {
      const tab = await chrome.tabs.update(tabId, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
    } else if (
      (action === 'retry' &&
        (request.phase === 'error' || request.deadline <= Date.now())) ||
      (action === 'auto-retry' &&
        request.attempt < MAX_CAPTURE_ATTEMPTS &&
        ((request.phase === 'retrying' &&
          (request.retryAt ?? Infinity) <= Date.now()) ||
          (!['error', 'retrying'].includes(request.phase) &&
            request.deadline <= Date.now())))
    ) {
      // Invalidate the old document before navigation; delayed reports cannot overwrite this run.
      const next: CaptureRequest = {
        ...request,
        claimed: false,
        runId: crypto.randomUUID(),
        attempt: action === 'retry' ? 1 : request.attempt + 1,
        retryAt: undefined,
        phase: 'loading',
        message: request.savePayload
          ? '已保留完整数据，正在恢复保存…'
          : '已保留读取结果，正在重新请求 X 数据…',
        deadline: Date.now() + 90_000,
      }
      await chrome.storage.session.set({ [key(tabId)]: next })
      await chrome.tabs.update(tabId, { url: 'about:blank' })
      if (!(await pendingAnalyticsCapture(tabId))) return failure
      await chrome.tabs.update(tabId, {
        url: 'https://x.com/i/account_analytics',
      })
    } else return failure
    return { type: 'ack' }
  } catch {
    const current = await pendingAnalyticsCapture(tabId)
    if (!current) return failure
    await chrome.storage.session.set({
      [key(tabId)]: {
        ...current,
        phase: 'error',
        message: '无法打开 X 分析页，请关闭采集窗口后从 Lighthouse 重新开始。',
      },
    })
    return failure
  } finally {
    retrying.delete(tabId)
  }
}

// Store before sending the mutation. Ambiguous network failures replay this exact capture ID.
async function retainAnalyticsSaveUnlocked(
  tabId: number,
  runId: string | undefined,
  payload: AnalyticsSavePayload,
): Promise<boolean> {
  const request = await pendingAnalyticsCapture(tabId)
  if (
    !request?.claimed ||
    request.runId !== runId ||
    request.phase !== 'saving'
  )
    return false
  if (
    request.savePayload &&
    JSON.stringify(request.savePayload) !== JSON.stringify(payload)
  )
    return false
  await chrome.storage.session.set({
    [key(tabId)]: { ...request, savePayload: payload },
  })
  return true
}

// Serialize each session's mutations so close/retry/progress cannot resurrect or overwrite a newer run.
const sessionWrites = new Map<number, Promise<void>>()
function withSession<T>(tabId: number, action: () => Promise<T>): Promise<T> {
  const run = (sessionWrites.get(tabId) ?? Promise.resolve()).then(action)
  const settled = run.then(
    () => {},
    () => {},
  )
  sessionWrites.set(tabId, settled)
  void settled.then(() => {
    if (sessionWrites.get(tabId) === settled) sessionWrites.delete(tabId)
  })
  return run
}
export function claimAnalyticsCapture(sender: chrome.runtime.MessageSender) {
  return withSession(sender.tab?.id ?? -1, () =>
    claimAnalyticsCaptureUnlocked(sender),
  )
}
export function finishAnalyticsCapture(tabId: number, runId?: string) {
  return withSession(tabId, () => finishAnalyticsCaptureUnlocked(tabId, runId))
}
function cancelAnalyticsCapture(tabId: number) {
  return withSession(tabId, () => cancelAnalyticsCaptureUnlocked(tabId))
}
export function reportAnalyticsCapture(
  sender: chrome.runtime.MessageSender,
  phase: CaptureRequest['phase'],
  message: string,
  details: CaptureProgress = {},
) {
  return withSession(sender.tab?.id ?? -1, () =>
    reportAnalyticsCaptureUnlocked(sender, phase, message, details),
  )
}
export function analyticsWindowAction(
  sender: chrome.runtime.MessageSender,
  tabId: number,
  action: 'retry' | 'auto-retry' | 'show-page',
) {
  return withSession(tabId, () =>
    analyticsWindowActionUnlocked(sender, tabId, action),
  )
}
export function retainAnalyticsSave(
  tabId: number,
  runId: string | undefined,
  payload: AnalyticsSavePayload,
) {
  return withSession(tabId, () =>
    retainAnalyticsSaveUnlocked(tabId, runId, payload),
  )
}
