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
  it('allowlists current prices, combined quote preview, and quoted spend', async () => {
    expect('PREVIEW_PROMOTE_TWEET_PRICING_V1_QUERY' in queries).toBe(false)
    await expect(
      sha256Hex(CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY),
    ).resolves.toBe(
      'a6db29afa57f31cacc46403504c8c43f0ac10ac5fabfce5fe89f6ee269d1b312',
    )
    await expect(sha256Hex(PREVIEW_PROMOTE_TWEET_PRICING_QUERY)).resolves.toBe(
      '427dfd9325327ac2299660166085fa0aa7bc9436eba4c52c75294a620a755760',
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
    ).toMatchObject({ id: 'read.promote-pricing.v3', permission: 'read' })
    expect(PLUGIN_OPERATIONS.map((operation) => operation.id)).not.toContain(
      'read.promote-pricing.v1',
    )
    expect(
      getPluginOperationByDocument(PROMOTE_TWEET_MUTATION, 'PromoteTweet'),
    ).toMatchObject({ id: 'spend.promote.v1', permission: 'spend' })
  })

  it('contains current prices, v3 preview, and quoted spend', () => {
    expect(
      PLUGIN_OPERATIONS.map((operation) => operation.operationName),
    ).toEqual([
      'MyXAnalytics',
      'SaveXAnalytics',
      'CreateExtensionPairing',
      'PollExtensionPairing',
      'Me',
      'AvailableEngagements',
      'MyReservedEngagements',
      'AvailableTweets',
      'ManualAvailableEngagements',
      'ManualMyReservedEngagements',
      'ManualAvailableTweets',
      'LighthouseMembers',
      'RecordTweetDwell',
      'ReportEngagementCapture',
      'MintEngagementTicket',
      'SubmitEngagementProof',
      'ReserveTimelineEngagementSlot',
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
    ).toBe('engagement.available.v5')
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

  it('pins distinct manual task reads while retaining legacy documents', async () => {
    const manualReads = [
      [
        'engagement.available.manual.v1',
        'ManualAvailableEngagements',
        AVAILABLE_ENGAGEMENTS_QUERY,
        'AvailableEngagements',
        'a2d47a5b59defb7f5751ac60a89e89fa3ee9a67c36f12108d377ff4591038540',
      ],
      [
        'engagement.reserved.manual.v1',
        'ManualMyReservedEngagements',
        MY_RESERVED_ENGAGEMENTS_QUERY,
        'MyReservedEngagements',
        '07ea97de1d7d38fb3fa3233ed5121359ecbd5a63d8142146d18167a1cdf33f37',
      ],
      [
        'tweet.available.manual.v1',
        'ManualAvailableTweets',
        AVAILABLE_TWEETS_QUERY,
        'AvailableTweets',
        '33ef37f38699000c40a4279b4485f1f5c4fa756f79720b363ba291476e877f09',
      ],
    ] as const
    for (const [id, name, legacyDocument, legacyName, sha256] of manualReads) {
      const document = legacyDocument.replace(
        `query ${legacyName} {`,
        `query ${name} {`,
      )
      expect(
        PLUGIN_OPERATIONS.find((operation) => operation.id === id),
      ).toMatchObject({
        operationName: name,
        permission: 'read',
        document,
        documentSha256: sha256,
      })
      expect(getPluginOperationByDocument(document, name)?.id).toBe(id)
      await expect(sha256Hex(document)).resolves.toBe(sha256)
    }
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

describe('X analytics signed capture boundary', () => {
  it.each([
    [
      'query MyXAnalytics { myXAnalytics }',
      'MyXAnalytics',
      'x-analytics.me.v1',
      'read',
    ],
    [
      'mutation SaveXAnalytics($input: XAnalyticsInput!) { saveXAnalytics(input: $input) }',
      'SaveXAnalytics',
      'x-analytics.save.v1',
      'capture',
    ],
  ])('registers %s with the backend contract', async (document, name, id, permission) => {
    const operation = getPluginOperationByDocument(document, name)
    expect(operation).toMatchObject({ id, permission })
    expect(operation?.documentSha256).toBe(await sha256Hex(document))
  })
})
