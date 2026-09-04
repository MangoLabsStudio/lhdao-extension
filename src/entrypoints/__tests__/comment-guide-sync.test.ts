import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { SYNC_INTERVAL_SECONDS } from '@/lib/env'
import * as gqlApi from '@/lib/gql'
import * as messaging from '@/lib/messaging'
import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  AVAILABLE_TWEETS_QUERY,
  type AvailableEngagement,
  ME_QUERY,
  MY_RESERVED_ENGAGEMENTS_QUERY,
} from '@/lib/queries'
import { localStore, sessionStore } from '@/lib/storage'
import {
  handleTaskTokenChange,
  readPopupData,
  readSidebarData,
  readTasksSnapshot,
  syncTasks,
} from '../background'

const order = (
  id: string,
  commentGuide: string | null = '原文',
): AvailableEngagement => ({
  id,
  type: 'ENGAGEMENT',
  mode: 'OPEN',
  platform: 'X',
  targetUrl: 'https://x.com/user/status/123456',
  tweetId: '123456',
  targetContentId: null,
  targetAuthorId: null,
  tweetText: null,
  tweetAuthorName: null,
  tweetAuthorHandle: null,
  tweetAuthorAvatar: null,
  targetUsername: null,
  keywords: [],
  commentGuide,
  expectedReward: 1,
  myExpectedReward: 1,
  effectiveTier: null,
  myEffectiveTier: null,
  actions: [{ actionType: 'COMMENT', baseReward: 1, targetCount: 1 }],
})

let available: AvailableEngagement[] | Error
let reserved: AvailableEngagement[] | Error
let me: Record<string, unknown> | null | Error
beforeEach(async () => {
  fakeBrowser.reset()
  available = [order('available')]
  reserved = [order('reserved')]
  me = null
  vi.spyOn(messaging, 'broadcastToContent').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(gqlApi, 'gql').mockImplementation(async (query) => {
    if (query === AVAILABLE_ENGAGEMENTS_QUERY) {
      if (available instanceof Error) throw available
      return { availableEngagements: available }
    }
    if (query === MY_RESERVED_ENGAGEMENTS_QUERY) {
      if (reserved instanceof Error) throw reserved
      return { myReservedEngagements: reserved }
    }
    if (query === AVAILABLE_TWEETS_QUERY) return { availableTweets: [] }
    if (query === ME_QUERY) {
      if (me instanceof Error) throw me
      return { me }
    }
    throw new Error('unexpected query')
  })
  await localStore.set('apiToken', 'account-a')
})
afterEach(() => vi.restoreAllMocks())
const tasks = async () =>
  (await sessionStore.get('tasksByTweetId'))?.['123456'] ?? []

