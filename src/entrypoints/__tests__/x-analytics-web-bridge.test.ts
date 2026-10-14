import { afterEach, expect, it, vi } from 'vitest'
import content from '../web-presence.content'

afterEach(() => vi.restoreAllMocks())
it('forwards a same-window Lighthouse request without exposing analytics or tokens', async () => {
  let listener!: (event: MessageEvent) => void
  vi.spyOn(window, 'addEventListener').mockImplementation((type, fn) => {
    if (type === 'message') listener = fn as typeof listener
  })
  const send = vi
    .spyOn(chrome.runtime, 'sendMessage')
    .mockResolvedValue({ type: 'x-analytics-start-result', ok: true })
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  content.main({ onInvalidated: vi.fn() } as unknown as NonNullable<
    Parameters<typeof content.main>[0]
  >)
  const data = {
    __lhdaoExtQuery__: 'start-x-analytics',
    id: 'capture-1',
    twitterUsername: 'creator',
  }
  listener(
    new MessageEvent('message', {
      origin: 'https://evil.test',
      source: window,
      data,
    }),
  )
  expect(send).not.toHaveBeenCalled()
  listener(
    new MessageEvent('message', {
      origin: 'https://app.lhdao.top',
      source: window,
      data,
    }),
  )
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        __lhdaoExtResult__: 'start-x-analytics',
        id: 'capture-1',
        ok: true,
      }),
      window.location.origin,
    ),
  )
  expect(send).toHaveBeenCalledWith({
    type: 'start-x-analytics-capture',
    twitterUsername: 'creator',
  })
})
