import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { sha256Hex } from '@/lib/canonical-json'
import * as messaging from '@/lib/messaging'
import type { AvailableEngagement } from '@/lib/queries'
import {
  MINT_ENGAGEMENT_TICKET_MUTATION,
  RESERVE_SLOT_MUTATION,
  RESERVE_TIMELINE_SLOT_MUTATION,
  SUBMIT_ENGAGEMENT_PROOF_MUTATION,
} from '@/lib/queries'
import type { CampaignTaskCache } from '@/lib/storage'
import type { MsgRequest, MsgResponse } from '@/types/messages'

/**
 * reserveOnly 分流:缓存里 timelineOnly 的任务走插件专用签名预约口
 * ReserveTimelineEngagementSlot(engagement.reserve.v1),普通任务维持旧
 * ReserveEngagementSlot。
 */

type Handler = (
  req: MsgRequest,
  sender: chrome.runtime.MessageSender,
) => Promise<MsgResponse>

let handler: Handler
let background: typeof import('../background')
let token: string | null = 'account-a'
const gqlMock = vi.fn()
const sessionData: Record<string, unknown> = {}

vi.mock('@/lib/messaging', () => ({
  onMessage: (h: Handler) => {
    handler = h
  },
  broadcastToContent: vi.fn(),
}))
vi.mock('@/lib/gql', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/gql')>()
  return { ...orig, gql: (...args: unknown[]) => gqlMock(...args) }
})
vi.mock('@/lib/env', () => ({
  API_ENDPOINT: 'https://api.test/graphql',
  WEB_ENDPOINT: 'https://web.test',
  SYNC_INTERVAL_SECONDS: 300,
  VERIFY_RETRY_DELAY_MS: 1000,
}))
vi.mock('@/lib/storage', () => ({
  localStore: {
    get: vi.fn(async () => token),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
  sessionStore: {
    get: vi.fn(async (key: string) => sessionData[key]),
    set: vi.fn(async (key: string, val: unknown) => {
      sessionData[key] = val
    }),
    patch: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(sessionData, values)
    }),
    clear: vi.fn(async () => {}),
  },
}))
vi.mock('@/lib/device-key', () => ({
  getOrCreateDevicePublicKeyJwk: vi.fn(async () => ({})),
}))
vi.mock('@/lib/watermark', () => ({
  getDeviceId: vi.fn(async () => 'dev-test'),
}))
vi.mock('@/lib/capture-debug', () => ({ CAPTURE_DEBUG: false, dbg: vi.fn() }))
vi.mock('@/lib/proof', () => ({
  buildProofCanonical: vi.fn(async () => 'canonical'),
  hmacSignProof: vi.fn(async () => 'signature'),
  randomProofNonce: vi.fn(() => 'nonce'),
}))

function task(partial: Partial<CampaignTaskCache>): CampaignTaskCache {
  return {
    campaignId: 'c1',
    tweetId: '123',
    actionType: 'LIKE',
    expectedReward: 1,
    ...partial,
  }
}

beforeAll(async () => {
  Object.assign(globalThis, {
    chrome: fakeBrowser,
    defineBackground: (fn: () => void) => fn,
  })
  const mod = await import('../background')
  background = mod
  // wxt 的 defineBackground 返回 { main };若被替成恒等则 default 即 main。
  const def = mod.default as unknown as { main?: () => void } | (() => void)
  const main = typeof def === 'function' ? def : def.main
  main?.()
})

beforeEach(() => {
  fakeBrowser.reset()
  gqlMock.mockReset()
  vi.mocked(messaging.broadcastToContent).mockClear()
  token = 'account-a'
  for (const k of Object.keys(sessionData)) delete sessionData[k]
})

async function cacheSources(
  available: AvailableEngagement[],
  reserved: AvailableEngagement[] = [],
) {
  sessionData.engagementSources = {
    owner: await sha256Hex(token!),
    available,
    reserved,
  }
}

const source = (id: string) => ({ id }) as AvailableEngagement

