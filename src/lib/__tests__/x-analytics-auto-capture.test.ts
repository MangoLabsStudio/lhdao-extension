import { beforeEach, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'

const gql = vi.hoisted(() => vi.fn())
vi.mock('../gql', () => ({ gql, GqlError: class extends Error {} }))

import {
  claimAnalyticsCapture,
  finishAnalyticsCapture,
  startAnalyticsCapture,
} from '../x-analytics-auto-capture'

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
