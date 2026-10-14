import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as messaging from '@/lib/messaging'
import * as capture from '@/lib/x-analytics-capture'
import content from '../x-analytics.content'

let shadow: ShadowRoot
beforeEach(async () => {
  const attachShadow = Element.prototype.attachShadow
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    options,
  ) {
    shadow = attachShadow.call(this, options)
    return shadow
  })
  document.body.innerHTML = '<button aria-pressed="true">3M</button>'
  vi.spyOn(messaging, 'sendMessage').mockResolvedValue({
    type: 'x-analytics-auto-capture',
    autoCapture: false,
  })
  await content.main({} as NonNullable<Parameters<typeof content.main>[0]>)
})
afterEach(() => {
  document.getElementById('lhdao-x-analytics-capture')?.remove()
  vi.restoreAllMocks()
})

it('opens a modal that can be closed and reopened without losing its status', () => {
  const dialog = shadow.querySelector('dialog')!
  expect(dialog).not.toBeNull()
  expect(dialog.open).toBe(true)
  shadow.querySelector<HTMLElement>('[role="status"]')!.textContent = '已保存'
  shadow.querySelector<HTMLButtonElement>('[data-close]')!.click()
  expect(dialog.open).toBe(false)
  shadow.querySelector<HTMLButtonElement>('[data-launch]')!.click()
  expect(dialog.open).toBe(true)
  expect(shadow.querySelector('[role="status"]')?.textContent).toBe('已保存')
})

it('explains missing data without calling a selected range unrefreshed or saving', async () => {
  vi.spyOn(capture, 'waitForThreeMonthCapture').mockResolvedValue({
    rangeSelected: true,
    capture: null,
    missing: ['impressions'],
  })
  const send = vi.spyOn(messaging, 'sendMessage')
  shadow.querySelector<HTMLButtonElement>('[data-capture]')!.click()
  await vi.waitFor(() =>
    expect(shadow.querySelector('[role="status"]')?.textContent).toContain(
      '曝光量',
    ),
  )
  expect(shadow.querySelector('[role="status"]')?.textContent).not.toContain(
    '尚未刷新',
  )
  expect(send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'save-x-analytics' }),
  )
})

it('keeps an in-flight capture disabled across close and reopen, then shows success', async () => {
  let finish!: (result: capture.ThreeMonthCaptureResult) => void
  vi.spyOn(capture, 'waitForThreeMonthCapture').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const send = vi
    .spyOn(messaging, 'sendMessage')
    .mockImplementation(async (message) => {
      if (message.type === 'get-x-analytics-status')
        return {
          type: 'x-analytics-status',
          twitterUserId: 'demo-id',
          twitterUsername: 'demo_kol',
          completed: false,
        }
      return {
        type: 'x-analytics-save-result',
        ok: true,
        savedAt: new Date().toISOString(),
      }
    })
  const button = shadow.querySelector<HTMLButtonElement>('[data-capture]')!
  button.click()
  expect(button.disabled).toBe(true)
  shadow.querySelector<HTMLButtonElement>('[data-close]')!.click()
  shadow.querySelector<HTMLButtonElement>('[data-launch]')!.click()
  button.click()
  expect(capture.waitForThreeMonthCapture).toHaveBeenCalledTimes(1)
  finish({
    rangeSelected: true,
    missing: [],
    capture: {
      twitterUsername: 'demo_kol',
      metrics: {
        impressions: 11900,
        engagementRate: 0.015,
        engagements: 185,
        profileVisits: 18,
        replies: 90,
        likes: 56,
        reposts: 3,
        bookmarks: 18,
        shares: 0,
        verifiedFollowers: 631,
        followers: 2100,
        activeFollowers: 1500,
      },
    },
  })
  await vi.waitFor(() => expect(button.disabled).toBe(false))
  expect(shadow.querySelector('[role="status"]')?.textContent).toContain(
    '已保存到 KOL 资料',
  )
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'save-x-analytics',
      twitterUsername: 'demo_kol',
    }),
  )
})

it('automatically captures and saves once after a claimed website request, without a second click', async () => {
  document.getElementById('lhdao-x-analytics-capture')!.remove()
  const wait = vi.spyOn(capture, 'waitForThreeMonthCapture').mockResolvedValue({
    rangeSelected: true,
    missing: [],
    capture: {
      twitterUsername: 'demo_kol',
      metrics: {} as capture.XAnalyticsPageCapture['metrics'],
    },
  })
  const send = vi
    .spyOn(messaging, 'sendMessage')
    .mockImplementation(async (message) => {
      if (message.type === 'claim-x-analytics-capture')
        return {
          type: 'x-analytics-auto-capture',
          autoCapture: true,
          twitterUsername: 'demo_kol',
        }
      if (message.type === 'get-x-analytics-status')
        return {
          type: 'x-analytics-status',
          twitterUserId: 'demo-id',
          twitterUsername: 'demo_kol',
          completed: false,
        }
      return {
        type: 'x-analytics-save-result',
        ok: true,
        savedAt: new Date().toISOString(),
      }
    })
  await content.main({} as NonNullable<Parameters<typeof content.main>[0]>)
  expect(wait).toHaveBeenCalledWith(
    expect.objectContaining({ selectRange: true, timeoutMs: 30_000 }),
  )
  expect(
    send.mock.calls.filter(([m]) => m.type === 'save-x-analytics'),
  ).toHaveLength(1)
  expect(shadow.querySelector('[role="status"]')?.textContent).toContain(
    '已保存到 KOL 资料',
  )
})

it('does not save an automatic capture from a different X account', async () => {
  document.getElementById('lhdao-x-analytics-capture')!.remove()
  vi.spyOn(capture, 'waitForThreeMonthCapture').mockResolvedValue({
    rangeSelected: true,
    missing: [],
    capture: {
      twitterUsername: 'wrong',
      metrics: {} as capture.XAnalyticsPageCapture['metrics'],
    },
  })
  const send = vi.spyOn(messaging, 'sendMessage').mockResolvedValue({
    type: 'x-analytics-auto-capture',
    autoCapture: true,
    twitterUsername: 'demo_kol',
  })
  await content.main({} as NonNullable<Parameters<typeof content.main>[0]>)
  expect(send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'save-x-analytics' }),
  )
  expect(shadow.querySelector('[role="status"]')?.textContent).toContain(
    '请切换到申请账号 @demo_kol',
  )
})
