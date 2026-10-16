import type { XAnalyticsPageCapture } from './x-analytics-capture'

const DAY = 86_400_000
export const ANALYTICS_EVENT = 'lhdao:analytics-response:v1'
export interface AnalyticsRequest {
  from: number
  to: number
}
export type AnalyticsResponse = AnalyticsRequest &
  (
    | {
        ok: true
        twitterUserId: string
        metrics: XAnalyticsPageCapture['metrics']
      }
    | { ok: false; code: string }
  )
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function analyticsRequest(
  url: string,
  body?: string,
  now = Date.now(),
): AnalyticsRequest | null {
  try {
    const parsed = new URL(url, 'https://x.com')
    if (
      parsed.protocol !== 'https:' ||
      parsed.port !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !['x.com', 'api.x.com', 'twitter.com', 'api.twitter.com'].includes(
        parsed.hostname,
      ) ||
      !/^\/(?:i\/api\/)?graphql\/[^/]+\/accountOverviewDailyQuery$/.test(
        parsed.pathname,
      )
    )
      return null
    const raw = parsed.searchParams.get('variables')
    const vars = object(
      raw ? JSON.parse(raw) : object(JSON.parse(body ?? '{}')).variables,
    )
    const from = vars.current_from
    const to = vars.current_to
    const today = Math.floor(now / DAY) * DAY
    if (
      !count(from) ||
      !count(to) ||
      from % DAY ||
      to !== today + DAY ||
      to - from !== 90 * DAY ||
      vars.show_verified_followers !== true
    )
      return null
    return { from, to }
  } catch {
    return null
  }
}

interface Row {
  timestamp: number
  engagement_type: string
  count: number
}
function rows(value: unknown, from: number, to: number): Row[] | null {
  if (!Array.isArray(value) || value.length > 100_000) return null
  const result: Row[] = []
  for (const item of value) {
    const row = object(item)
    if (
      !count(row.timestamp) ||
      row.timestamp % DAY ||
      row.timestamp < from ||
      row.timestamp >= to ||
      !count(row.count) ||
      typeof row.engagement_type !== 'string'
    )
      return null
    result.push({
      timestamp: row.timestamp,
      engagement_type: row.engagement_type,
      count: row.count,
    })
  }
  return result
}

// Matches the daily overview aggregation in X's 2026-10-16 published client.
// A live successful response is still required for release acceptance.
export function parseAnalyticsResponse(
  request: AnalyticsRequest,
  status: number,
  json: unknown,
): AnalyticsResponse {
  const fail = (code: string): AnalyticsResponse => ({
    ...request,
    ok: false,
    code,
  })
  if (status < 200 || status >= 300)
    return fail(status ? `HTTP_${status}` : 'NETWORK')
  const root = object(json)
  if (
    root.errors !== undefined &&
    (!Array.isArray(root.errors) || root.errors.length)
  )
    return fail('GRAPHQL')
  const user = object(
    object(object(object(root.data).viewer_v2).user_results).result,
  )
  let userId = ''
  try {
    userId =
      typeof user.id === 'string'
        ? (atob(user.id).match(/^User:(\d+)$/)?.[1] ?? '')
        : ''
  } catch {}
  const numericCount = (value: unknown) =>
    typeof value === 'string' && /^\d{1,16}$/.test(value)
      ? Number(value)
      : value
  const followers = object(user.relationship_counts).followers
  const verified = numericCount(user.verified_follower_count)
  const active = numericCount(
    object(user.author_follower_metrics).active_followers,
  )
  if (
    user.__typename !== 'User' ||
    !userId ||
    !count(followers) ||
    !count(verified) ||
    verified > followers ||
    (active !== undefined &&
      active !== null &&
      (!count(active) || active > followers))
  )
    return fail('SCHEMA')
  const current = rows(user.current_time_series, request.from, request.to)
  // X asks for two backfill days and returns day-granularity rows from its hourly store.
  const backfill = rows(user.hourly_backfill, request.to - 2 * DAY, request.to)
  if (!current || !backfill) return fail('SCHEMA')
  const replaced = new Set<number>()
  for (let day = request.to - DAY; day >= request.from; day -= DAY) {
    if (
      current.some(
        (row) =>
          row.timestamp === day &&
          row.engagement_type === 'Displayed' &&
          row.count > 0,
      )
    )
      break
    if (backfill.some((row) => row.timestamp === day)) replaced.add(day)
  }
  const totals = {
    impressions: 0,
    likes: 0,
    replies: 0,
    reposts: 0,
    bookmarks: 0,
    shares: 0,
    profileVisits: 0,
    engagements: 0,
  }
  const keys: Record<string, keyof typeof totals> = {
    Displayed: 'impressions',
    Fav: 'likes',
    Reply: 'replies',
    Retweet: 'reposts',
    QuoteTweet: 'reposts',
    Bookmark: 'bookmarks',
    Share: 'shares',
    ProfilePic: 'profileVisits',
  }
  for (const row of [
    ...current.filter((row) => !replaced.has(row.timestamp)),
    ...backfill.filter((row) => replaced.has(row.timestamp)),
  ]) {
    const key = keys[row.engagement_type]
    if (!key) continue
    totals[key] += row.count
    if (key !== 'impressions') totals.engagements += row.count
  }
  if (!Object.values(totals).every(count)) return fail('SCHEMA')
  return {
    ...request,
    ok: true,
    twitterUserId: userId,
    metrics: {
      ...totals,
      followers,
      verifiedFollowers: verified,
      activeFollowers: typeof active === 'number' ? active : null,
      engagementRate: totals.impressions
        ? totals.engagements / totals.impressions
        : 0,
    },
  }
}

