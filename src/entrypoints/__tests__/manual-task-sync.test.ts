import { beforeEach, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { gql } from '@/lib/gql'

const registered = vi.hoisted(() => ({
  handler: null as null | ((req: { type: 'force-sync' }) => Promise<unknown>),
}))

vi.mock('@/lib/messaging', () => ({
  onMessage: (handler: typeof registered.handler) => {
    registered.handler = handler
  },
  broadcastToContent: vi.fn(),
}))

vi.mock('@/lib/env', () => ({
  API_ENDPOINT: 'https://example.test/graphql',
  WEB_ENDPOINT: 'https://example.test',
  VERIFY_RETRY_DELAY_MS: 5000,
}))

vi.mock('@/lib/gql', () => {
  return {
    GqlError: class GqlError extends Error {},
    gql: vi.fn(async () => ({
      availableEngagements: [],
      myReservedEngagements: [],
      availableTweets: [],
      me: null,
    })),
  }
})

beforeEach(async () => {
  vi.resetModules()
  fakeBrowser.reset()
  vi.mocked(gql).mockClear()
  registered.handler = null
  Object.assign(globalThis, {
    chrome: fakeBrowser,
    defineBackground: (start: () => void) => start(),
  })
  await fakeBrowser.storage.local.set({ apiToken: 'lhdao_pk_test_token' })
})

it('only fetches task data when the popup requests one sync', async () => {
  const clearAlarm = vi.spyOn(fakeBrowser.alarms, 'clear')
  await fakeBrowser.alarms.create('lhdao-sync', { periodInMinutes: 1 })
  const background = await import('../background')
  background.default.main()

  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(gql).not.toHaveBeenCalled()
  expect(clearAlarm).toHaveBeenCalledWith('lhdao-sync')

  await fakeBrowser.storage.local.set({ apiToken: 'lhdao_pk_new_token' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(gql).not.toHaveBeenCalled()

  const response = await registered.handler?.({ type: 'force-sync' })
  expect(response).toMatchObject({ type: 'sync-result', ok: true })
  expect(gql).toHaveBeenCalledTimes(4)
})
