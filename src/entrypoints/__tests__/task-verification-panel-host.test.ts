import { act } from 'react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import * as messaging from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'

let scanTimeline: typeof import('../content').scanTimeline
let startFocalTaskHostRecovery: typeof import('../content').startFocalTaskHostRecovery
let unmountAll: typeof import('../content').unmountAll
let stopRecovery: (() => void) | undefined

vi.mock('@/lib/dwell-tracker', () => ({
  initDwellTracker: () => {},
  onDwellUrlChange: () => {},
}))

const task: CampaignTaskCache = {
  campaignId: 'reserved-comment',
  tweetId: '123456',
  actionType: 'COMMENT',
  expectedReward: 1,
  reserved: true,
}

beforeAll(async () => {
  Object.assign(globalThis, {
    chrome: fakeBrowser,
    defineContentScript: <T>(config: T) => config,
  })
  ;({ scanTimeline, startFocalTaskHostRecovery, unmountAll } = await import(
    '../content'
  ))
})

function renderTweet(): void {
  document.body.innerHTML =
    '<article><a href="/user/status/123456"><time>Now</time></a><div data-controls><div role="group"><button data-testid="reply">Reply</button></div></div></article>'
}

function panel(): Element | null | undefined {
  return document
    .querySelector('.lhdao-inline-task')
    ?.shadowRoot?.querySelector('section')
}

beforeEach(() => {
  fakeBrowser.reset()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.history.replaceState({}, '', '/user/status/123456')
  renderTweet()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 500,
    height: 200,
  } as DOMRect)
  vi.spyOn(messaging, 'sendMessage').mockImplementation(async (req) => {
    if (req.type === 'get-tasks-snapshot') {
      return {
        type: 'tasks-snapshot',
        byTweet: { '123456': [task] },
        byAuthor: {},
        ready: true,
      }
    }
    if (req.type === 'get-captured-actions') {
      return { type: 'captured-actions', actions: [] }
    }
    return { type: 'ack' }
  })
})

afterEach(async () => {
  stopRecovery?.()
  stopRecovery = undefined
  await act(async () => unmountAll())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('focused tweet verification panel host', () => {
  it('reattaches the same panel after X replaces the action controls', async () => {
    await act(async () => scanTimeline())
    const host = document.querySelector('.lhdao-inline-task')
    const section = panel()
    expect(section?.textContent).toContain('评论')

    const controls = document.querySelector('[data-controls]')
    expect(controls).not.toBeNull()
    if (controls) {
      controls.innerHTML =
        '<div role="group"><button data-testid="reply">Reply</button></div>'
    }
    expect(host?.isConnected).toBe(false)

    await act(async () => scanTimeline())

    expect(document.querySelector('.lhdao-inline-task')).toBe(host)
    expect(panel()).toBe(section)
  })

  it('mounts when the action controls arrive after the first scan', async () => {
    const controls = document.querySelector('[data-controls]')
    expect(controls).not.toBeNull()
    if (controls) controls.innerHTML = ''

    await act(async () => scanTimeline())
    expect(document.querySelector('.lhdao-inline-task')).toBeNull()

    if (controls) {
      controls.innerHTML =
        '<div role="group"><button data-testid="reply">Reply</button></div>'
    }
    await act(async () => scanTimeline())

    expect(panel()?.textContent).toContain('评论')
  })

  it('mounts beside X action buttons when role=group is absent', async () => {
    document.body.innerHTML =
      '<article><a href="/user/status/123456"><time>Now</time></a><div data-controls><button data-testid="reply">Reply</button><button data-testid="like">Like</button></div></article>'

    await act(async () => scanTimeline())

    expect(panel()?.textContent).toContain('评论')
  })

  it('restores a detached host while the focused route stays open', async () => {
    vi.useFakeTimers()
    await act(async () => scanTimeline())
    const host = document.querySelector('.lhdao-inline-task')
    expect(host).not.toBeNull()
    host?.remove()

    stopRecovery = startFocalTaskHostRecovery()
    await act(async () => vi.advanceTimersByTime(2_000))

    expect(document.querySelector('.lhdao-inline-task')).toBe(host)
  })

  it('removes the panel after leaving the tweet detail route', async () => {
    await act(async () => scanTimeline())
    expect(panel()).not.toBeNull()

    window.history.replaceState({}, '', '/home')
    await act(async () => scanTimeline())

    expect(document.querySelector('.lhdao-inline-task')).toBeNull()
  })
})
