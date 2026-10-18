import { describe, expect, it } from 'vitest'
import {
  analyticsRequest,
  parseAnalyticsResponse,
} from '../x-analytics-network'

const now = Date.UTC(2026, 9, 16, 8)
const to = Date.UTC(2026, 9, 17)
const from = to - 90 * 86400000
const url = 'https://api.x.com/graphql/observed-id/accountOverviewDailyQuery'
const vars = {
  current_from: from,
  current_to: to,
  show_verified_followers: true,
}
const request = () =>
  analyticsRequest(
    `${url}?variables=${encodeURIComponent(JSON.stringify(vars))}`,
    undefined,
    now,
  )!
// Contract fixture from X's published Relay selection and aggregation code; not a live API response.
const response = () => ({
  data: {
    viewer_v2: {
      user_results: {
        result: {
          __typename: 'User',
          id: btoa('User:123'),
          verified_follower_count: 12,
          relationship_counts: { followers: 100 },
          author_follower_metrics: { active_followers: 80 },
          current_time_series: [
            { timestamp: from, engagement_type: 'Displayed', count: 1201 },
            { timestamp: from, engagement_type: 'Fav', count: 7 },
            { timestamp: from, engagement_type: 'Reply', count: 2 },
            { timestamp: from, engagement_type: 'Follow', count: 30 },
          ],
          hourly_backfill: [],
        },
      },
    },
  },
})

describe('analytics network contract', () => {
  it('matches GET and POST variables only on the overview endpoint', () => {
    expect(request()).toMatchObject({ from, to })
    expect(
      analyticsRequest(url, JSON.stringify({ variables: vars }), now),
    ).toEqual(request())
    for (const invalid of [
      url.replace('api.x.com', 'api.x.com.evil.test'),
      'https://api.x.com/1.1/graphql/app_context.json',
      url.replace('accountOverviewDailyQuery', 'Viewer'),
    ])
      expect(
        analyticsRequest(invalid, JSON.stringify({ variables: vars }), now),
      ).toBeNull()
    expect(
      analyticsRequest(
        url,
        JSON.stringify({
          variables: { ...vars, current_from: from + 86400000 },
        }),
        now,
      ),
    ).toBeNull()
    expect(
      analyticsRequest(
        url,
        JSON.stringify({ variables: vars }),
        now + 2 * 86400000,
      ),
    ).toBeNull()
  })
  it('reads exact counts, account identity and X engagement semantics', () => {
    expect(parseAnalyticsResponse(request(), 200, response())).toMatchObject({
      ok: true,
      twitterUserId: '123',
      metrics: {
        impressions: 1201,
        likes: 7,
        replies: 2,
        engagements: 9,
        engagementRate: 9 / 1201,
        followers: 100,
        verifiedFollowers: 12,
      },
    })
  })
  it('replaces trailing unfilled days with backfill rather than double counting', () => {
    const json = response()
    const user = json.data.viewer_v2.user_results.result
    user.current_time_series.push({
      timestamp: to - 86400000,
      engagement_type: 'Fav',
      count: 1,
    })
    user.hourly_backfill = [
      { timestamp: to - 86400000, engagement_type: 'Displayed', count: 50 },
      { timestamp: to - 86400000, engagement_type: 'Fav', count: 3 },
    ] as typeof user.hourly_backfill
    expect(parseAnalyticsResponse(request(), 200, json)).toMatchObject({
      ok: true,
      metrics: { impressions: 1251, likes: 10, engagements: 12 },
    })
  })
  it.each([
    401, 403, 404, 429, 500,
  ])('reports HTTP %s instead of accepting error JSON', (status) => {
    expect(parseAnalyticsResponse(request(), status, response())).toMatchObject(
      { ok: false, code: `HTTP_${status}` },
    )
  })
  it('rejects partial GraphQL errors and missing identity/counts', () => {
    expect(
      parseAnalyticsResponse(request(), 200, {
        ...response(),
        errors: [{ message: 'failure' }],
      }),
    ).toMatchObject({ ok: false })
    for (const key of [
      'id',
      'verified_follower_count',
      'current_time_series',
      'hourly_backfill',
    ]) {
      const json = response()
      delete (
        json.data.viewer_v2.user_results.result as Record<string, unknown>
      )[key]
      expect(parseAnalyticsResponse(request(), 200, json)).toMatchObject({
        ok: false,
        code: 'SCHEMA',
      })
    }
  })
  it('rejects invalid counts and out-of-period rows instead of filling them with zero', () => {
    for (const patch of [
      { count: -1 },
      { count: NaN },
      { timestamp: from - 86400000 },
      { count: '4' },
    ]) {
      const json = response()
      Object.assign(
        json.data.viewer_v2.user_results.result.current_time_series[0],
        patch,
      )
      expect(parseAnalyticsResponse(request(), 200, json)).toMatchObject({
        ok: false,
        code: 'SCHEMA',
      })
    }
  })
})

