import { describe, expect, it } from 'vitest'
import type { AvailableEngagement } from '@/lib/queries'
import { buildActiveCampaignSummaries, flattenTasks } from '../background'

const binanceCampaign = {
  id: 'binance-like',
  type: 'ENGAGEMENT',
  platform: 'BINANCE_SQUARE',
  targetUrl: 'https://www.binance.com/en/square/post/1',
  targetContentId: '1',
  targetAuthorId: 'author-1',
  tweetId: 'legacy-tweet-id',
  targetUsername: 'legacy-user',
  actions: [{ actionType: 'LIKE', baseReward: 1, targetCount: 1 }],
} as unknown as AvailableEngagement

describe('X task indexes', () => {
  it('rejects Binance campaigns carrying legacy X targets', () => {
    expect(buildActiveCampaignSummaries([binanceCampaign])).toEqual([])
    expect(flattenTasks([binanceCampaign], new Set())).toEqual({
      byTweet: {},
      byAuthor: {},
    })
  })
})
