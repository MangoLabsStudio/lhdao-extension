import { beforeEach, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'

const gql = vi.hoisted(() => vi.fn())
vi.mock('../gql', () => ({ gql, GqlError: class extends Error {} }))

import {
  analyticsWindowAction,
  claimAnalyticsCapture,
  closeAnalyticsCaptureTab,
  closeAnalyticsCaptureWindow,
  finishAnalyticsCapture,
  pendingAnalyticsCapture,
  reportAnalyticsCapture as reportCurrent,
  startAnalyticsCapture,
} from '../x-analytics-auto-capture'

const reportAnalyticsCapture: typeof reportCurrent = async (
  sender,
  phase,
  message,
  details,
) =>
  reportCurrent(
    sender,
    phase,
    message,
    details ?? {
      runId: (await pendingAnalyticsCapture(sender.tab?.id ?? -1))?.runId,
    },
  )
const source = (): chrome.runtime.MessageSender => ({
  id: chrome.runtime.id,
  frameId: 0,
  url: 'https://app.lhdao.top/campaigns',
  tab: { id: 10, url: 'https://app.lhdao.top/campaigns' } as chrome.tabs.Tab,
})
const target = (id = 20): chrome.runtime.MessageSender => ({
  id: chrome.runtime.id,
  frameId: 0,
  url: 'https://x.com/i/account_analytics',
  tab: { id, url: 'https://x.com/i/account_analytics' } as chrome.tabs.Tab,
})
beforeEach(() => {
  fakeBrowser.reset()
  vi.restoreAllMocks()
  gql.mockResolvedValue({
    myXAnalytics: { twitterUserId: 'x-id', twitterUsername: 'creator' },
  })
  vi.spyOn(chrome.windows, 'create').mockImplementation(
    async () => ({ id: 30 }) as chrome.windows.Window,
  )
  vi.spyOn(chrome.windows, 'update').mockImplementation(
    async () => ({ id: 30 }) as chrome.windows.Window,
  )
  vi.spyOn(chrome.windows, 'remove').mockResolvedValue()
  vi.spyOn(chrome.tabs, 'remove').mockResolvedValue()
  vi.spyOn(chrome.tabs, 'create').mockImplementation(
    async () => ({ id: 20 }) as chrome.tabs.Tab,
  )
  vi.spyOn(chrome.tabs, 'update').mockImplementation(
    async () => ({ id: 20 }) as chrome.tabs.Tab,
  )
})
it('opens a fixed analytics page and allows exactly one automatic capture in that tab', async () => {
  expect(await startAnalyticsCapture('creator', source())).toMatchObject({
    ok: true,
  })
  expect(chrome.tabs.update).toHaveBeenCalledWith(20, {
    url: 'https://x.com/i/account_analytics',
    active: true,
  })
  expect(await claimAnalyticsCapture(target(21))).toMatchObject({
    autoCapture: false,
  })
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: true,
    twitterUsername: 'creator',
  })
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: false,
  })
})
it('rejects an untrusted origin, iframe and mismatched plugin account before opening a tab', async () => {
  expect(
    await startAnalyticsCapture('creator', {
      ...source(),
      url: 'https://evil.test/',
    }),
  ).toMatchObject({ ok: false })
  expect(
    await startAnalyticsCapture('creator', { ...source(), frameId: 1 }),
  ).toMatchObject({ ok: false })
  expect(await startAnalyticsCapture('other', source())).toMatchObject({
    code: 'WRONG_X_ACCOUNT',
  })
  expect(chrome.tabs.create).not.toHaveBeenCalled()
})
it('expires a pending request and never automatically captures ordinary analytics visits', async () => {
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: false,
  })
  await startAnalyticsCapture('creator', source())
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: false,
  })
})
it('returns to the original Lighthouse tab only after successful saving', async () => {
  await startAnalyticsCapture('creator', source())
  vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
    id: 10,
    url: source().url,
  } as chrome.tabs.Tab)
  await finishAnalyticsCapture(20)
  expect(chrome.tabs.update).toHaveBeenCalledWith(10, { active: true })
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: false,
  })
})

it('opens an independent extension popup only for an authorized collection request', async () => {
  const create = vi
    .spyOn(chrome.windows, 'create')
    .mockImplementation(async () => ({ id: 30 }) as chrome.windows.Window)
  await startAnalyticsCapture('creator', source())
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'popup',
      url: chrome.runtime.getURL('analytics-capture.html?tabId=20'),
    }),
  )
})

