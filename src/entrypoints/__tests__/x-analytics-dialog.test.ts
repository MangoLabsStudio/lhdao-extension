import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as messaging from '@/lib/messaging'
import * as capture from '@/lib/x-analytics-capture'
import {
  ANALYTICS_EVENT,
  createAnalyticsNetworkReader,
} from '@/lib/x-analytics-network'
import { runAnalyticsCapture } from '@/lib/x-analytics-run'
import content from '../x-analytics.content'

const report = vi.fn(async (_phase: string, _message: string) => {})
const metrics = {
  impressions: 1201,
  engagements: 9,
  engagementRate: 9 / 1201,
  followers: 100,
  verifiedFollowers: 12,
  activeFollowers: null,
  likes: 7,
  replies: 2,
  reposts: 0,
  bookmarks: 0,
  shares: 0,
  profileVisits: 0,
}
const page = { twitterUsername: 'demo', twitterUserId: '123', metrics }
function successfulCapture() {
  return vi.spyOn(capture, 'waitForThreeMonthCapture').mockResolvedValue({
    rangeSelected: true,
    missing: [],
    capture: page,
  })
}
beforeEach(() => {
  report.mockClear()
  document.body.innerHTML = '<button aria-pressed="true">3M</button>'
  vi.spyOn(messaging, 'sendMessage').mockImplementation(async (message) => {
    if (message.type === 'claim-x-analytics-capture')
      return { type: 'x-analytics-auto-capture', autoCapture: false }
    if (message.type === 'get-x-analytics-status')
      return {
        type: 'x-analytics-status',
        twitterUsername: 'demo',
        twitterUserId: '123',
        completed: false,
      }
    if (message.type === 'x-analytics-progress') return { type: 'ack' }
    return {
      type: 'x-analytics-save-result',
      ok: true,
      savedAt: new Date().toISOString(),
    }
  })
})
afterEach(() => vi.restoreAllMocks())

