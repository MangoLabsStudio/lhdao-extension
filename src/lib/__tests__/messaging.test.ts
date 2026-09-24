import { afterEach, describe, expect, it, vi } from 'vitest'
import { broadcastToContent } from '../messaging'

vi.mock('../env', () => ({
  WEB_MATCH_PATTERN: 'https://app.example/*',
}))

describe('broadcastToContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('broadcasts task updates to X and Twitter only', () => {
    const sendMessage = vi.fn(() => Promise.resolve())
    const query = vi.fn((_query, callback) => callback([{ id: 7 }]))
    vi.stubGlobal('chrome', { tabs: { query, sendMessage } })

    broadcastToContent({ type: 'tasks-updated' })

    expect(query).toHaveBeenCalledWith(
      {
        url: ['*://x.com/*', '*://twitter.com/*'],
      },
      expect.any(Function),
    )
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'tasks-updated' })
  })
})
