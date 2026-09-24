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
let tokenConfigured: boolean
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
  tokenConfigured = true
  vi.spyOn(messaging, 'sendMessage').mockImplementation(async (req) => {
    if (req.type === 'get-tasks-snapshot')
      return {
        type: 'tasks-snapshot',
        byTweet: { '123456': rows },
        byAuthor: {},
        ready: !syncFailed,
        syncFailed,
        tokenConfigured,
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
  it('restores the LIKE verification panel after X replaces the action area', async () => {
    rows = [
      {
        campaignId: 'reserved-like',
        tweetId: '123456',
        actionType: 'LIKE',
        expectedReward: 1,
        reserved: true,
      },
    ]
    await act(async () => scanTimeline())
    const host = document.querySelector('.lhdao-inline-task')!
    const section = panel()
    expect(section?.textContent).toContain('点赞')
    vi.mocked(messaging.sendMessage).mockClear()

    // X keeps the article but replaces its controls after a local update.
    const controls = document.querySelector('[role="group"]')!.parentElement!
    controls.innerHTML =
      '<div role="group"><button data-testid="unlike">Unlike</button></div>'
    expect(host.isConnected).toBe(false)
    await act(async () => scanTimeline())

    expect(document.querySelector('.lhdao-inline-task')).toBe(host)
    expect(panel()).toBe(section)
    expect(panel()?.textContent).toContain('点赞')
    expect(messaging.sendMessage).not.toHaveBeenCalledWith({
      type: 'force-sync',
    })
    await act(async () => scanTimeline())
    expect(document.querySelectorAll('.lhdao-inline-task')).toHaveLength(1)
  })

  it('keeps the task panel below the main tweet when an ad follows it', async () => {
    rows = [
      {
        campaignId: 'reserved-like',
        tweetId: '123456',
        actionType: 'LIKE',
        expectedReward: 1,
        reserved: true,
      },
    ]
    document.body.innerHTML = `
      <article id="main"><div data-testid="User-Name"><a role="link" href="/user">User</a></div><div role="group"><button data-testid="like">Like</button></div></article>
      <article id="ad"><div data-testid="User-Name"><a role="link" href="/advertiser">Advertiser</a></div><div role="group"><button data-testid="like">Like</button></div></article>`
    await act(async () => scanTimeline())
    const host = document.querySelector('.lhdao-inline-task')
    expect(host).not.toBeNull()
    expect(document.querySelector('#main')?.contains(host)).toBe(true)
    expect(document.querySelector('#ad')?.contains(host)).toBe(false)
  })

  it('preserves the panel across a temporary missing article and full DOM replacement', async () => {
    rows = [
      {
        campaignId: 'like',
        tweetId: '123456',
        actionType: 'LIKE',
        expectedReward: 1,
        reserved: true,
      },
    ]
    await act(async () => scanTimeline())
    const host = document.querySelector('.lhdao-inline-task')!
    const section = panel()
    const article = document.querySelector('article')!
    const replacement = article.cloneNode(true) as Element
    replacement.querySelector('.lhdao-inline-task')?.remove()
    article.remove()
    await act(async () => scanTimeline())
    expect(document.querySelector('.lhdao-inline-task')).toBeNull()
    document.body.append(replacement)
    await act(async () => scanTimeline())
    expect(document.querySelector('.lhdao-inline-task')).toBe(host)
    expect(panel()).toBe(section)
    window.history.replaceState({}, '', '/user/status/654321')
    replacement.querySelector('a')!.setAttribute('href', '/user/status/654321')
    await act(async () => scanTimeline())
    expect(document.querySelector('.lhdao-inline-task')).not.toBe(host)
    expect(panel()).toBeNull()
  })

  it('waits for late action controls and recovers after they disappear temporarily', async () => {
    rows = [
      {
        campaignId: 'like',
        tweetId: '123456',
        actionType: 'LIKE',
        expectedReward: 1,
        reserved: true,
      },
    ]
    const controls = document.querySelector('[role="group"]')!.parentElement!
    controls.innerHTML = ''
    await act(async () => scanTimeline())
    expect(document.querySelector('.lhdao-inline-task')).toBeNull()
    controls.innerHTML =
      '<div role="group"><button data-testid="like">Like</button></div>'
    await act(async () => scanTimeline())
    const host = document.querySelector('.lhdao-inline-task')!
    expect(panel()?.textContent).toContain('点赞')
    controls.innerHTML = ''
    await act(async () => scanTimeline())
    controls.innerHTML =
      '<div role="group"><button data-testid="unlike">Unlike</button></div>'
    await act(async () => scanTimeline())
    expect(document.querySelector('.lhdao-inline-task')).toBe(host)
  })

  it('recovers silently on a cold empty snapshot and first-sync failure', async () => {
    syncFailed = true
    await act(async () => scanTimeline())
    expect(panel()).toBeNull()
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
    expect(document.querySelector('.lhdao-inline-task')).not.toBeNull()
    window.history.replaceState({}, '', '/home')
    await act(async () => scanTimeline())
    expect(document.querySelector('.lhdao-inline-task')).toBeNull()
  })

  it('keeps an empty snapshot hidden during the reservation arrival window', async () => {
    await act(async () => scanTimeline())
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'force-sync' })
    expect(panel()).toBeNull()
    expect(
      document.querySelector('article')?.hasAttribute('data-lhdao-active'),
    ).toBe(false)
  })

  it('keeps signed-out task UI hidden', async () => {
    tokenConfigured = false
    await act(async () => scanTimeline())
    expect(panel()).toBeNull()
    expect(
      document.querySelector('article')?.hasAttribute('data-lhdao-active'),
    ).toBe(false)
  })
})