export function createAnalyticsNetworkReader(
  target: Window,
  now = () => Date.now(),
) {
  let cached: AnalyticsResponse | undefined
  let startedAt = 0
  const receive = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== target.location.origin)
      return
    const envelope = object(event.data)
    if (
      envelope.type !== ANALYTICS_EVENT ||
      !count(envelope.startedAt) ||
      envelope.startedAt < startedAt ||
      envelope.startedAt > now() ||
      now() - envelope.startedAt > 60_000
    )
      return
    const result = object(envelope.result)
    const to = (Math.floor(now() / DAY) + 1) * DAY
    if (result.to !== to || result.from !== to - 90 * DAY) return
    let value: AnalyticsResponse
    if (result.ok === false) {
      if (
        typeof result.code !== 'string' ||
        !/^(HTTP_[1-5]\d\d|NETWORK|GRAPHQL|SCHEMA)$/.test(result.code)
      )
        return
      value = { from: to - 90 * DAY, to, ok: false, code: result.code }
    } else {
      if (
        result.ok !== true ||
        typeof result.twitterUserId !== 'string' ||
        !/^\d{1,25}$/.test(result.twitterUserId)
      )
        return
      const input = object(result.metrics)
      const metrics: Record<string, number | null> = {}
      for (const key of [
        'followers',
        'verifiedFollowers',
        'impressions',
        'engagements',
        'profileVisits',
        'replies',
        'likes',
        'reposts',
        'bookmarks',
        'shares',
      ]) {
        if (!count(input[key])) return
        metrics[key] = input[key]
      }
      if (input.activeFollowers !== null && !count(input.activeFollowers))
        return
      if (
        typeof input.engagementRate !== 'number' ||
        !Number.isFinite(input.engagementRate) ||
        input.engagementRate < 0
      )
        return
      if (
        (metrics.verifiedFollowers as number) > (metrics.followers as number) ||
        (typeof input.activeFollowers === 'number' &&
          input.activeFollowers > (metrics.followers as number))
      )
        return
      metrics.activeFollowers = input.activeFollowers
      metrics.engagementRate = input.engagementRate
      value = {
        from: to - 90 * DAY,
        to,
        ok: true,
        twitterUserId: result.twitterUserId,
        metrics: metrics as XAnalyticsPageCapture['metrics'],
      }
    }
    startedAt = envelope.startedAt
    cached = value
  }
  target.addEventListener('message', receive)
  return {
    get: () =>
      now() - startedAt <= 60_000 &&
      cached?.to === (Math.floor(now() / DAY) + 1) * DAY
        ? cached
        : undefined,
    dispose: () => {
      target.removeEventListener('message', receive)
      cached = undefined
    },
  }
}
