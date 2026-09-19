import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import {
  RESERVE_SLOT_MUTATION,
  RESERVE_TIMELINE_SLOT_MUTATION,
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
    get: vi.fn(async () => null),
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
  // wxt 的 defineBackground 返回 { main };若被替成恒等则 default 即 main。
  const def = mod.default as unknown as { main?: () => void } | (() => void)
  const main = typeof def === 'function' ? def : def.main
  main?.()
})

beforeEach(() => {
  fakeBrowser.reset()
  gqlMock.mockReset()
  for (const k of Object.keys(sessionData)) delete sessionData[k]
})

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
        task({ campaignId: 'c-follow', timelineOnly: true, tweetId: undefined }),
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
})