const popupSender = (): chrome.runtime.MessageSender => ({
  id: chrome.runtime.id,
  url: chrome.runtime.getURL('analytics-capture.html?tabId=20'),
})
it('reports progress only for a claimed request and keeps the error visible', async () => {
  await startAnalyticsCapture('creator', source())
  expect(
    await reportAnalyticsCapture(target(), 'reading', 'loading'),
  ).toMatchObject({ ok: false })
  await claimAnalyticsCapture(target())
  expect(
    await reportAnalyticsCapture(target(), 'error', 'X HTTP_403'),
  ).toMatchObject({ type: 'ack' })
  expect(await pendingAnalyticsCapture(20)).toMatchObject({
    phase: 'error',
    message: 'X HTTP_403',
  })
  expect(
    await reportAnalyticsCapture(target(21), 'reading', 'other'),
  ).toMatchObject({ ok: false })
})
it('retries a failed capture by loading a fresh analysis document and claiming once', async () => {
  await startAnalyticsCapture('creator', source())
  await claimAnalyticsCapture(target())
  await reportAnalyticsCapture(target(), 'error', 'X HTTP_403')
  expect(await analyticsWindowAction(popupSender(), 20, 'retry')).toMatchObject(
    { type: 'ack' },
  )
  expect(chrome.tabs.update).toHaveBeenCalledWith(20, { url: 'about:blank' })
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: true,
  })
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: false,
  })
})
it('does not permit X pages to retry and rejects retries while already collecting', async () => {
  await startAnalyticsCapture('creator', source())
  expect(await analyticsWindowAction(target(), 20, 'retry')).toMatchObject({
    ok: false,
  })
  expect(await analyticsWindowAction(popupSender(), 20, 'retry')).toMatchObject(
    { ok: false },
  )
})
it('cancels the request and its created analysis tab when its popup closes', async () => {
  await startAnalyticsCapture('creator', source())
  await claimAnalyticsCapture(target())
  await closeAnalyticsCaptureWindow(30)
  expect(chrome.tabs.remove).toHaveBeenCalledWith(20)
  expect(await pendingAnalyticsCapture(20)).toBeNull()
  expect(
    await reportAnalyticsCapture(target(), 'saving', 'saving'),
  ).toMatchObject({ ok: false })
})
it('closes the progress window when its analysis tab closes', async () => {
  await startAnalyticsCapture('creator', source())
  await closeAnalyticsCaptureTab(20)
  expect(chrome.windows.remove).toHaveBeenCalledWith(30)
  expect(await pendingAnalyticsCapture(20)).toBeNull()
})
it('cleans up after a blocked popup instead of reporting a started capture', async () => {
  vi.mocked(chrome.windows.create).mockRejectedValueOnce(new Error('blocked'))
  expect(await startAnalyticsCapture('creator', source())).toMatchObject({
    ok: false,
  })
  expect(chrome.tabs.remove).toHaveBeenCalledWith(20)
  expect(await pendingAnalyticsCapture(20)).toBeNull()
})
it('closes both collection surfaces after save, even if the source tab was closed', async () => {
  await startAnalyticsCapture('creator', source())
  vi.spyOn(chrome.tabs, 'get').mockRejectedValue(new Error('closed'))
  await finishAnalyticsCapture(20)
  expect(chrome.windows.remove).toHaveBeenCalledWith(30)
  expect(chrome.tabs.remove).toHaveBeenCalledWith(20)
  expect(await pendingAnalyticsCapture(20)).toBeNull()
})
it('allows an explicit retry after the analysis page never loaded', async () => {
  await startAnalyticsCapture('creator', source())
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 91_000)
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: false,
  })
  expect(await analyticsWindowAction(popupSender(), 20, 'retry')).toMatchObject(
    { type: 'ack' },
  )
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    autoCapture: true,
  })
})

it('falls back to browser placement when the screen rejects the requested top-right bounds', async () => {
  vi.mocked(chrome.windows.create).mockRejectedValueOnce(
    new Error('Invalid value for bounds'),
  )
  expect(await startAnalyticsCapture('creator', source())).toMatchObject({
    ok: true,
  })
  expect(chrome.windows.create).toHaveBeenCalledTimes(2)
  expect(chrome.windows.create).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'popup' }),
  )
  expect(vi.mocked(chrome.windows.create).mock.calls[1][0]).not.toHaveProperty(
    'left',
  )
})

it('bounds automatic retries, retains preview, and rejects stale reports', async () => {
  gql.mockResolvedValue({
    myXAnalytics: { twitterUserId: '123', twitterUsername: 'creator' },
  })
  await startAnalyticsCapture('creator', source())
  const initial = await claimAnalyticsCapture(target())
  const to = (Math.floor(Date.now() / 86400000) + 1) * 86400000
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = await pendingAnalyticsCapture(20)
    await reportAnalyticsCapture(target(), 'error', 'temporary', {
      runId: current!.runId,
      retryable: true,
      preview: {
        twitterUserId: '123',
        from: to - 90 * 86400000,
        to,
        metrics: { impressions: 1201 },
      },
    })
    const failed = await pendingAnalyticsCapture(20)
    expect(failed?.preview?.metrics.impressions).toBe(1201)
    expect(failed?.attempt).toBe(attempt)
    expect(failed?.phase).toBe(attempt < 3 ? 'retrying' : 'error')
    if (attempt < 3) {
      expect(
        await analyticsWindowAction(popupSender(), 20, 'auto-retry'),
      ).toMatchObject({ ok: false })
      vi.spyOn(Date, 'now').mockReturnValue(failed!.retryAt!)
      const results = await Promise.all([
        analyticsWindowAction(popupSender(), 20, 'auto-retry'),
        analyticsWindowAction(popupSender(), 20, 'auto-retry'),
      ])
      expect(results.filter((r) => r.type === 'ack')).toHaveLength(1)
      await claimAnalyticsCapture(target())
    }
  }
  expect(
    await analyticsWindowAction(popupSender(), 20, 'auto-retry'),
  ).toMatchObject({ ok: false })
  expect(
    await reportAnalyticsCapture(target(), 'reading', 'late', {
      runId: 'runId' in initial ? initial.runId : '',
    }),
  ).toMatchObject({ ok: false })
  await closeAnalyticsCaptureWindow(30)
  expect(
    await analyticsWindowAction(popupSender(), 20, 'auto-retry'),
  ).toMatchObject({ ok: false })
})

