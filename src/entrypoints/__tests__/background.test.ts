import { describe, expect, it } from 'vitest'
import type { AvailableEngagement } from '@/lib/queries'
import { buildActiveCampaignSummaries, flattenTasks } from '../background'

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
