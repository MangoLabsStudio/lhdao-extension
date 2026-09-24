import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  type AvailableEngagement,
  ME_QUERY,
  MY_RESERVED_ENGAGEMENTS_QUERY,
} from '@/lib/queries'
import {
  buildActiveCampaignSummaries,
  flattenTasks,
  reserveErrorCode,
} from '../background'

const binanceLikeCampaign = {
  id: 'binance-like',
  type: 'ENGAGEMENT',
  platform: 'BINANCE_SQUARE',
  targetUrl: 'https://x.com/legacy/status/123456',
  targetContentId: '1',
  targetAuthorId: 'author-1',
  tweetId: 'legacy-tweet-id',
  targetUsername: null,
  actions: [{ actionType: 'LIKE', baseReward: 1, targetCount: 1 }],
} as unknown as AvailableEngagement

const binanceFollowCampaign = {
  id: 'binance-follow',
  type: 'ENGAGEMENT',
  platform: 'BINANCE_SQUARE',
  targetUrl: null,
  targetContentId: null,
  targetAuthorId: 'author-2',
  tweetId: null,
  targetUsername: 'legacy-user',
  actions: [{ actionType: 'FOLLOW', baseReward: 1, targetCount: 1 }],
} as unknown as AvailableEngagement

describe('X task indexes', () => {
  it('maps server-selected claim denial to a stable user-facing error', () => {
    expect(reserveErrorCode('LIGHTHOUSE_SELECTED_REQUIRED')).toEqual({
      code: 'LIGHTHOUSE_SELECTED_REQUIRED',
      message: '需灯塔严选资格',
    })
  })
  it('rejects Binance campaigns carrying stale X tweet targets', () => {
    expect(buildActiveCampaignSummaries([binanceLikeCampaign])).toEqual([])
    expect(flattenTasks([binanceLikeCampaign], new Set())).toEqual({
      byTweet: {},
      byAuthor: {},
    })
  })

  it('rejects Binance campaigns carrying stale X follow targets', () => {
    expect(flattenTasks([binanceFollowCampaign], new Set())).toEqual({
      byTweet: {},
      byAuthor: {},
    })
  })
})

describe('comment guidance propagation', () => {
  const campaign = (
    id: string,
    commentGuide: string | null,
  ): AvailableEngagement => ({
    ...binanceLikeCampaign,
    id,
    platform: 'X',
    tweetId: '123456',
    commentGuide,
    keywords: ['not a guide'],
    actions: [{ actionType: 'COMMENT_LIKE', baseReward: 1, targetCount: 1 }],
  })

  it('requests commentGuide for both available and reserved orders', () => {
    expect(AVAILABLE_ENGAGEMENTS_QUERY).toContain('commentGuide')
    expect(MY_RESERVED_ENGAGEMENTS_QUERY).toContain('commentGuide')
  })

  it('requests current qualification, selected scope and viewer claim snapshot', () => {
    expect(ME_QUERY).toContain('lighthouseSelected')
    expect(AVAILABLE_ENGAGEMENTS_QUERY).toContain('lighthouseSelectedOnly')
    expect(AVAILABLE_ENGAGEMENTS_QUERY).toContain('myLighthouseSelectedAtClaim')
    expect(MY_RESERVED_ENGAGEMENTS_QUERY).toContain('lighthouseSelectedOnly')
    expect(MY_RESERVED_ENGAGEMENTS_QUERY).toContain(
      'myLighthouseSelectedAtClaim',
    )
  })

  it('preserves selected scope and nullable claim snapshots in task caches', () => {
    const selected = {
      ...campaign('selected', null),
      lighthouseSelectedOnly: true,
      myLighthouseSelectedAtClaim: true,
    } as AvailableEngagement
    const legacy = campaign('legacy', null)
    const rows = flattenTasks(
      [selected, legacy],
      new Set(['selected', 'legacy']),
    ).byTweet['123456']
    expect(rows.find((row) => row.campaignId === 'selected')).toMatchObject({
      lighthouseSelectedOnly: true,
      lighthouseSelectedAtClaim: true,
    })
    const legacyRow = rows.find((row) => row.campaignId === 'legacy')
    expect(legacyRow).not.toHaveProperty('lighthouseSelectedOnly')
    expect(legacyRow).not.toHaveProperty('lighthouseSelectedAtClaim')
  })

  it('preserves full guides by campaign across task indexes and summaries', () => {
    const longGuide = `${'旧订单完整内容不截断'.repeat(8)}\n第二行`
    const orders = [campaign('a', longGuide), campaign('b', '另一个方向')]
    const tasks = flattenTasks(orders, new Set(['a'])).byTweet['123456']
    expect(
      tasks.map((t) => [
        t.campaignId,
        t.commentGuide,
        t.commentGuideStatus,
        t.reserved,
      ]),
    ).toEqual([
      ['a', longGuide, 'ready', true],
      ['b', '另一个方向', 'ready', false],
    ])
    expect(
      buildActiveCampaignSummaries(orders).map((t) => [
        t.campaignId,
        t.commentGuide,
      ]),
    ).toEqual([
      ['a', longGuide],
      ['b', '另一个方向'],
    ])
  })

  it('separates an absent field from a known null and never uses keywords', () => {
    const unknown = campaign('unknown', null)
    delete unknown.commentGuide
    const orders = [campaign('empty', null), unknown]
    expect(
      flattenTasks(orders).byTweet['123456'].map((t) => [
        t.commentGuide,
        t.commentGuideStatus,
      ]),
    ).toEqual([
      [null, 'ready'],
      [undefined, 'unavailable'],
    ])
  })
})
