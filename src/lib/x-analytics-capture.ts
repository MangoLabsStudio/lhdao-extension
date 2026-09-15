const summaryMetrics = {
  Impressions: 'impressions',
  'Engagement rate': 'engagementRate',
  Engagements: 'engagements',
  'Profile visits': 'profileVisits',
  Replies: 'replies',
  Likes: 'likes',
  Reposts: 'reposts',
  Bookmarks: 'bookmarks',
  Shares: 'shares',
} as const

const requiredMetrics = [
  'verifiedFollowers',
  'activeFollowers',
  'followers',
  ...Object.values(summaryMetrics),
] as const

export interface XAnalyticsPageCapture {
  twitterUsername: string
  metrics: Record<(typeof requiredMetrics)[number], number>
}

export function rollingNinetyDayPeriod(now: Date): {
  periodStart: string
  periodEnd: string
} {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 89)
  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  }
}

export function findThreeMonthButton(
  root: ParentNode,
): HTMLButtonElement | null {
  return (
    Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '3M',
    ) ?? null
  )
}

export function captureXAnalyticsPage(
  root: ParentNode,
): XAnalyticsPageCapture | null {
  const accountButton =
    root.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ??
    Array.from(root.querySelectorAll('button')).find((button) =>
      /@[A-Za-z0-9_]{1,15}\b/.test(button.textContent ?? ''),
    )
  const handle = accountButton?.textContent?.match(
    /@([A-Za-z0-9_]{1,15})\b/,
  )?.[1]
  if (!handle) return null

  const metrics: Record<string, number> = {}
  for (const button of root.querySelectorAll('button')) {
    const text = accessibleText(button)
      .replace(/\s+/g, ' ')
      .trim()
    const followers = text.match(
      /^(Verified followers|Active followers)\s+([\d.,]+[KMB]?)\s*\/\s*([\d.,]+[KMB]?)/i,
    )
    if (followers) {
      const value = parseCompactNumber(followers[2])
      const total = parseCompactNumber(followers[3])
      if (value === null || total === null) continue
      metrics[
        followers[1].toLowerCase().startsWith('verified')
          ? 'verifiedFollowers'
          : 'activeFollowers'
      ] = value
      if (metrics.followers !== undefined && metrics.followers !== total)
        return null
      metrics.followers = total
      continue
    }
    for (const [label, key] of Object.entries(summaryMetrics)) {
      if (!text.toLowerCase().startsWith(`${label.toLowerCase()} `)) continue
      const raw = text.slice(label.length).trim().split(/\s+/)[0]
      const value =
        key === 'engagementRate' ? parsePercent(raw) : parseCompactNumber(raw)
      if (value === null) continue
      metrics[key] = value
    }
  }
  if (requiredMetrics.some((key) => metrics[key] === undefined)) return null
  return {
    twitterUsername: handle.toLowerCase(),
    metrics: metrics as XAnalyticsPageCapture['metrics'],
  }
}

function accessibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof Element)) return ''
  const label = node.getAttribute('aria-label')
  if (label) return label
  return Array.from(node.childNodes).map(accessibleText).join(' ')
}

function parsePercent(value: string): number | null {
  if (!value.endsWith('%')) return null
  const number = Number(
    (Number(value.slice(0, -1).replaceAll(',', '')) / 100).toFixed(6),
  )
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null
}

function parseCompactNumber(value: string): number | null {
  const match = value.replaceAll(',', '').match(/^(\d+(?:\.\d+)?)([KMB])?$/i)
  if (!match) return null
  const multiplier =
    { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[
      match[2]?.toUpperCase() as 'K' | 'M' | 'B'
    ] ?? 1
  const result = Number(match[1]) * multiplier
  return Number.isSafeInteger(result) && result >= 0 ? result : null
}
