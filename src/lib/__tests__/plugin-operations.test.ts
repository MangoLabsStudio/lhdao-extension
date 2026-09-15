import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../canonical-json'
import {
  getPluginOperationByDocument,
  PLUGIN_OPERATIONS,
} from '../plugin-operations'
import * as queries from '../queries'
import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  AVAILABLE_TWEETS_QUERY,
  CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY,
  ME_QUERY,
  MY_RESERVED_ENGAGEMENTS_QUERY,
  PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
  PROMOTE_TWEET_MUTATION,
} from '../queries'

describe('PLUGIN_OPERATIONS', () => {
  it('allowlists only current prices, v2 preview, and quoted spend', async () => {
    expect('PREVIEW_PROMOTE_TWEET_PRICING_V1_QUERY' in queries).toBe(false)
    await expect(
      sha256Hex(CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY),
    ).resolves.toBe(
      'a6db29afa57f31cacc46403504c8c43f0ac10ac5fabfce5fe89f6ee269d1b312',
    )
    await expect(sha256Hex(PREVIEW_PROMOTE_TWEET_PRICING_QUERY)).resolves.toBe(
      'd71bdd5a31703929fc61a7408b167668f558c16840c340ce8073248b8190e934',
    )
    expect(
      getPluginOperationByDocument(
        CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY,
        'CurrentEngagementMarketPrices',
      ),
    ).toMatchObject({
      id: 'read.engagement-current-prices.v1',
      permission: 'read',
    })
    expect(
      getPluginOperationByDocument(
        PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
        'PreviewPromoteTweetPricing',
      ),
    ).toMatchObject({ id: 'read.promote-pricing.v2', permission: 'read' })
    expect(PLUGIN_OPERATIONS.map((operation) => operation.id)).not.toContain(
      'read.promote-pricing.v1',
    )
    expect(
      getPluginOperationByDocument(PROMOTE_TWEET_MUTATION, 'PromoteTweet'),
    ).toMatchObject({ id: 'spend.promote.v1', permission: 'spend' })
  })

  it('contains current prices, v2 preview, and quoted spend', () => {
    expect(
      PLUGIN_OPERATIONS.map((operation) => operation.operationName),
    ).toEqual([
      'CreateExtensionPairing',
      'PollExtensionPairing',
      'Me',
      'AvailableEngagements',
      'MyReservedEngagements',
      'AvailableTweets',
      'LighthouseMembers',
      'RecordTweetDwell',
      'ReportEngagementCapture',
      'MintEngagementTicket',
      'SubmitEngagementProof',
      'CurrentEngagementMarketPrices',
      'PreviewPromoteTweetPricing',
      'PromoteTweet',
      'CreateAutoReinvestTask',
    ])
    expect(
      getPluginOperationByDocument(PROMOTE_TWEET_MUTATION, 'PromoteTweet'),
    ).toMatchObject({ id: 'spend.promote.v1', permission: 'spend' })
  })

  it('keeps every checked-in document hash in sync', async () => {
    for (const operation of PLUGIN_OPERATIONS) {
      await expect(sha256Hex(operation.document)).resolves.toBe(
        operation.documentSha256,
      )
      expect(
        getPluginOperationByDocument(
          operation.document,
          operation.operationName,
        )?.id,
      ).toBe(operation.id)
    }
  })

  it('versions the selected-aware read documents', () => {
    expect(PLUGIN_OPERATIONS.map((operation) => operation.id)).not.toContain(
      'engagement.available.v1',
    )
    expect(PLUGIN_OPERATIONS.map((operation) => operation.id)).not.toContain(
      'engagement.reserved.v1',
    )
    expect(
      getPluginOperationByDocument(
        AVAILABLE_ENGAGEMENTS_QUERY,
        'AvailableEngagements',
      )?.id,
    ).toBe('engagement.available.v4')
    expect(
      getPluginOperationByDocument(
        MY_RESERVED_ENGAGEMENTS_QUERY,
        'MyReservedEngagements',
      )?.id,
    ).toBe('engagement.reserved.v4')
    expect(getPluginOperationByDocument(ME_QUERY, 'Me')?.id).toBe('user.me.v2')
    expect(
      getPluginOperationByDocument(AVAILABLE_TWEETS_QUERY, 'AvailableTweets')
        ?.id,
    ).toBe('tweet.available.v2')
  })

  it('does not match a document with an added field or alias', () => {
    expect(
      getPluginOperationByDocument(
        'query Me { viewer: me { id username } }',
        'Me',
      ),
    ).toBeUndefined()
  })
})