describe('comment guide sync', () => {
  it('rechecks Lighthouse Selected qualification every 60 seconds', () => {
    expect(SYNC_INTERVAL_SECONDS).toBe(60)
  })

  it('uses only a successful current-generation me result for qualification', async () => {
    me = {
      id: 'user-a',
      username: 'a',
      nickname: null,
      avatar: null,
      tier: 'A',
      newLux: '2',
      todayEarnings: 1,
      twitterUsername: 'a',
      lighthouseSelected: true,
    }
    await syncTasks()
    expect(await sessionStore.get('userProfile')).toMatchObject({
      id: 'user-a',
      lighthouseSelected: true,
    })

    me = new Error('me offline')
    await syncTasks()
    const profile = await sessionStore.get('userProfile')
    expect(profile).toMatchObject({ id: 'user-a' })
    expect(profile).not.toHaveProperty('lighthouseSelected')
    expect(await sessionStore.get('lighthouseSelectedStatus')).toBe(
      'unavailable',
    )
    expect(await readSidebarData()).toMatchObject({
      profile: { id: 'user-a' },
      lighthouseSelectedStatus: 'unavailable',
    })
    expect((await tasks()).map((task) => task.campaignId)).toEqual([
      'available',
      'reserved',
    ])
  })

  it('keeps an omitted legacy me field unavailable instead of coercing false', async () => {
    me = {
      id: 'legacy-user',
      username: 'legacy',
      nickname: null,
      avatar: null,
      tier: null,
      newLux: null,
      todayEarnings: null,
      twitterUsername: null,
    }
    await syncTasks()
    expect(await sessionStore.get('userProfile')).not.toHaveProperty(
      'lighthouseSelected',
    )
    expect(await sessionStore.get('lighthouseSelectedStatus')).toBe(
      'unavailable',
    )
  })

  it('keeps a reserved selected task after current qualification is removed', async () => {
    reserved = [
      {
        ...order('selected-reserved'),
        lighthouseSelectedOnly: true,
        myLighthouseSelectedAtClaim: true,
      } as AvailableEngagement,
    ]
    me = {
      id: 'user-a',
      username: 'a',
      nickname: null,
      avatar: null,
      tier: 'A',
      newLux: 0,
      todayEarnings: 0,
      twitterUsername: 'a',
      lighthouseSelected: false,
    }
    await syncTasks()
    expect(await tasks()).toContainEqual(
      expect.objectContaining({
        campaignId: 'selected-reserved',
        reserved: true,
        lighthouseSelectedAtClaim: true,
      }),
    )
    expect(await readSidebarData()).toMatchObject({
      lighthouseSelectedStatus: 'available',
      profile: { lighthouseSelected: false },
    })
  })
  it('retains reserved guides with update failure while refreshing available orders', async () => {
    await syncTasks()
    available = [order('available', '新版')]
    reserved = new Error('reserved offline')
    await syncTasks()
    expect(
      (await tasks()).map((t) => [
        t.campaignId,
        t.commentGuide,
        t.commentGuideStatus,
      ]),
    ).toEqual([
      ['available', '新版', 'ready'],
      ['reserved', '原文', 'stale'],
    ])
    expect(await sessionStore.get('lastSyncError')).toContain(
      'reserved offline',
    )
    reserved = [order('reserved', null)]
    await syncTasks()
    expect(
      (await tasks()).find((t) => t.campaignId === 'reserved'),
    ).toMatchObject({ commentGuide: null, commentGuideStatus: 'ready' })
  })

  it('refreshes reserved orders when the available query fails', async () => {
    await syncTasks()
    available = new Error('available offline')
    reserved = [order('reserved', '已修改')]
    await syncTasks()
    expect(
      (await tasks()).map((t) => [
        t.campaignId,
        t.commentGuide,
        t.commentGuideStatus,
      ]),
    ).toEqual([
      ['available', '原文', 'stale'],
      ['reserved', '已修改', 'ready'],
    ])
    expect(messaging.broadcastToContent).toHaveBeenLastCalledWith({
      type: 'tasks-updated',
    })
  })

  it('preserves an order guide when it moves from available to reserved', async () => {
    available = [order('moving', '接单前方向')]
    reserved = []
    await syncTasks()
    available = []
    reserved = [order('moving', '接单后方向')]
    await syncTasks()
    expect(await tasks()).toEqual([
      expect.objectContaining({
        campaignId: 'moving',
        reserved: true,
        commentGuide: '接单后方向',
      }),
    ])
  })

  it('reports an uncached query failure as unavailable, not as no guide', async () => {
    available = new Error('offline')
    reserved = new Error('offline')
    await syncTasks()
    expect(await readTasksSnapshot()).toMatchObject({
      byTweet: {},
      ready: false,
      syncFailed: true,
    })
  })

  it('retains guides across source transitions until both queries confirm disappearance', async () => {
    available = [order('moving', '接单前原文')]
    reserved = []
    await syncTasks()
    available = []
    reserved = new Error('reserved temporarily offline')
    await syncTasks()
    expect(await tasks()).toEqual([
      expect.objectContaining({
        campaignId: 'moving',
        commentGuide: '接单前原文',
        commentGuideStatus: 'stale',
      }),
    ])
    await syncTasks()
    expect(await tasks()).toHaveLength(1)
    reserved = []
    await syncTasks()
    expect(await tasks()).toEqual([])
  })

  it('does not serve old guides before the account-change reset finishes', async () => {
    await syncTasks()
    await localStore.set('apiToken', 'account-b')
    expect((await readTasksSnapshot()).byTweet).toEqual({})
  })

  it('waits for a deferred account reset and never serves the old sidebar or popup identity', async () => {
    me = {
      id: 'user-a',
      username: 'old-name',
      nickname: null,
      avatar: null,
      tier: 'A',
      newLux: 99,
      todayEarnings: 1,
      twitterUsername: 'old-handle',
      lighthouseSelected: true,
    }
    await syncTasks()
    await localStore.set('apiToken', 'account-b')

    let releaseReset!: () => void
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve
    })
    const patch = sessionStore.patch.bind(sessionStore)
    vi.spyOn(sessionStore, 'patch').mockImplementationOnce(async (values) => {
      await resetGate
      await patch(values)
    })

    me = {
      id: 'user-b',
      username: 'new-name',
      nickname: null,
      avatar: null,
      tier: 'B',
      newLux: 2,
      todayEarnings: 0,
      twitterUsername: 'new-handle',
      lighthouseSelected: false,
    }
    const reset = handleTaskTokenChange()
    const sidebarPromise = readSidebarData()
    const popupPromise = readPopupData()
    let sidebarSettled = false
    void sidebarPromise.then(() => {
      sidebarSettled = true
    })
    await Promise.resolve()
    expect(sidebarSettled).toBe(false)

    releaseReset()
    const [sidebar, popup] = await Promise.all([
      sidebarPromise,
      popupPromise,
      reset,
    ])
    expect(sidebar.profile?.id).not.toBe('user-a')
    expect(sidebar.profile?.displayName).not.toBe('old-name')
    expect(sidebar.profile?.newLux).not.toBe(99)
    expect(sidebar.profile?.lighthouseSelected).not.toBe(true)
    expect(popup.profile?.id).not.toBe('user-a')
    expect(popup.profile?.displayName).not.toBe('old-name')
    expect(popup.profile?.newLux).not.toBe(99)
    expect(popup.profile?.lighthouseSelected).not.toBe(true)
  })

  it('returns an empty current-owner snapshot while the replacement account sync is deferred', async () => {
    me = {
      id: 'user-a',
      username: 'old-name',
      nickname: null,
      avatar: null,
      tier: 'A',
      newLux: 99,
      todayEarnings: 1,
      twitterUsername: 'old-handle',
      lighthouseSelected: true,
    }
    await syncTasks()

    let resolveNewMe!: (value: unknown) => void
    await localStore.set('apiToken', 'account-b')
    vi.mocked(gqlApi.gql).mockImplementation(async (query) => {
      if (query === AVAILABLE_ENGAGEMENTS_QUERY)
        return { availableEngagements: [] }
      if (query === MY_RESERVED_ENGAGEMENTS_QUERY)
        return { myReservedEngagements: [] }
      if (query === AVAILABLE_TWEETS_QUERY) return { availableTweets: [] }
      if (query === ME_QUERY) {
        return new Promise((resolve) => {
          resolveNewMe = resolve
        })
      }
      throw new Error('unexpected query')
    })
    const replacing = handleTaskTokenChange()
    await vi.waitFor(() => expect(resolveNewMe).toBeDefined())

    const sidebar = await readSidebarData()
    const popup = await readPopupData()
    expect(sidebar).toMatchObject({
      tokenConfigured: true,
      profile: null,
      lighthouseSelectedStatus: 'loading',
    })
    expect(popup).toMatchObject({ hasToken: true, profile: null })

    resolveNewMe({
      me: {
        id: 'user-b',
        username: 'new-name',
        nickname: null,
        avatar: null,
        tier: 'B',
        newLux: 2,
        todayEarnings: 0,
        twitterUsername: 'new-handle',
        lighthouseSelected: false,
      },
    })
    await replacing
  })

  it('never serves an old identity after logout', async () => {
    me = {
      id: 'user-a',
      username: 'old-name',
      nickname: null,
      avatar: null,
      tier: 'A',
      newLux: 99,
      todayEarnings: 1,
      twitterUsername: 'old-handle',
      lighthouseSelected: true,
    }
    await syncTasks()
    await localStore.remove('apiToken')
    await handleTaskTokenChange()

    expect(await readSidebarData()).toMatchObject({
      tokenConfigured: false,
      profile: null,
    })
    expect(await readPopupData()).toMatchObject({
      hasToken: false,
      profile: null,
    })
  })

  it('clears old-account cache even if new-account queries fail', async () => {
    await syncTasks()
    await localStore.set('apiToken', 'account-b')
    available = new Error('offline')
    reserved = new Error('offline')
    await syncTasks()
    expect(await tasks()).toEqual([])
  })

  it('does not reuse old-account in-flight requests or allow late responses to overwrite', async () => {
    let resolveOld!: (v: unknown) => void
    vi.mocked(gqlApi.gql).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    const oldSync = syncTasks()
    await vi.waitFor(() => expect(resolveOld).toBeDefined())
    await localStore.set('apiToken', 'account-b')
    available = [order('new-account', 'B 的内容')]
    reserved = []
    const newSync = syncTasks()
    // Resolve the old request after starting B; its result must not enter B's cache.
    resolveOld({ availableEngagements: [order('old-account', 'A 的内容')] })
    await Promise.all([oldSync, newSync])
    expect((await tasks()).map((t) => t.campaignId)).toEqual(['new-account'])
  })

  it('rejects an old response after switching A to B and back to A', async () => {
    let resolveOld!: (v: unknown) => void
    vi.mocked(gqlApi.gql).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    const pending = syncTasks()
    await vi.waitFor(() => expect(resolveOld).toBeDefined())
    await localStore.set('apiToken', 'account-b')
    const switched = handleTaskTokenChange()
    await localStore.set('apiToken', 'account-a')
    available = [order('new-session', '新会话')]
    reserved = []
    await handleTaskTokenChange()
    resolveOld({ availableEngagements: [order('old-session', '旧会话')] })
    await Promise.all([pending, switched])
    expect((await tasks()).map((t) => t.campaignId)).toEqual(['new-session'])
  })

  it('logout clears guides while an old request is pending', async () => {
    await syncTasks()
    let resolveOld!: (v: unknown) => void
    vi.mocked(gqlApi.gql).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    const pending = syncTasks()
    await vi.waitFor(() => expect(resolveOld).toBeDefined())
    await localStore.remove('apiToken')
    const logout = syncTasks()
    resolveOld({ availableEngagements: [order('old-account')] })
    await Promise.all([pending, logout])
    expect(await tasks()).toEqual([])
    expect(await sessionStore.get('activeCampaigns')).toEqual([])
  })
})