describe('reserveOnly mutation routing', () => {
  it('timelineOnly task reserves via ReserveTimelineEngagementSlot', async () => {
    sessionData.tasksByTweetId = {
      '123': [task({ campaignId: 'c-tl', timelineOnly: true })],
    }
    gqlMock.mockResolvedValue({
      reserveTimelineEngagementSlot: { reserved: true, cooldownSeconds: 0 },
    })

    const r = await handler(
      { type: 'reserve-task', campaignId: 'c-tl' } as MsgRequest,
      {} as chrome.runtime.MessageSender,
    )

    expect(gqlMock).toHaveBeenCalledTimes(1)
    expect(gqlMock.mock.calls[0][0]).toBe(RESERVE_TIMELINE_SLOT_MUTATION)
    expect(gqlMock.mock.calls[0][1]).toEqual({
      campaignId: 'c-tl',
      confirmCascade: null,
      confirmedCascadeTier: null,
    })
    expect(r).toMatchObject({ type: 'reserve-result', ok: true })
  })

  it('forwards the exact confirmed tier and returns a structured new offer', async () => {
    sessionData.tasksByTweetId = {
      '123': [task({ campaignId: 'c-tl', timelineOnly: true })],
    }
    const warning = {
      userTier: 'A',
      effectiveTier: 'C',
      userTierRewardLux: 20,
      effectiveTierRewardLux: 5,
    }
    gqlMock.mockResolvedValue({
      reserveTimelineEngagementSlot: {
        reserved: false,
        cascadeWarning: warning,
      },
    })
    const result = await handler(
      {
        type: 'reserve-task',
        campaignId: 'c-tl',
        confirmCascade: true,
        confirmedCascadeTier: 'B',
      },
      {} as chrome.runtime.MessageSender,
    )
    expect(gqlMock.mock.calls[0][1]).toEqual({
      campaignId: 'c-tl',
      confirmCascade: true,
      confirmedCascadeTier: 'B',
    })
    expect(result).toMatchObject({
      type: 'reserve-result',
      ok: false,
      cascadeWarning: warning,
    })
  })

  it('normal task reserves via legacy ReserveEngagementSlot', async () => {
    sessionData.tasksByTweetId = {
      '123': [task({ campaignId: 'c-normal' })],
    }
    gqlMock.mockResolvedValue({
      reserveEngagementSlot: { reserved: true, cooldownSeconds: 0 },
    })

    const r = await handler(
      { type: 'reserve-task', campaignId: 'c-normal' } as MsgRequest,
      {} as chrome.runtime.MessageSender,
    )

    expect(gqlMock).toHaveBeenCalledTimes(1)
    expect(gqlMock.mock.calls[0][0]).toBe(RESERVE_SLOT_MUTATION)
    expect(r).toMatchObject({ type: 'reserve-result', ok: true })
  })

  it('unknown campaignId (no cache hit) falls back to legacy mutation', async () => {
    sessionData.tasksByAuthorHandle = {
      someuser: [task({ campaignId: 'c-other' })],
    }
    gqlMock.mockResolvedValue({
      reserveEngagementSlot: { reserved: true, cooldownSeconds: 0 },
    })

    await handler(
      { type: 'reserve-task', campaignId: 'c-unknown' } as MsgRequest,
      {} as chrome.runtime.MessageSender,
    )

    expect(gqlMock.mock.calls[0][0]).toBe(RESERVE_SLOT_MUTATION)
  })

  it('reads timelineOnly flag from byAuthor cache too', async () => {
    sessionData.tasksByAuthorHandle = {
      someuser: [
        task({
          campaignId: 'c-follow',
          timelineOnly: true,
          tweetId: undefined,
        }),
      ],
    }
    gqlMock.mockResolvedValue({
      reserveTimelineEngagementSlot: { reserved: true, cooldownSeconds: 0 },
    })

    await handler(
      { type: 'reserve-task', campaignId: 'c-follow' } as MsgRequest,
      {} as chrome.runtime.MessageSender,
    )

    expect(gqlMock.mock.calls[0][0]).toBe(RESERVE_TIMELINE_SLOT_MUTATION)
  })

  it('keeps a successful claim reserved in both cached indexes after reopening', async () => {
    await cacheSources([source('c-tl'), source('c-other')])
    sessionData.tasksByTweetId = {
      '123': [
        task({ campaignId: 'c-tl', timelineOnly: true }),
        task({ campaignId: 'c-other' }),
      ],
    }
    sessionData.tasksByAuthorHandle = {
      user: [task({ campaignId: 'c-tl', actionType: 'FOLLOW' })],
    }
    gqlMock.mockResolvedValue({
      reserveTimelineEngagementSlot: { reserved: true, cooldownSeconds: 0 },
    })

    expect(
      await handler(
        { type: 'reserve-task', campaignId: 'c-tl' },
        {} as chrome.runtime.MessageSender,
      ),
    ).toMatchObject({ type: 'reserve-result', ok: true })
    const snapshot = await background.readTasksSnapshot()
    expect(
      snapshot.byTweet['123'].map((row) => [row.campaignId, row.reserved]),
    ).toEqual([
      ['c-tl', true],
      ['c-other', undefined],
    ])
    expect(snapshot.byAuthor.user[0].reserved).toBe(true)
    expect(sessionData.engagementSources).toMatchObject({
      available: [{ id: 'c-other' }],
      reserved: [{ id: 'c-tl' }],
    })
    expect(messaging.broadcastToContent).toHaveBeenCalledWith({
      type: 'tasks-updated',
    })
    expect(gqlMock).toHaveBeenCalledTimes(1)
  })

  it('does not alter the cache when a claim is rejected', async () => {
    await cacheSources([source('c-tl')])
    sessionData.tasksByTweetId = {
      '123': [task({ campaignId: 'c-tl', timelineOnly: true })],
    }
    gqlMock.mockResolvedValue({
      reserveTimelineEngagementSlot: { reserved: false },
    })

    const result = await handler(
      { type: 'reserve-task', campaignId: 'c-tl' },
      {} as chrome.runtime.MessageSender,
    )
    expect(result).toMatchObject({ type: 'reserve-result', ok: false })
    expect(
      (await background.readTasksSnapshot()).byTweet['123'][0].reserved,
    ).toBeUndefined()
    expect(sessionData.engagementSources).toMatchObject({
      available: [{ id: 'c-tl' }],
      reserved: [],
    })
    expect(messaging.broadcastToContent).not.toHaveBeenCalled()
  })

  it('does not write an old claim after switching A to B and back to A', async () => {
    await cacheSources([source('c-tl')])
    sessionData.tasksByTweetId = {
      '123': [task({ campaignId: 'c-tl', timelineOnly: true })],
    }
    let finish!: (result: unknown) => void
    gqlMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = handler(
      { type: 'reserve-task', campaignId: 'c-tl' },
      {} as chrome.runtime.MessageSender,
    )
    await vi.waitFor(() => expect(finish).toBeDefined())
    token = 'account-b'
    await background.handleTaskTokenChange()
    await cacheSources([source('b-task')])
    sessionData.tasksByTweetId = { '123': [task({ campaignId: 'b-task' })] }
    token = 'account-a'
    await background.handleTaskTokenChange()
    await cacheSources([source('new-a-task')])
    sessionData.tasksByTweetId = {
      '123': [task({ campaignId: 'new-a-task' })],
    }
    vi.mocked(messaging.broadcastToContent).mockClear()

    finish({ reserveTimelineEngagementSlot: { reserved: true } })
    await pending
    expect(
      (await background.readTasksSnapshot()).byTweet['123'][0].campaignId,
    ).toBe('new-a-task')
    expect(messaging.broadcastToContent).not.toHaveBeenCalled()
  })
})

