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

  it('broadcasts product state changes only to the configured Lighthouse origin', () => {
    const sendMessage = vi.fn(() => Promise.resolve())
    const query = vi.fn((_query, callback) => callback([{ id: 7 }, { id: 8 }]))
    vi.stubGlobal('chrome', { tabs: { query, sendMessage } })

    broadcastToContent({ type: 'product-experience-state-changed' })

    expect(query).toHaveBeenCalledWith(
      { url: ['https://app.example/*'] },
      expect.any(Function),
    )
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenNthCalledWith(1, 7, {
      type: 'product-experience-state-changed',
    })
    expect(sendMessage).toHaveBeenNthCalledWith(2, 8, {
      type: 'product-experience-state-changed',
    })
  })

  it('keeps engagement task broadcasts scoped to X and Twitter', () => {
    const sendMessage = vi.fn(() => Promise.resolve())
    const query = vi.fn((_query, callback) => callback([{ id: 7 }]))
    vi.stubGlobal('chrome', { tabs: { query, sendMessage } })

    broadcastToContent({ type: 'tasks-updated' })

    expect(query).toHaveBeenCalledWith(
      { url: ['*://x.com/*', '*://twitter.com/*'] },
      expect.any(Function),
    )
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'tasks-updated' })
  })
})
