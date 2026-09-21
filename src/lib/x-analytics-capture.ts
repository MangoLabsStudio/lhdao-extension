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

export interface XAnalyticsPageDiagnostic {
  capture: XAnalyticsPageCapture | null
  missing: string[]
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

const selectedDataStates = new Set(['active', 'on', 'selected', 'checked'])

// X 分析页范围选择器不用任何 ARIA/data 属性：选中的范围是实心胶囊
// （bg-text + border-transparent + text-background），未选中是描边胶囊
// （bg-transparent）。class 是语义化 design-token，不是哈希名。
const xSelectedPillClasses = ['bg-text', 'border-transparent', 'text-background']

export function isThreeMonthSelected(button: HTMLButtonElement): boolean {
  if (button.getAttribute('aria-pressed') === 'true') return true
  if (button.getAttribute('aria-selected') === 'true') return true
  if (button.getAttribute('aria-checked') === 'true') return true
  const state = button.getAttribute('data-state')
  if (state !== null) return selectedDataStates.has(state)
  const classList = button.classList
  if (classList.contains('bg-transparent')) return false
  return xSelectedPillClasses.every((cls) => classList.contains(cls))
}

export interface ThreeMonthCaptureWait {
  root: ParentNode
  previousMetrics: Record<string, number> | null
  wasSelected: boolean
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface ThreeMonthCaptureResult extends XAnalyticsPageDiagnostic {
  refreshed: boolean
}

export async function waitForThreeMonthCapture({
  root,
  previousMetrics,
  wasSelected,
  timeoutMs = 8_000,
  intervalMs = 250,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: ThreeMonthCaptureWait): Promise<ThreeMonthCaptureResult> {
  const before = previousMetrics ? metricsFingerprint(previousMetrics) : null
  const deadline = now() + timeoutMs
  for (;;) {
    const diagnostic = diagnoseXAnalyticsPage(root)
    const range = findThreeMonthButton(root)
    if (range && isThreeMonthSelected(range) && diagnostic.capture) {
      const after = metricsFingerprint(diagnostic.capture.metrics)
      if (wasSelected || after !== before) {
        return { ...diagnostic, refreshed: true }
      }
    }
    if (now() >= deadline) return { ...diagnostic, refreshed: false }
    await sleep(intervalMs)
  }
}

function metricsFingerprint(metrics: Record<string, number>): string {
  return requiredMetrics.map((key) => metrics[key] ?? '').join('|')
}

export function captureXAnalyticsPage(
  root: ParentNode,
): XAnalyticsPageCapture | null {
  return diagnoseXAnalyticsPage(root).capture
}

export function diagnoseXAnalyticsPage(
  root: ParentNode,
): XAnalyticsPageDiagnostic {
  const candidates = collectCaptureCandidates(root)
  const accountButton = root.querySelector(
    '[data-testid="SideNav_AccountSwitcher_Button"]',
  )
  const identityCandidates = accountButton
    ? [accountButton, ...candidates]
    : candidates
  const handle = identityCandidates
    .map((element) => `${accessibleText(element)} ${element.textContent ?? ''}`)
    .map((text) => text.match(/@([A-Za-z0-9_]{1,15})\b/)?.[1])
    .find(Boolean)

  const metrics: Record<string, number> = {}
  let followersConflict = false
  for (const control of candidates) {
    const text = accessibleText(control).replace(/\s+/g, ' ').trim()
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
        followersConflict = true
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
  const missing: string[] = requiredMetrics.filter(
    (key) =>
      metrics[key] === undefined || (key === 'followers' && followersConflict),
  )
  if (!handle) missing.unshift('twitterUsername')
  return {
    capture:
      missing.length === 0
        ? {
            twitterUsername: handle!.toLowerCase(),
            metrics: metrics as XAnalyticsPageCapture['metrics'],
          }
        : null,
    missing,
  }
}

function collectCaptureCandidates(root: ParentNode): Element[] {
  const candidates = new Set(
    root.querySelectorAll(
      'button, [role="button"], [aria-label], [aria-labelledby]',
    ),
  )
  const labels = [
    'Verified followers',
    'Active followers',
    ...Object.keys(summaryMetrics),
  ].map((label) => label.toLowerCase())

  for (const element of root.querySelectorAll('*')) {
    const ownText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (
      !/@[A-Za-z0-9_]{1,15}\b/.test(ownText) &&
      !labels.includes(ownText.toLowerCase())
    )
      continue

    let candidate: Element | null = element
    for (let depth = 0; candidate && depth < 6; depth += 1) {
      candidates.add(candidate)
      candidate = candidate.parentElement
    }
  }
  return Array.from(candidates)
}

function accessibleText(node: Node, visited = new Set<Node>()): string {
  if (visited.has(node)) return ''
  visited.add(node)
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as Element
  if (element.localName === 'number-flow-react') {
    const value = numberFlowText(element)
    if (value) return value
  }
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const document = element.ownerDocument
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => Boolean(element))
      .map((element) => accessibleText(element, visited))
      .join(' ')
  }
  const label = element.getAttribute('aria-label')
  if (label) return label
  return Array.from(element.childNodes)
    .map((child) => accessibleText(child, visited))
    .join(' ')
}

function numberFlowText(element: Element): string {
  const shadowRoot = element.shadowRoot
  if (!shadowRoot) return ''

  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const child = node as Element
    if (child.tagName === 'STYLE') return ''
    if (child.classList.contains('digit')) {
      return (
        child
          .getAttribute('style')
          ?.match(/(?:^|;)\s*--current:\s*([0-9])\s*(?:;|$)/)?.[1] ?? ''
      )
    }
    if (child.classList.contains('symbol')) return child.textContent ?? ''
    return Array.from(child.childNodes).map(read).join('')
  }

  return Array.from(shadowRoot.childNodes).map(read).join('')
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