describe('verified task cache', () => {
  beforeEach(async () => {
    await cacheSources(
      [source('c-verified'), source('c-other')],
      [source('c-verified')],
    )
    sessionData.tasksByTweetId = {
      '123': [
        task({ campaignId: 'c-verified', reserved: true }),
        task({ campaignId: 'c-other' }),
      ],
    }
    sessionData.tasksByAuthorHandle = {
      user: [
        task({
          campaignId: 'c-verified',
          actionType: 'FOLLOW',
          reserved: true,
        }),
      ],
    }
    sessionData.activeCampaigns = [
      { campaignId: 'c-verified' },
      { campaignId: 'c-other' },
    ]
    sessionData.capturedActions = {
      'c-verified': [
        {
          actionType: 'LIKE',
          tweetId: '123',
          capturedAt: '2026-09-26T00:00:00Z',
        },
      ],
    }
  })

  it('removes only the accepted task and broadcasts a local cache update', async () => {
    gqlMock.mockImplementation(async (query) => {
      if (query === MINT_ENGAGEMENT_TICKET_MUTATION)
        return { mintEngagementTicket: { ticket: 'ticket', macKey: 'key' } }
      if (query === SUBMIT_ENGAGEMENT_PROOF_MUTATION)
        return { submitEngagementProof: { accepted: true } }
      throw new Error('unexpected full sync')
    })

    expect(
      await handler(
        { type: 'verify-task', campaignId: 'c-verified' },
        {} as chrome.runtime.MessageSender,
      ),
    ).toMatchObject({ type: 'verify-result', ok: true })
    const snapshot = await background.readTasksSnapshot()
    expect(snapshot.byTweet['123'].map((row) => row.campaignId)).toEqual([
      'c-other',
    ])
    expect(snapshot.byAuthor.user).toBeUndefined()
    expect(sessionData.engagementSources).toMatchObject({
      available: [{ id: 'c-other' }],
      reserved: [],
    })
    expect(sessionData.activeCampaigns).toEqual([{ campaignId: 'c-other' }])
    expect(messaging.broadcastToContent).toHaveBeenCalledWith({
      type: 'tasks-updated',
    })
    expect(gqlMock).toHaveBeenCalledTimes(2)
  })

  it('retains the task when proof submission is rejected', async () => {
    gqlMock.mockImplementation(async (query) => {
      if (query === MINT_ENGAGEMENT_TICKET_MUTATION)
        return { mintEngagementTicket: { ticket: 'ticket', macKey: 'key' } }
      if (query === SUBMIT_ENGAGEMENT_PROOF_MUTATION)
        return {
          submitEngagementProof: { accepted: false, reason: 'REJECTED' },
        }
      throw new Error('unexpected full sync')
    })

    expect(
      await handler(
        { type: 'verify-task', campaignId: 'c-verified' },
        {} as chrome.runtime.MessageSender,
      ),
    ).toMatchObject({ type: 'verify-result', ok: false })
    expect(
      (await background.readTasksSnapshot()).byTweet['123'][0].campaignId,
    ).toBe('c-verified')
    expect(messaging.broadcastToContent).not.toHaveBeenCalled()
  })
})
