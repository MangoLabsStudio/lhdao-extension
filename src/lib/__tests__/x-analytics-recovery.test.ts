import { expect, it } from 'vitest'
import {
  mergePreview,
  missingMetrics,
  normalizePreview,
} from '../x-analytics-recovery'

const from = Date.UTC(2026, 6, 20),
  to = from + 90 * 86400000
it('merges only same-account same-period display values and preserves real zero', () => {
  const old = {
    twitterUserId: '123',
    from,
    to,
    metrics: { followers: 100, likes: 0 },
  }
  expect(
    mergePreview(old, { ...old, metrics: { impressions: 50 } }).metrics,
  ).toEqual({ followers: 100, likes: 0, impressions: 50 })
  expect(
    mergePreview(old, {
      ...old,
      twitterUserId: '456',
      metrics: { impressions: 1 },
    }).metrics,
  ).toEqual({ impressions: 1 })
  expect(
    mergePreview(old, {
      ...old,
      from: from + 86400000,
      to: to + 86400000,
      metrics: { impressions: 1 },
    }).metrics,
  ).toEqual({ impressions: 1 })
  expect(missingMetrics(old)).not.toContain('likes')
  expect(missingMetrics(old)).toContain('impressions')
})
it('filters invalid bridge fields and impossible follower counts', () => {
  const raw = {
    twitterUserId: '123',
    from,
    to,
    metrics: {
      followers: 100,
      verifiedFollowers: 101,
      likes: -1,
      shares: NaN,
      impressions: 10,
      engagementRate: Infinity,
      secret: 'no',
    },
  }
  expect(normalizePreview(raw)?.metrics).toEqual({
    followers: 100,
    impressions: 10,
  })
  expect(normalizePreview({ ...raw, twitterUserId: 'bad' })).toBeUndefined()
  expect(normalizePreview({ ...raw, to: to + 1 })).toBeUndefined()
})

it('replaces a retained optional count when X explicitly stops providing it', () => {
  const previous = {
    twitterUserId: '123',
    from,
    to,
    metrics: { activeFollowers: 25 },
  }
  const incoming = normalizePreview({
    ...previous,
    metrics: { activeFollowers: null },
  })!
  expect(mergePreview(previous, incoming).metrics.activeFollowers).toBeNull()
})
