import { beforeEach, describe, expect, it } from 'vitest'
import {
  captureXAnalyticsPage,
  rollingNinetyDayPeriod,
} from '../x-analytics-capture'

describe('X account analytics capture', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('reads the signed-in handle and every 3M account summary card', () => {
    document.body.innerHTML = `
      <button data-testid="SideNav_AccountSwitcher_Button">
        <span>0xWang健林</span><span>@wang_jl80536</span>
      </button>
      <button>Verified followers 598 / 2.2K</button>
      <button>Active followers 1.5K / 2.2K</button>
      <button>Impressions 11.7K ↓ -61%</button>
      <button>Engagement rate 1.3% ↓ -37%</button>
      <button>Engagements 158 ↓ -76%</button>
      <button>Profile visits 23 ↓ -70%</button>
      <button>Replies 74 ↓ -75%</button>
      <button>Likes 46 ↓ -82%</button>
      <button>Reposts 2 ↓ -71%</button>
      <button>Bookmarks 13 ↓ -40%</button>
      <button>Shares 0 ↓ -100%</button>
    `

    expect(captureXAnalyticsPage(document)).toEqual({
      twitterUsername: 'wang_jl80536',
      metrics: {
        verifiedFollowers: 598,
        activeFollowers: 1500,
        followers: 2200,
        impressions: 11700,
        engagementRate: 0.013,
        engagements: 158,
        profileVisits: 23,
        replies: 74,
        likes: 46,
        reposts: 2,
        bookmarks: 13,
        shares: 0,
      },
    })
  })

  it('fails closed when a card or account identity is missing', () => {
    document.body.innerHTML = '<button>Impressions 0</button>'
    expect(captureXAnalyticsPage(document)).toBeNull()
  })

  it('reads metric values exposed through accessible labels', () => {
    document.body.innerHTML = `
      <button data-testid="SideNav_AccountSwitcher_Button">
        <span>@wang_jl80536</span>
      </button>
      <button><span>Verified followers</span><span aria-label="598"></span> / <span aria-label="2.2K"></span></button>
      <button><span>Active followers</span><span aria-label="1.5K"></span> / <span aria-label="2.2K"></span></button>
      <button><span>Impressions</span><span aria-label="11.7K"></span> ↓ <span aria-label="-61%"></span></button>
      <button><span>Engagement rate</span><span aria-label="1.3%"></span> ↓ <span aria-label="-37%"></span></button>
      <button><span>Engagements</span><span aria-label="158"></span> ↓ <span aria-label="-76%"></span></button>
      <button><span>Profile visits</span><span aria-label="23"></span> ↓ <span aria-label="-70%"></span></button>
      <button><span>Replies</span><span aria-label="74"></span> ↓ <span aria-label="-75%"></span></button>
      <button><span>Likes</span><span aria-label="46"></span> ↓ <span aria-label="-82%"></span></button>
      <button><span>Reposts</span><span aria-label="2"></span> ↓ <span aria-label="-71%"></span></button>
      <button><span>Bookmarks</span><span aria-label="13"></span> ↓ <span aria-label="-40%"></span></button>
      <button><span>Shares</span><span aria-label="0"></span> ↓ <span aria-label="-100%"></span></button>
    `

    expect(captureXAnalyticsPage(document)?.metrics).toMatchObject({
      followers: 2200,
      impressions: 11700,
      engagementRate: 0.013,
      shares: 0,
    })
  })

  it('uses the same inclusive rolling 90-day range as X 3M', () => {
    expect(rollingNinetyDayPeriod(new Date('2026-09-15T10:00:00Z'))).toEqual({
      periodStart: '2026-06-18',
      periodEnd: '2026-09-15',
    })
  })
})
