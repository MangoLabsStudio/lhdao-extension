import { afterEach, expect, it, vi } from 'vitest'
import { ANALYTICS_EVENT } from '../x-analytics-network'
import { installAnalyticsNetworkObserver } from '../x-analytics-network-observer'

afterEach(() => vi.restoreAllMocks())
it('preserves the original fetch response and only forwards matched analytics errors', async () => {
  const to = Math.floor(Date.now() / 86400000) * 86400000 + 86400000
  const vars = {
    current_from: to - 90 * 86400000,
    current_to: to,
    show_verified_followers: true,
  }
  const url = `https://api.x.com/graphql/id/accountOverviewDailyQuery?variables=${encodeURIComponent(JSON.stringify(vars))}`
  const original = window.fetch
  const response = new Response(
    JSON.stringify({ errors: [{ message: 'private error detail' }] }),
    { status: 403 },
  )
  const fetch = vi.fn().mockResolvedValue(response)
  window.fetch = fetch
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  const cleanup = installAnalyticsNetworkObserver(() => true)
  try {
    expect(await window.fetch(url)).toBe(response)
    await vi.waitFor(() => expect(post).toHaveBeenCalled())
    expect(post.mock.calls[0][0]).toMatchObject({
      type: ANALYTICS_EVENT,
      result: { ok: false, code: 'HTTP_403' },
    })
    expect(JSON.stringify(post.mock.calls)).not.toContain(
      'private error detail',
    )
    expect(await response.json()).toHaveProperty('errors')
    post.mockClear()
    await window.fetch('https://api.x.com/1.1/graphql/app_context.json')
    expect(post).not.toHaveBeenCalled()
  } finally {
    cleanup()
    window.fetch = original
  }
})
it('does not observe requests outside the analytics page', async () => {
  const original = window.fetch
  window.fetch = vi.fn().mockResolvedValue(new Response('{}'))
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  const cleanup = installAnalyticsNetworkObserver(() => false)
  try {
    await window.fetch('https://api.x.com/graphql/id/accountOverviewDailyQuery')
    expect(post).not.toHaveBeenCalled()
  } finally {
    cleanup()
    window.fetch = original
  }
})

it('observes XHR errors without changing the sent body or exposing response details', () => {
  const to = (Math.floor(Date.now() / 86400000) + 1) * 86400000
  const body = JSON.stringify({
    variables: {
      current_from: to - 90 * 86400000,
      current_to: to,
      show_verified_followers: true,
    },
  })
  const open = vi
    .spyOn(XMLHttpRequest.prototype, 'open')
    .mockImplementation(() => {})
  const send = vi
    .spyOn(XMLHttpRequest.prototype, 'send')
    .mockImplementation(() => {})
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  const cleanup = installAnalyticsNetworkObserver(() => true)
  try {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', 'https://x.com/i/api/graphql/id/accountOverviewDailyQuery')
    xhr.send(body)
    Object.defineProperty(xhr, 'status', { value: 429 })
    Object.defineProperty(xhr, 'responseText', {
      value: '{"private":"do not forward"}',
    })
    xhr.dispatchEvent(new Event('loadend'))
    expect(open).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(body)
    expect(post.mock.calls[0][0]).toMatchObject({
      result: { ok: false, code: 'HTTP_429' },
    })
    expect(JSON.stringify(post.mock.calls)).not.toContain('do not forward')
  } finally {
    cleanup()
  }
})
