import type { XAnalyticsPageCapture } from './x-analytics-capture'

export const MAX_CAPTURE_ATTEMPTS = 3
export const metricLabels = {
  followers: '关注者总数',
  verifiedFollowers: '认证关注者',
  activeFollowers: '活跃关注者',
  impressions: '曝光量',
  engagements: '互动量',
  engagementRate: '互动率',
  profileVisits: '主页访问量',
  replies: '回复',
  likes: '点赞',
  reposts: '转发',
  bookmarks: '书签',
  shares: '分享',
} as const
export interface AnalyticsPreview {
  twitterUserId: string
  from: number
  to: number
  metrics: Partial<XAnalyticsPageCapture['metrics']>
}
export interface AnalyticsSavePayload {
  captureId: string
  twitterUsername: string
  periodStart: string
  periodEnd: string
  capturedAt: string
  metrics: Record<string, number | null>
}
export interface CaptureProgress {
  runId?: string
  retryable?: boolean
  discardSave?: boolean
  preview?: AnalyticsPreview
}

// Previews are display-only. A save must still use one complete response.
export function normalizePreview(value: unknown): AnalyticsPreview | undefined {
  if (!value || typeof value !== 'object') return
  const raw = value as AnalyticsPreview
  if (
    typeof raw.twitterUserId !== 'string' ||
    !/^\d{1,25}$/.test(raw.twitterUserId) ||
    !Number.isSafeInteger(raw.from) ||
    !Number.isSafeInteger(raw.to) ||
    raw.from % 86_400_000 ||
    raw.to - raw.from !== 90 * 86_400_000 ||
    !raw.metrics
  )
    return
  const metrics: AnalyticsPreview['metrics'] = {}
  for (const key of Object.keys(
    metricLabels,
  ) as (keyof typeof metricLabels)[]) {
    const n = raw.metrics[key]
    if (key === 'activeFollowers' && n === null) metrics[key] = null
    if (
      typeof n === 'number' &&
      Number.isFinite(n) &&
      n >= 0 &&
      (key === 'engagementRate' || Number.isSafeInteger(n))
    )
      metrics[key] = n
  }
  if (metrics.followers !== undefined) {
    if ((metrics.verifiedFollowers ?? 0) > metrics.followers)
      delete metrics.verifiedFollowers
    if ((metrics.activeFollowers ?? 0) > metrics.followers)
      delete metrics.activeFollowers
  }
  return {
    twitterUserId: raw.twitterUserId,
    from: raw.from,
    to: raw.to,
    metrics,
  }
}
export function mergePreview(
  previous: AnalyticsPreview | undefined,
  incoming: AnalyticsPreview,
): AnalyticsPreview {
  if (
    !previous ||
    previous.twitterUserId !== incoming.twitterUserId ||
    previous.from !== incoming.from ||
    previous.to !== incoming.to
  )
    return incoming
  return normalizePreview({
    ...incoming,
    metrics: { ...previous.metrics, ...incoming.metrics },
  })!
}
export function missingMetrics(preview?: AnalyticsPreview): string[] {
  return Object.keys(metricLabels).filter(
    (key) =>
      key !== 'activeFollowers' &&
      preview?.metrics[key as keyof typeof metricLabels] === undefined,
  )
}
export function retryDelay(attempt: number): number {
  return attempt === 1 ? 3000 : 8000
}
