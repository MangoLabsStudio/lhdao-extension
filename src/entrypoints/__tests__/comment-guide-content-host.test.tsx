import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import * as messaging from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'
import { scanTimeline, unmountAll } from '../content'

vi.mock('@/lib/dwell-tracker', () => ({
  initDwellTracker: () => {},
  onDwellUrlChange: () => {},
}))

let rows: CampaignTaskCache[]
let syncFailed: boolean
beforeEach(() => {
  fakeBrowser.reset()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.history.replaceState({}, '', '/user/status/123456')
  document.body.innerHTML =
    '<article><a href="/user/status/123456"><time>Now</time></a><div><div role="group"><button data-testid="reply">Reply</button></div></div></article>'
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 500,
    height: 200,
  } as DOMRect)
  rows = []
  syncFailed = false
  vi.spyOn(messaging, 'sendMessage').mockImplementation(async (req) => {
    if (req.type === 'get-tasks-snapshot')
      return {
        type: 'tasks-snapshot',
        byTweet: { '123456': rows },
        byAuthor: {},
        ready: !syncFailed,
        syncFailed,
      }
    if (req.type === 'get-captured-actions')
      return { type: 'captured-actions', actions: [] }
    return { type: 'ack' }
  })
})
afterEach(async () => {
  await act(async () => unmountAll())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})
const panel = () =>
  document
    .querySelector('.lhdao-inline-task')
    ?.shadowRoot?.querySelector('section')

describe('content script focal task host', () => {
  it('mounts on a cold empty snapshot and displays first-sync failure', async () => {
    syncFailed = true
    await act(async () => scanTimeline())
    expect(panel()?.textContent ?? '').toContain('评论引导暂时无法加载')
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'force-sync' })
    vi.mocked(messaging.sendMessage).mockClear()
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'force-sync' })
    vi.mocked(messaging.sendMessage).mockClear()
    await act(async () => window.dispatchEvent(new Event('pageshow')))
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'force-sync' })
  })

  it('finds a newly reserved task on initial forced synchronization', async () => {
    const previous = vi.mocked(messaging.sendMessage).getMockImplementation()!
    vi.mocked(messaging.sendMessage).mockImplementation(async (req) => {
      if (req.type === 'force-sync')
        rows = [
          {
            campaignId: 'just-reserved',
            tweetId: '123456',
            actionType: 'COMMENT',
            expectedReward: 1,
            reserved: true,
            commentGuide: '刚接单的方向',
            commentGuideStatus: 'ready',
          },
        ]
      return previous(req)
    })
    await act(async () => scanTimeline())
    expect(panel()?.textContent ?? '').toContain('刚接单的方向')
  })

  it('unmounts the focal task panel when leaving the detail page', async () => {
    syncFailed = true
    await act(async () => scanTimeline())
    expect(panel()).not.toBeNull()
    window.history.replaceState({}, '', '/home')
    await act(async () => scanTimeline())
    expect(document.querySelector('.lhdao-inline-task')).toBeNull()
  })

  it('keeps confirmed empty or signed-out task UI hidden', async () => {
    await act(async () => scanTimeline())
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'force-sync' })
    expect(panel()).toBeNull()
    expect(
      document.querySelector('article')?.hasAttribute('data-lhdao-active'),
    ).toBe(false)
  })
})
