import { describe, expect, it } from 'vitest'
import {
  indexBinanceSquareTasks,
  reservedBinanceProbeTargets,
} from '../binance-square-tasks'
import type { AvailableEngagement } from '../queries'

const campaigns = [
  {
    id: 'c-like',
    type: 'ENGAGEMENT',
    platform: 'BINANCE_SQUARE',
    targetUrl: 'https://www.binance.com/en/square/post/335389698745313',
    targetContentId: '335389698745313',
    targetAuthorId: null,
    actions: [{ actionType: 'LIKE', baseReward: 1, targetCount: 1 }],
  },
  {
    id: 'c-x',
    type: 'ENGAGEMENT',
    platform: 'X',
    targetUrl: 'https://x.com/a/status/1',
    targetContentId: null,
    targetAuthorId: null,
    actions: [{ actionType: 'LIKE', baseReward: 1, targetCount: 1 }],
  },
] as unknown as AvailableEngagement[]

describe('indexBinanceSquareTasks', () => {
  it('indexes only Binance targets and marks reserved campaigns', () => {
    expect(indexBinanceSquareTasks(campaigns, new Set(['c-like']))).toEqual({
      byContentId: {
        '335389698745313': [
          expect.objectContaining({
            campaignId: 'c-like',
            actionType: 'LIKE',
            reserved: true,
          }),
        ],
      },
      byAuthorId: {},
    })
  })

  it('projects only reserved targets into probe config', () => {
    const index = indexBinanceSquareTasks(campaigns, new Set(['c-like']))
    expect(reservedBinanceProbeTargets(index)).toEqual([
      { kind: 'CONTENT', id: '335389698745313' },
    ])
  })
})
