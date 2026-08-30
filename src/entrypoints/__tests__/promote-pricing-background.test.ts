import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'

const gqlMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/gql', () => {
  class GqlError extends Error {
    constructor(
      message: string,
      public readonly graphqlErrors?: {
        message: string
        extensions?: { code?: string }
      }[],
      public readonly httpStatus?: number,
      public readonly kind = 'PROTOCOL',
      public readonly uncertain = false,
    ) {
      super(message)
    }
  }
  return { gql: gqlMock, GqlError }
})

import { GqlError } from '@/lib/gql'
import {
  CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY,
  PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
  PROMOTE_TWEET_MUTATION,
} from '@/lib/queries'
import { localStore } from '@/lib/storage'
import {
  currentEngagementMarketPricesHandler,
  previewPromoteTweetPricingHandler,
  promoteTweetHandler,
} from '../background'

const actions = [{ actionType: 'LIKE', tierSlots: { A: 5 } }]
const quote = {
  quoteId: 'quote-plugin-1',
  priceVersion: 'version-1',
  currency: 'LUX' as const,
  precision: 8,
  quotedAt: '2099-01-01T10:00:00.000Z',
  expiresAt: '2099-01-02T00:00:00.000Z',
  principal: '2.00000000',
  feeRate: '0.10000000',
  promotionFee: '0.20000000',
  totalCost: '2.20000000',
  lines: [
    {
      campaignIndex: 0,
      actionType: 'LIKE',
      tier: 'A',
      quantity: 5,
      pricingSource: 'PILOT',
      unitPrice: '0.40000000',
      principal: '2.00000000',
    },
  ],
}

const currentPrices = {
  asOf: '2026-08-30T06:32:00.000Z',
  currency: 'LUX' as const,
  precision: 8,
  lines: [
    {
      actionType: 'LIKE',
      tier: 'A',
      pricingSource: 'PILOT',
      unitPrice: '0.39000000',
    },
    {
      actionType: 'RT',
      tier: 'B',
      pricingSource: 'PILOT',
      unitPrice: '14.62500000',
    },
  ],
}