it('does not inject a dialog or a persistent launcher on an ordinary X analytics visit', async () => {
  const read = successfulCapture()
  await content.main({} as NonNullable<Parameters<typeof content.main>[0]>)
  expect(document.getElementById('lhdao-x-analytics-capture')).toBeNull()
  expect(document.querySelector('dialog')).toBeNull()
  expect(read).not.toHaveBeenCalled()
})
it('automatically captures once without a second click or any injected UI', async () => {
  const read = successfulCapture()
  vi.mocked(messaging.sendMessage).mockResolvedValueOnce({
    type: 'x-analytics-auto-capture',
    autoCapture: true,
    twitterUsername: 'demo',
  })
  await content.main({} as NonNullable<Parameters<typeof content.main>[0]>)
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ selectRange: true, timeoutMs: 30_000 }),
  )
  expect(
    vi
      .mocked(messaging.sendMessage)
      .mock.calls.filter(([m]) => m.type === 'save-x-analytics'),
  ).toHaveLength(1)
  expect(document.getElementById('lhdao-x-analytics-capture')).toBeNull()
})
it.each([
  [{ rangeSelected: true, capture: null, missing: ['impressions'] }, '曝光量'],
  [
    { rangeSelected: true, capture: null, missing: ['periodRefresh'] },
    '本次未保存',
  ],
  [
    { rangeSelected: true, capture: null, missing: ['networkResponse'] },
    '未收到可验证',
  ],
  [
    { rangeSelected: false, capture: null, missing: [], pageError: true },
    'X 分析页加载失败',
  ],
  [
    { rangeSelected: true, capture: null, missing: [], apiError: 'HTTP_403' },
    'HTTP_403',
  ],
] as const)('reports collection errors without saving or losing the error reason: %j', async (result, message) => {
  vi.spyOn(capture, 'waitForThreeMonthCapture').mockResolvedValue(
    result as unknown as capture.ThreeMonthCaptureResult,
  )
  await runAnalyticsCapture(report, 'demo')
  expect(report).toHaveBeenLastCalledWith(
    'error',
    expect.stringContaining(message),
  )
  expect(messaging.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'save-x-analytics' }),
  )
})
it.each([
  [{ ...page, twitterUsername: 'other' }, '请切换到申请账号'],
  [{ ...page, twitterUserId: 'other-id' }, '分析响应的账号'],
])('rejects a different account identity: %j', async (wrongPage, message) => {
  successfulCapture().mockResolvedValue({
    rangeSelected: true,
    missing: [],
    capture: wrongPage,
  })
  await runAnalyticsCapture(report, 'demo')
  expect(report).toHaveBeenLastCalledWith(
    'error',
    expect.stringContaining(message),
  )
  expect(messaging.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'save-x-analytics' }),
  )
})
it.each([
  ['read', '读取 X 页面失败'],
  ['account', '无法核对 Lighthouse 绑定账号'],
  ['save', '未能确认保存结果'],
])('reports a failure at the %s stage without claiming success', async (stage, message) => {
  const read = successfulCapture()
  if (stage === 'read') read.mockRejectedValue(new Error('read failed'))
  const send = vi.mocked(messaging.sendMessage)
  const original = send.getMockImplementation()!
  send.mockImplementation(async (request) => {
    if (
      (stage === 'account' && request.type === 'get-x-analytics-status') ||
      (stage === 'save' && request.type === 'save-x-analytics')
    )
      throw new Error('connection interrupted')
    return original(request)
  })
  await runAnalyticsCapture(report, 'demo')
  expect(report).toHaveBeenLastCalledWith(
    'error',
    expect.stringContaining(message),
  )
})
it('stops before saving when the capture window has been closed', async () => {
  successfulCapture()
  await runAnalyticsCapture(async () => {
    throw new Error('Cancelled')
  }, 'demo')
  expect(messaging.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'save-x-analytics' }),
  )
})
it('keeps API errors distinct from backend save rejection', async () => {
  successfulCapture()
  const send = vi.mocked(messaging.sendMessage)
  const original = send.getMockImplementation()!
  send.mockImplementation((request) =>
    request.type === 'save-x-analytics'
      ? Promise.resolve({
          type: 'x-analytics-save-result',
          ok: false,
          code: 'INCOMPLETE',
        })
      : original(request),
  )
  await runAnalyticsCapture(report, 'demo')
  expect(report).toHaveBeenLastCalledWith(
    'error',
    expect.stringContaining('保存校验未通过'),
  )
})
it('saves an actual normalized bridge event with no DOM metric cards', async () => {
  document.body.innerHTML =
    '<button aria-pressed="true">3M</button><button data-testid="SideNav_AccountSwitcher_Button">@demo</button>'
  const reader = createAnalyticsNetworkReader(window)
  const to = (Math.floor(Date.now() / 86400000) + 1) * 86400000
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: {
        type: ANALYTICS_EVENT,
        startedAt: Date.now(),
        result: {
          ok: true,
          from: to - 90 * 86400000,
          to,
          twitterUserId: '123',
          metrics,
        },
      },
    }),
  )
  try {
    await runAnalyticsCapture(report, 'demo', reader.get)
    expect(messaging.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'save-x-analytics',
        twitterUsername: 'demo',
        metrics,
      }),
    )
    expect(report).not.toHaveBeenCalledWith('error', expect.anything())
  } finally {
    reader.dispose()
  }
})
it('preserves the response date range if the clock changes before account verification', async () => {
  const period = { periodStart: '2026-07-19', periodEnd: '2026-10-16' }
  successfulCapture().mockResolvedValue({
    rangeSelected: true,
    missing: [],
    capture: { ...page, ...period },
  })
  vi.spyOn(capture, 'rollingNinetyDayPeriod').mockReturnValue({
    periodStart: '2026-07-20',
    periodEnd: '2026-10-17',
  })
  await runAnalyticsCapture(report, 'demo')
  expect(messaging.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'save-x-analytics', ...period }),
  )
})

it('shows the reviewed backend reason instead of asking users to blindly refresh', async () => {
  successfulCapture()
  const send = vi.mocked(messaging.sendMessage)
  const original = send.getMockImplementation()!
  send.mockImplementation((request) =>
    request.type === 'save-x-analytics'
      ? Promise.resolve({
          type: 'x-analytics-save-result',
          ok: false,
          code: 'INCOMPLETE',
          message: '设备时间偏差过大，请同步系统时间后重试。',
        })
      : original(request),
  )
  await runAnalyticsCapture(report, 'demo')
  expect(report).toHaveBeenLastCalledWith(
    'error',
    '设备时间偏差过大，请同步系统时间后重试。',
  )
})
