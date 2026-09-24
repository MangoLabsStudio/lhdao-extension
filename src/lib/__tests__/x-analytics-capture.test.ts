import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureXAnalyticsPage,
  diagnoseXAnalyticsPage,
  findThreeMonthButton,
  isThreeMonthSelected,
  rollingNinetyDayPeriod,
  waitForThreeMonthCapture,
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

  it('reports the exact fields that prevented a complete capture', () => {
    document.body.innerHTML = `
      <button data-testid="SideNav_AccountSwitcher_Button">
        <span>@wang_jl80536</span>
      </button>
      <button>Impressions 11.7K</button>
      <button>Shares 0</button>
    `

    expect(diagnoseXAnalyticsPage(document).missing).toEqual([
      'verifiedFollowers',
      'followers',
      'engagementRate',
      'engagements',
      'profileVisits',
      'replies',
      'likes',
      'reposts',
      'bookmarks',
    ])
  })

  it('reads the nested handle when X labels the account button generically', () => {
    document.body.innerHTML = `
      <button data-testid="SideNav_AccountSwitcher_Button" aria-label="Account menu">
        <span>@wang_jl80536</span>
      </button>
    `

    expect(diagnoseXAnalyticsPage(document).missing).not.toContain(
      'twitterUsername',
    )
  })

  it('reads metric values exposed through accessible labels', () => {
    document.body.innerHTML = `
      <button data-testid="SideNav_AccountSwitcher_Button">
        <span>@wang_jl80536</span>
      </button>
      <button><span>Impressions</span><span aria-label="--"></span></button>
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

  it('follows aria-labelledby references used by X buttons', () => {
    document.body.innerHTML = `
      <div id="account">0xWang健林 <span aria-label="@wang_jl80536"></span></div>
      <button data-testid="SideNav_AccountSwitcher_Button" aria-labelledby="account"></button>
      <div id="verified">Verified followers <span aria-label="597"></span> / <span aria-label="2.2K"></span></div>
      <div role="button" aria-labelledby="verified"></div>
      <div id="active">Active followers <span aria-label="1.5K"></span> / <span aria-label="2.2K"></span></div>
      <div role="button" aria-labelledby="active"></div>
      <button aria-label="Impressions 11.7K ↓ -61%"></button>
      <button aria-label="Engagement rate 1.3% ↓ -37%"></button>
      <button aria-label="Engagements 158 ↓ -76%"></button>
      <button aria-label="Profile visits 23 ↓ -70%"></button>
      <button aria-label="Replies 74 ↓ -75%"></button>
      <button aria-label="Likes 46 ↓ -82%"></button>
      <button aria-label="Reposts 2 ↓ -71%"></button>
      <button aria-label="Bookmarks 13 ↓ -40%"></button>
      <button aria-label="Shares 0 ↓ -100%"></button>
    `

    expect(captureXAnalyticsPage(document)).toMatchObject({
      twitterUsername: 'wang_jl80536',
      metrics: { verifiedFollowers: 597, followers: 2200 },
    })
  })

  it('reads X clickable cards that use plain div containers', () => {
    document.body.innerHTML = `
      <div><div><span>0xWang健林</span><span>@wang_jl80536</span></div></div>
      <div><span>Verified followers</span><span aria-label="597"></span> / <span aria-label="2.2K"></span></div>
      <div><span>Active followers</span><span aria-label="1.5K"></span> / <span aria-label="2.2K"></span></div>
      <div><span>Impressions</span><span aria-label="11.7K"></span> ↓ <span aria-label="-61%"></span></div>
      <div><span>Engagement rate</span><span aria-label="1.3%"></span> ↓ <span aria-label="-37%"></span></div>
      <div><span>Engagements</span><span aria-label="158"></span> ↓ <span aria-label="-76%"></span></div>
      <div><span>Profile visits</span><span aria-label="23"></span> ↓ <span aria-label="-70%"></span></div>
      <div><span>Replies</span><span aria-label="74"></span> ↓ <span aria-label="-75%"></span></div>
      <div><span>Likes</span><span aria-label="46"></span> ↓ <span aria-label="-82%"></span></div>
      <div><span>Reposts</span><span aria-label="2"></span> ↓ <span aria-label="-71%"></span></div>
      <div><span>Bookmarks</span><span aria-label="13"></span> ↓ <span aria-label="-40%"></span></div>
      <div><span>Shares</span><span aria-label="0"></span> ↓ <span aria-label="-100%"></span></div>
    `

    expect(captureXAnalyticsPage(document)).toMatchObject({
      twitterUsername: 'wang_jl80536',
      metrics: {
        verifiedFollowers: 597,
        followers: 2200,
        impressions: 11700,
        engagementRate: 0.013,
        shares: 0,
      },
    })
  })

  it('reads number-flow values rendered in X open shadow roots', () => {
    document.body.innerHTML = `
      <div><span>@wang_jl80536</span></div>
      <div><span>Verified followers</span><number-flow-react data-value="597"></number-flow-react> / <number-flow-react data-value="2.2K"></number-flow-react></div>
      <div><span>Active followers</span><number-flow-react data-value="1.5K"></number-flow-react> / <number-flow-react data-value="2.2K"></number-flow-react></div>
      <div><span>Impressions</span><number-flow-react data-value="11.7K"></number-flow-react></div>
      <div><span>Engagement rate</span><number-flow-react data-value="1.3%"></number-flow-react></div>
      <div><span>Engagements</span><number-flow-react data-value="158"></number-flow-react></div>
      <div><span>Profile visits</span><number-flow-react data-value="23"></number-flow-react></div>
      <div><span>Replies</span><number-flow-react data-value="74"></number-flow-react></div>
      <div><span>Likes</span><number-flow-react data-value="46"></number-flow-react></div>
      <div><span>Reposts</span><number-flow-react data-value="2"></number-flow-react></div>
      <div><span>Bookmarks</span><number-flow-react data-value="13"></number-flow-react></div>
      <div><span>Shares</span><number-flow-react data-value="0"></number-flow-react></div>
    `

    for (const host of document.querySelectorAll('number-flow-react')) {
      const shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML = Array.from(host.getAttribute('data-value') ?? '')
        .map((character) =>
          /\d/.test(character)
            ? `<span class="digit" style="--current: ${character}; --length: 10;"><span class="digit__num">0123456789</span></span>`
            : `<span class="symbol">${character}</span>`,
        )
        .join('')
    }

    expect(captureXAnalyticsPage(document)).toEqual({
      twitterUsername: 'wang_jl80536',
      metrics: {
        verifiedFollowers: 597,
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

  it('reads elements when the extension realm has a different Element constructor', () => {
    document.body.innerHTML = `
      <div><span>@wang_jl80536</span></div>
      <button>Verified followers 597 / 2.2K</button>
      <button>Active followers 1.5K / 2.2K</button>
      <button>Impressions 11.7K</button>
      <button>Engagement rate 1.3%</button>
      <button>Engagements 158</button>
      <button>Profile visits 23</button>
      <button>Replies 74</button>
      <button>Likes 46</button>
      <button>Reposts 2</button>
      <button>Bookmarks 13</button>
      <button>Shares 0</button>
    `

    vi.stubGlobal('Element', class {})
    try {
      expect(captureXAnalyticsPage(document)).toMatchObject({
        twitterUsername: 'wang_jl80536',
        metrics: { impressions: 11700, engagementRate: 0.013 },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('3M range refresh guard', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  const renderAnalyticsPage = (
    threeMonthPressed: boolean,
    impressions = '11.7K',
  ) => {
    document.body.innerHTML = `
      <button data-testid="SideNav_AccountSwitcher_Button"><span>@wang_jl80536</span></button>
      <button aria-pressed="${!threeMonthPressed}">28D</button>
      <button aria-pressed="${threeMonthPressed}">3M</button>
      <button>Verified followers 598 / 2.2K</button>
      <button>Active followers 1.5K / 2.2K</button>
      <button>Impressions ${impressions}</button>
      <button>Engagement rate 1.3%</button>
      <button>Engagements 158</button>
      <button>Profile visits 23</button>
      <button>Replies 74</button>
      <button>Likes 46</button>
      <button>Reposts 2</button>
      <button>Bookmarks 13</button>
      <button>Shares 0</button>
    `
  }

  const fakeClock = () => {
    let tick = 0
    return {
      now: () => tick,
      sleep: (ms: number) => {
        tick += ms
        return Promise.resolve()
      },
    }
  }

  it('detects aria-pressed, aria-selected and data-state selection markers', () => {
    renderAnalyticsPage(true)
    expect(isThreeMonthSelected(findThreeMonthButton(document)!)).toBe(true)

    renderAnalyticsPage(false)
    expect(isThreeMonthSelected(findThreeMonthButton(document)!)).toBe(false)

    document.body.innerHTML = '<button aria-selected="true">3M</button>'
    expect(isThreeMonthSelected(findThreeMonthButton(document)!)).toBe(true)

    document.body.innerHTML = '<button data-state="active">3M</button>'
    expect(isThreeMonthSelected(findThreeMonthButton(document)!)).toBe(true)

    document.body.innerHTML = '<button data-state="inactive">3M</button>'
    expect(isThreeMonthSelected(findThreeMonthButton(document)!)).toBe(false)
  })

  it('detects X filled-pill selection classes on the 3M control', () => {
    document.body.innerHTML = `
      <button class="gap-1 inline-flex items-center border border-solid font-bold transition justify-center h-8 min-w-8 px-4 text-subtext1 bg-transparent border-nested-border outline-text text-text rounded-full border-gray-400! shrink-0">7D</button>
      <button class="gap-1 inline-flex items-center border border-solid font-bold transition justify-center h-8 min-w-8 px-4 text-subtext1 bg-text border-transparent outline-text text-background rounded-full shrink-0">3M</button>
      <button class="gap-1 inline-flex items-center border border-solid font-bold transition justify-center h-8 min-w-8 px-4 text-subtext1 bg-transparent border-nested-border outline-text text-text rounded-full border-gray-400! shrink-0">1Y</button>
    `
    expect(isThreeMonthSelected(findThreeMonthButton(document)!)).toBe(true)
  })

  it('rejects X outline-pill classes when 3M is not selected', () => {
    document.body.innerHTML = `
      <button class="gap-1 inline-flex items-center border border-solid font-bold transition justify-center h-8 min-w-8 px-4 text-subtext1 bg-transparent border-nested-border outline-text text-text rounded-full border-gray-400! shrink-0">3M</button>
    `
    expect(isThreeMonthSelected(findThreeMonthButton(document)!)).toBe(false)
  })

  it('captures a page without an active followers card as null', () => {
    renderAnalyticsPage(true)
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.startsWith('Active followers'))!
      .remove()
    expect(captureXAnalyticsPage(document)?.metrics).toMatchObject({
      activeFollowers: null,
      followers: 2200,
    })
  })

  it('rejects complete metrics while the 3M range stays unselected', async () => {
    renderAnalyticsPage(false)
    const clock = fakeClock()

    const result = await waitForThreeMonthCapture({
      root: document,
      timeoutMs: 2_000,
      intervalMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.refreshed).toBe(false)
  })

  it('accepts the capture once 3M is selected and the metrics change', async () => {
    renderAnalyticsPage(false)
    let tick = 0

    const result = await waitForThreeMonthCapture({
      root: document,
      timeoutMs: 2_000,
      intervalMs: 250,
      now: () => tick,
      sleep: (ms) => {
        tick += ms
        if (tick === 500) {
          findThreeMonthButton(document)!.setAttribute('aria-pressed', 'true')
          const card = Array.from(document.querySelectorAll('button')).find(
            (button) => button.textContent?.startsWith('Impressions'),
          )!
          card.textContent = 'Impressions 42K'
        }
        return Promise.resolve()
      },
    })

    expect(result.refreshed).toBe(true)
    expect(result.capture?.metrics.impressions).toBe(42_000)
  })

  it('accepts unchanged metrics when 3M was already selected before the click', async () => {
    renderAnalyticsPage(true)
    const clock = fakeClock()

    const result = await waitForThreeMonthCapture({
      root: document,
      timeoutMs: 2_000,
      intervalMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.refreshed).toBe(true)
    expect(result.capture?.metrics.impressions).toBe(11_700)
  })

  it('accepts unchanged metrics after switching to 3M', async () => {
    renderAnalyticsPage(false)
    let tick = 0

    const result = await waitForThreeMonthCapture({
      root: document,
      timeoutMs: 1_000,
      intervalMs: 250,
      now: () => tick,
      sleep: (ms) => {
        tick += ms
        if (tick === 250) {
          findThreeMonthButton(document)!.setAttribute('aria-pressed', 'true')
        }
        return Promise.resolve()
      },
    })

    expect(result.refreshed).toBe(true)
    expect(result.capture?.metrics.impressions).toBe(11_700)
  })
})