describe('plugin promote pricing background handlers', () => {
  beforeEach(() => {
    fakeBrowser.reset()
    gqlMock.mockReset()
  })

  it('uses the signed current-price operation with a closed action input', async () => {
    await localStore.set('apiToken', 'lhdao_pk_test')
    gqlMock.mockResolvedValue({ currentEngagementMarketPrices: currentPrices })
    await expect(
      currentEngagementMarketPricesHandler({
        actions: ['LIKE', 'RT', 'COMMENT'],
      }),
    ).resolves.toEqual({
      type: 'current-engagement-prices-result',
      ok: true,
      prices: currentPrices,
    })
    expect(gqlMock).toHaveBeenCalledWith(
      CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY,
      { input: { actions: ['LIKE', 'RT', 'COMMENT'] } },
    )
  })

  it.each([
    ['extra root field', { ...currentPrices, tomorrow: [] }],
    ['empty lines', { ...currentPrices, lines: [] }],
    ['loose date', { ...currentPrices, asOf: '2026-08-30' }],
    [
      'non-fixed money',
      {
        ...currentPrices,
        lines: [{ ...currentPrices.lines[0], unitPrice: '0.39' }],
      },
    ],
    [
      'future line field',
      {
        ...currentPrices,
        lines: [
          { ...currentPrices.lines[0], tomorrowExpectedPrice: '0.38000000' },
        ],
      },
    ],
  ])('rejects current prices with %s without fallback', async (_label, value) => {
    await localStore.set('apiToken', 'lhdao_pk_test')
    gqlMock.mockResolvedValue({ currentEngagementMarketPrices: value })
    await expect(
      currentEngagementMarketPricesHandler({ actions: ['LIKE'] }),
    ).resolves.toEqual({
      type: 'current-engagement-prices-result',
      ok: false,
      code: 'PLUGIN_CURRENT_PRICES_RESPONSE_INVALID',
      message: '当前价格响应无效，请稍后重试。',
    })
  })

  it('requires plugin auth before requesting a quote', async () => {
    await expect(
      previewPromoteTweetPricingHandler({
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions,
      }),
    ).resolves.toEqual({
      type: 'promote-pricing-result',
      ok: false,
      code: 'NO_TOKEN',
      message: '请先在插件 options 配置 plugin token',
    })
    expect(gqlMock).not.toHaveBeenCalled()
  })

  it('uses the signed preview operation and returns only its server quote', async () => {
    await localStore.set('apiToken', 'lhdao_pk_test')
    gqlMock.mockResolvedValue({ previewPromoteTweetPricing: quote })

    await expect(
      previewPromoteTweetPricingHandler({
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions,
      }),
    ).resolves.toEqual({
      type: 'promote-pricing-result',
      ok: true,
      quote,
    })
    expect(gqlMock).toHaveBeenCalledWith(PREVIEW_PROMOTE_TWEET_PRICING_QUERY, {
      input: {
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions,
      },
    })
  })

  it('drives preview variables from the byte-identical Web parity fixture', async () => {
    await localStore.set('apiToken', 'lhdao_pk_test')
    gqlMock.mockResolvedValue({ previewPromoteTweetPricing: quote })
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'src/lib/__tests__/fixtures/engagement-pilot-channel-parity.json',
        ),
        'utf8',
      ),
    ) as {
      campaigns: {
        actions: string[]
        tierSeats: Record<string, number>
      }[]
    }
    const fixtureActions = fixture.campaigns.map((campaign) => ({
      actionType: campaign.actions[0]!,
      tierSlots: campaign.tierSeats,
    }))

    await previewPromoteTweetPricingHandler({
      tweetUrl: 'https://x.com/lighthouse/status/1',
      actions: fixtureActions,
    })

    expect(gqlMock).toHaveBeenCalledWith(PREVIEW_PROMOTE_TWEET_PRICING_QUERY, {
      input: {
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions: [
          {
            actionType: 'LIKE',
            tierSlots: { S: 0, A: 5, B: 10, C: 0, D: 0 },
          },
          {
            actionType: 'RT',
            tierSlots: { S: 0, A: 2, B: 0, C: 0, D: 0 },
          },
        ],
      },
    })
  })

  it.each([
    ['invalid expiry', { ...quote, expiresAt: 'not-a-date' }],
    ['non-array lines', { ...quote, lines: {} }],
    ['empty lines', { ...quote, lines: [] }],
    ['wrong precision', { ...quote, precision: 7 }],
    ['non-string money', { ...quote, totalCost: 2.2 }],
    ['loose money', { ...quote, totalCost: '2.2' }],
    ['future root field', { ...quote, tomorrowExpectedPrice: '2.10000000' }],
    [
      'future line field',
      {
        ...quote,
        lines: [
          {
            campaignIndex: 0,
            actionType: 'LIKE',
            tier: 'A',
            quantity: 5,
            pricingSource: 'PILOT',
            unitPrice: '0.40000000',
            principal: '2.00000000',
            tomorrowExpectedPrice: '0.39000000',
          },
        ],
      },
    ],
  ])('rejects %s at the quote runtime boundary', async (_label, invalidQuote) => {
    await localStore.set('apiToken', 'lhdao_pk_test')
    gqlMock.mockResolvedValue({
      previewPromoteTweetPricing: invalidQuote,
    })

    await expect(
      previewPromoteTweetPricingHandler({
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions,
      }),
    ).resolves.toEqual({
      type: 'promote-pricing-result',
      ok: false,
      code: 'PLUGIN_PRICING_RESPONSE_INVALID',
      message: '报价响应无效，请刷新后重试。',
    })
  })

  it('submits the exact quoteId and reuses the idempotency key after uncertainty', async () => {
    await localStore.set('apiToken', 'lhdao_pk_test')
    gqlMock
      .mockRejectedValueOnce(
        new GqlError('Network error', undefined, undefined, 'NETWORK', true),
      )
      .mockRejectedValueOnce(
        new GqlError('Network error', undefined, undefined, 'NETWORK', true),
      )
    const request = {
      tweetUrl: 'https://x.com/lighthouse/status/1',
      actions,
      quoteId: 'quote-plugin-1',
      reinvestCount: 0,
    }

    await expect(promoteTweetHandler(request)).resolves.toMatchObject({
      type: 'promote-result',
      ok: false,
    })
    await expect(promoteTweetHandler(request)).resolves.toMatchObject({
      type: 'promote-result',
      ok: false,
    })

    const promoteCalls = gqlMock.mock.calls.filter(
      ([document]) => document === PROMOTE_TWEET_MUTATION,
    )
    expect(promoteCalls).toHaveLength(2)
    expect(promoteCalls[0]?.[1]).toEqual({
      input: {
        quoteId: 'quote-plugin-1',
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions,
      },
    })
    expect(promoteCalls[1]?.[1]).toEqual(promoteCalls[0]?.[1])
    expect(promoteCalls[1]?.[2]?.idempotencyKey).toBe(
      promoteCalls[0]?.[2]?.idempotencyKey,
    )
  })

  it('turns an unavailable signed operation into an upgrade-required response', async () => {
    await localStore.set('apiToken', 'lhdao_pk_test')
    gqlMock.mockRejectedValue(
      new GqlError('PLUGIN_OPERATION_DENIED', [
        {
          message: 'PLUGIN_OPERATION_DENIED',
          extensions: { code: 'PLUGIN_OPERATION_DENIED' },
        },
      ]),
    )

    await expect(
      previewPromoteTweetPricingHandler({
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions,
      }),
    ).resolves.toMatchObject({
      type: 'promote-pricing-result',
      ok: false,
      code: 'PLUGIN_UPGRADE_REQUIRED',
    })
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