it('validates the normalized page bridge and expires cached responses', async () => {
  const { createAnalyticsNetworkReader } = await import(
    '../x-analytics-network'
  )
  let clock = now
  const reader = createAnalyticsNetworkReader(window, () => clock)
  const result = parseAnalyticsResponse(request(), 200, response())
  const emit = (data: unknown, origin = window.location.origin) =>
    window.dispatchEvent(
      new MessageEvent('message', { data, source: window, origin }),
    )
  try {
    emit(
      { type: 'lhdao:analytics-response:v1', startedAt: now, result },
      'https://evil.test',
    )
    expect(reader.get()).toBeUndefined()
    emit({ type: 'lhdao:analytics-response:v1', startedAt: now, result })
    expect(reader.get()).toMatchObject({ ok: true, twitterUserId: '123' })
    clock += 61_000
    expect(reader.get()).toBeUndefined()
  } finally {
    reader.dispose()
  }
})

it('retains valid aggregate metrics when a follower field is missing', () => {
  const json = response()
  delete (json.data.viewer_v2.user_results.result as Record<string, unknown>)
    .verified_follower_count
  expect(parseAnalyticsResponse(request(), 200, json)).toMatchObject({
    ok: false,
    code: 'SCHEMA',
    preview: {
      twitterUserId: '123',
      from,
      to,
      metrics: { impressions: 1201, followers: 100 },
    },
  })
})
it('retains followers but never invents zero aggregates from absent series', () => {
  const json = response()
  delete (json.data.viewer_v2.user_results.result as Record<string, unknown>)
    .current_time_series
  const result = parseAnalyticsResponse(request(), 200, json)
  expect(result).toMatchObject({
    ok: false,
    preview: { metrics: { followers: 100, verifiedFollowers: 12 } },
  })
  expect(
    'preview' in result && result.preview?.metrics.impressions,
  ).toBeUndefined()
})

it('preserves valid values in a partial GraphQL response without accepting it as complete', () => {
  const result = parseAnalyticsResponse(request(), 200, {
    ...response(),
    errors: [{ message: 'temporary partial error' }],
  })
  expect(result).toMatchObject({
    ok: false,
    code: 'GRAPHQL',
    preview: { metrics: { impressions: 1201 } },
  })
})
it('revalidates partial previews crossing the page bridge', async () => {
  const { createAnalyticsNetworkReader } = await import(
    '../x-analytics-network'
  )
  const reader = createAnalyticsNetworkReader(window, () => now)
  const event = (preview: unknown) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: location.origin,
        data: {
          type: 'lhdao:analytics-response:v1',
          startedAt: now,
          result: { ok: false, code: 'SCHEMA', from, to, preview },
        },
      }),
    )
  try {
    event({
      twitterUserId: '123',
      from,
      to,
      metrics: { followers: 100, impressions: -1, shares: 0 },
    })
    expect(reader.get()).toMatchObject({
      preview: { metrics: { followers: 100, shares: 0 } },
    })
    expect(reader.get()).not.toMatchObject({
      preview: { metrics: { impressions: -1 } },
    })
    event({
      twitterUserId: '123',
      from: from + 86400000,
      to: to + 86400000,
      metrics: { followers: 100 },
    })
    expect(reader.get()).not.toHaveProperty('preview')
  } finally {
    reader.dispose()
  }
})