it('rejects stale generations and mismatched-account previews during an active retry', async () => {
  gql.mockResolvedValue({
    myXAnalytics: { twitterUserId: '123', twitterUsername: 'creator' },
  })
  await startAnalyticsCapture('creator', source())
  await claimAnalyticsCapture(target())
  const original = (await pendingAnalyticsCapture(20))!
  await reportAnalyticsCapture(target(), 'error', 'retry')
  await analyticsWindowAction(popupSender(), 20, 'retry')
  await claimAnalyticsCapture(target())
  expect(
    await reportCurrent(target(), 'error', 'old error', {
      runId: original.runId,
    }),
  ).toMatchObject({ ok: false })
  const to = (Math.floor(Date.now() / 86400000) + 1) * 86400000
  await reportAnalyticsCapture(target(), 'reading', 'partial', {
    runId: (await pendingAnalyticsCapture(20))!.runId,
    preview: {
      twitterUserId: '456',
      from: to - 90 * 86400000,
      to,
      metrics: { impressions: 999 },
    },
  })
  expect((await pendingAnalyticsCapture(20))?.preview).toBeUndefined()
  await finishAnalyticsCapture(20, original.runId)
  expect(await pendingAnalyticsCapture(20)).not.toBeNull()
})
it('retains an ambiguous save for retry but clears a rejected payload for manual recapture', async () => {
  const { retainAnalyticsSave } = await import('../x-analytics-auto-capture')
  await startAnalyticsCapture('creator', source())
  await claimAnalyticsCapture(target())
  const runId = (await pendingAnalyticsCapture(20))!.runId
  await reportAnalyticsCapture(target(), 'saving', 'saving')
  const payload = {
    captureId: 'same-id',
    twitterUsername: 'creator',
    periodStart: '2026-07-21',
    periodEnd: '2026-10-18',
    capturedAt: new Date().toISOString(),
    metrics: { impressions: 42 },
  }
  expect(await retainAnalyticsSave(20, runId, payload)).toBe(true)
  expect(
    await retainAnalyticsSave(20, runId, {
      ...payload,
      captureId: 'different-id',
    }),
  ).toBe(false)
  await reportAnalyticsCapture(target(), 'error', 'network', {
    runId,
    retryable: true,
  })
  expect((await pendingAnalyticsCapture(20))?.savePayload).toEqual(payload)
  vi.spyOn(Date, 'now').mockReturnValue(
    (await pendingAnalyticsCapture(20))!.retryAt!,
  )
  await analyticsWindowAction(popupSender(), 20, 'auto-retry')
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    resume: payload,
  })
  await reportAnalyticsCapture(target(), 'error', 'rate limited', {
    runId: (await pendingAnalyticsCapture(20))!.runId,
    retryable: false,
  })
  expect((await pendingAnalyticsCapture(20))?.phase).toBe('error')
  expect((await pendingAnalyticsCapture(20))?.savePayload).toEqual(payload)
  await analyticsWindowAction(popupSender(), 20, 'retry')
  expect(await claimAnalyticsCapture(target())).toMatchObject({
    resume: payload,
  })
  await reportAnalyticsCapture(target(), 'error', 'invalid', {
    runId: (await pendingAnalyticsCapture(20))!.runId,
    retryable: false,
    discardSave: true,
  })
  expect((await pendingAnalyticsCapture(20))?.savePayload).toBeUndefined()
})

it('serializes concurrent progress and cancellation without resurrecting a closed session', async () => {
  await startAnalyticsCapture('creator', source())
  await claimAnalyticsCapture(target())
  const runId = (await pendingAnalyticsCapture(20))!.runId
  await Promise.all([
    reportCurrent(target(), 'reading', 'reading', { runId }),
    closeAnalyticsCaptureWindow(30),
  ])
  expect(await pendingAnalyticsCapture(20)).toBeNull()
})
it('accepts a new document claim and progress while retry navigation is settling', async () => {
  await startAnalyticsCapture('creator', source())
  await claimAnalyticsCapture(target())
  await reportAnalyticsCapture(target(), 'error', 'temporary')
  const retried = analyticsWindowAction(popupSender(), 20, 'retry')
  const claimed = claimAnalyticsCapture(target())
  await retried
  const result = await claimed
  expect(result).toMatchObject({ autoCapture: true })
  expect(
    await reportCurrent(target(), 'reading', 'new document', {
      runId: 'runId' in result ? result.runId : undefined,
    }),
  ).toEqual({ type: 'ack' })
})
