import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'

const send = vi.hoisted(() => vi.fn())
vi.mock('@/lib/messaging', () => ({ sendMessage: send }))
const key = 'x-analytics-request:20'
let state: Record<string, unknown>
beforeEach(async () => {
  vi.resetModules()
  fakeBrowser.reset()
  vi.useFakeTimers()
  send.mockReset()
  window.history.replaceState(null, '', '/?tabId=20')
  document.body.innerHTML = readFileSync(
    'src/entrypoints/analytics-capture/index.html',
    'utf8',
  )
    .split('<body>')[1]
    .split('</body>')[0]
    .replace(/<script[\s\S]*?<\/script>/g, '')
  const to = (Math.floor(Date.now() / 86400000) + 1) * 86400000
  state = {
    runId: 'r1',
    phase: 'retrying',
    message: '缺少部分数据',
    attempt: 1,
    retryAt: Date.now() + 3000,
    deadline: Date.now() + 90000,
    expiresAt: Date.now() + 600000,
    claimed: true,
    twitterUsername: 'demo',
    preview: {
      twitterUserId: '123',
      from: to - 90 * 86400000,
      to,
      metrics: { followers: 100, likes: 0 },
    },
  }
  await chrome.storage.session.set({ [key]: state })
  send.mockImplementation(async () => {
    state = { ...state, phase: 'loading', attempt: 2 }
    await chrome.storage.session.set({ [key]: state })
    return { type: 'ack' }
  })
  await import('../analytics-capture/main')
  await vi.advanceTimersByTimeAsync(0)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('shows retained values and missing values separately then automatically retries once', async () => {
  expect(document.querySelector('#metrics')?.textContent).toContain(
    '曝光量待获取',
  )
  expect(document.querySelector('#metrics')?.textContent).toContain('点赞0')
  expect(document.querySelector('#recovery')?.textContent).toContain(
    '3 秒后自动重试',
  )
  await vi.advanceTimersByTimeAsync(3000)
  expect(send).toHaveBeenCalledExactlyOnceWith({
    type: 'x-analytics-window-action',
    tabId: 20,
    action: 'auto-retry',
  })
  expect(document.querySelector('#metrics')?.textContent).toContain(
    '关注者总数100',
  )
})
it('stops at the retry limit and keeps data visible for manual recovery', async () => {
  await chrome.storage.session.set({
    [key]: { ...state, phase: 'error', attempt: 3 },
  })
  await vi.advanceTimersByTimeAsync(4000)
  expect(send).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLButtonElement>('#retry')?.hidden).toBe(
    false,
  )
  expect(document.querySelector('#recovery')?.textContent).toContain(
    '已尝试 3 次',
  )
  expect(document.querySelector('#metrics')?.textContent).toContain(
    '关注者总数100',
  )
})
it('does not retry an expired or removed session', async () => {
  await chrome.storage.session.remove(key)
  await vi.advanceTimersByTimeAsync(4000)
  expect(send).not.toHaveBeenCalled()
  expect(document.querySelector('#phase')?.textContent).toBe('采集已结束')
})

it('labels a retained value as pending update when the new response lacks it', async () => {
  await chrome.storage.session.set({
    [key]: { ...state, missing: ['followers'] },
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('#metrics')?.textContent).toContain(
    '100 · 待更新',
  )
  expect(document.querySelector('#missing')?.textContent).toContain(
    '待获取：关注者总数',
  )
})
