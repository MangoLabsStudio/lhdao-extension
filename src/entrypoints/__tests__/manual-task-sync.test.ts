import { beforeEach, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { gql } from '@/lib/gql'

const registered = vi.hoisted(() => ({
  handler: null as
    | null
    | ((
        req: {
          type:
            | 'force-sync'
            | 'get-tasks-snapshot'
            | 'get-popup-data'
            | 'get-sidebar-data'
            | 'get-balance'
        },
        sender: chrome.runtime.MessageSender,
      ) => Promise<unknown>),
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
  vi.mocked(gql).mockReset().mockResolvedValue({
    availableEngagements: [],
    myReservedEngagements: [],
    availableTweets: [],
    me: null,
  })
  registered.handler = null
  Object.assign(globalThis, {
    chrome: fakeBrowser,
    defineBackground: (start: () => void) => start(),
  })
  await fakeBrowser.storage.local.set({ apiToken: 'lhdao_pk_test_token' })
})

const loadSnapshot = () =>
  registered.handler?.(
    { type: 'get-tasks-snapshot' },
    {
      id: fakeBrowser.runtime.id,
      tab: { id: 1 } as chrome.tabs.Tab,
      url: 'https://x.com/user/status/123456',
    },
  )

const xSender = () => ({
  id: fakeBrowser.runtime.id,
  tab: { id: 1 } as chrome.tabs.Tab,
  url: 'https://x.com/user/status/123456',
})
const popupSender = () => ({
  id: fakeBrowser.runtime.id,
  url: fakeBrowser.runtime.getURL('popup.html'),
})
const personalMe = {
  id: 'user-a',
  nickname: 'Alice',
  twitterUsername: 'alice',
  tier: 'A',
  newLux: 50.3,
  todayEarnings: 1.4,
}

it.each([
  'get-popup-data',
  'get-sidebar-data',
  'get-balance',
] as const)('automatically loads personal data on the first %s read', async (type) => {
  vi.mocked(gql).mockResolvedValue({
    availableEngagements: [],
    myReservedEngagements: [],
    availableTweets: [],
    me: personalMe,
  })
  const background = await import('../background')
  background.default.main()
  const response = await registered.handler?.(
    { type },
    type === 'get-popup-data' ? popupSender() : xSender(),
  )
  expect(response).toMatchObject(
    type === 'get-balance'
      ? { balance: 50.3 }
      : {
          profile: {
            id: 'user-a',
            displayName: 'Alice',
            twitterHandle: 'alice',
            tier: 'A',
            newLux: 50.3,
            todayEarnings: 1.4,
          },
        },
  )
  expect(gql).toHaveBeenCalledTimes(4)
})

it('shares first personal and task loads and keeps popup refreshes local across worker restarts', async () => {
  const background = await import('../background')
  background.default.main()
  await Promise.all([
    registered.handler?.({ type: 'get-popup-data' }, popupSender()),
    registered.handler?.({ type: 'get-sidebar-data' }, xSender()),
    loadSnapshot(),
  ])
  for (let i = 0; i < 3; i++)
    await registered.handler?.({ type: 'get-popup-data' }, popupSender())
  await restartWorker()
  await registered.handler?.({ type: 'get-popup-data' }, popupSender())
  expect(gql).toHaveBeenCalledTimes(4)
})

it('does not initialize from a personal read on an unrelated page', async () => {
  const background = await import('../background')
  background.default.main()
  for (const type of [
    'get-popup-data',
    'get-sidebar-data',
    'get-balance',
  ] as const)
    await registered.handler?.(
      { type },
      { ...xSender(), url: 'https://example.test/' },
    )
  expect(gql).not.toHaveBeenCalled()
})

it('loads once on first X visit and account change, then refreshes manually', async () => {
  const clearAlarm = vi.spyOn(fakeBrowser.alarms, 'clear')
  await fakeBrowser.alarms.create('lhdao-sync', { periodInMinutes: 1 })
  const background = await import('../background')
  background.default.main()

  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(gql).not.toHaveBeenCalled()
  expect(await loadSnapshot()).toMatchObject({ ready: true })
  expect(gql).toHaveBeenCalledTimes(4)
  expect(clearAlarm).toHaveBeenCalledWith('lhdao-sync')

  await fakeBrowser.storage.local.set({ apiToken: 'lhdao_pk_new_token' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(gql).toHaveBeenCalledTimes(4)
  await loadSnapshot()
  expect(gql).toHaveBeenCalledTimes(8)

  const response = await registered.handler?.(
    { type: 'force-sync' },
    {
      id: fakeBrowser.runtime.id,
      url: fakeBrowser.runtime.getURL('/popup.html'),
    },
  )
  expect(response).toMatchObject({ type: 'sync-result', ok: true })
  expect(gql).toHaveBeenCalledTimes(12)
  expect(
    vi
      .mocked(gql)
      .mock.calls.slice(-4)
      .map(([document]) => document.match(/\bquery\s+(\w+)/)?.[1]),
  ).toEqual([
    'ManualAvailableEngagements',
    'ManualMyReservedEngagements',
    'ManualAvailableTweets',
    'Me',
  ])
})

async function restartWorker() {
  const local = await fakeBrowser.storage.local.get()
  const session = await fakeBrowser.storage.session.get()
  fakeBrowser.reset()
  await fakeBrowser.storage.local.set(local)
  await fakeBrowser.storage.session.set(session)
  vi.resetModules()
  const background = await import('../background')
  background.default.main()
  return background
}

it('does not reload a valid empty snapshot after a worker restart or page reads', async () => {
  const background = await import('../background')
  background.default.main()
  expect(await loadSnapshot()).toMatchObject({ ready: true })
  expect(gql).toHaveBeenCalledTimes(4)

  const restarted = await restartWorker()
  await loadSnapshot()
  await restarted.readTasksSnapshot()
  await restarted.readPopupData()
  await restarted.readSidebarData()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(gql).toHaveBeenCalledTimes(4)
})

it('waits for login before loading the initial snapshot', async () => {
  await fakeBrowser.storage.local.remove('apiToken')
  const background = await import('../background')
  background.default.main()
  await loadSnapshot()
  expect(gql).not.toHaveBeenCalled()

  await fakeBrowser.storage.local.set({ apiToken: 'lhdao_pk_logged_in' })
  await loadSnapshot()
  expect(gql).toHaveBeenCalledTimes(4)
})

it('does not automatically retry a failed initial load after worker restart', async () => {
  vi.mocked(gql).mockRejectedValue(new Error('offline'))
  const background = await import('../background')
  background.default.main()
  expect(await loadSnapshot()).toMatchObject({ syncFailed: true })
  await restartWorker()
  await loadSnapshot()
  expect(gql).toHaveBeenCalledTimes(4)
})

it('ignores task sync requests from content scripts', async () => {
  const background = await import('../background')
  background.default.main()
  const response = await registered.handler?.(
    { type: 'force-sync' },
    {
      id: fakeBrowser.runtime.id,
      tab: { id: 1 } as chrome.tabs.Tab,
      url: 'https://x.com/user/status/123456',
    },
  )
  expect(response).toMatchObject({ type: 'sync-result', ok: false })
  expect(gql).not.toHaveBeenCalled()
})

it('shares the initial load between simultaneous X page requests', async () => {
  const background = await import('../background')
  background.default.main()
  const snapshots = await Promise.all([
    loadSnapshot(),
    loadSnapshot(),
    loadSnapshot(),
  ])
  expect(snapshots).toEqual([
    expect.objectContaining({ ready: true }),
    expect.objectContaining({ ready: true }),
    expect.objectContaining({ ready: true }),
  ])
  expect(gql).toHaveBeenCalledTimes(4)
})

it('returns the reserved comment task on the first X read without a manual sync', async () => {
  vi.mocked(gql).mockResolvedValue({
    availableEngagements: [],
    availableTweets: [],
    me: null,
    myReservedEngagements: [
      {
        id: 'reserved-comment',
        type: 'ENGAGEMENT',
        mode: 'OPEN',
        platform: 'X',
        targetUrl: 'https://x.com/user/status/123456',
        tweetId: '123456',
        keywords: [],
        myExpectedReward: 0.1,
        actions: [{ actionType: 'COMMENT', baseReward: 0.1, targetCount: 1 }],
      },
    ],
  })
  const background = await import('../background')
  background.default.main()
  expect(await loadSnapshot()).toMatchObject({
    ready: true,
    byTweet: {
      '123456': [
        expect.objectContaining({
          campaignId: 'reserved-comment',
          actionType: 'COMMENT',
          reserved: true,
        }),
      ],
    },
  })
  expect(gql).toHaveBeenCalledTimes(4)
})
