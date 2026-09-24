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
let unmountAll: typeof import('../content').unmountAll

vi.mock('@/lib/dwell-tracker', () => ({
  initDwellTracker: () => {},
  onDwellUrlChange: () => {},
}))

const timelineTask: CampaignTaskCache = {
  campaignId: 'timeline-like',
  tweetId: '123456',
  actionType: 'LIKE',
  expectedReward: 2,
  timelineOnly: true,
}

const reservedTimelineTask: CampaignTaskCache = {
  ...timelineTask,
  campaignId: 'timeline-like-reserved',
  reserved: true,
}

const normalTask: CampaignTaskCache = {
  campaignId: 'normal-like',
  tweetId: '123456',
  actionType: 'LIKE',
  expectedReward: 1,
}

beforeAll(async () => {
  Object.assign(globalThis, {
    chrome: fakeBrowser,
    defineContentScript: <T>(config: T) => config,
  })
  ;({ scanTimeline, unmountAll } = await import('../content'))
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

function claimButton(): HTMLButtonElement | null | undefined {
  return document
    .querySelector('.lhdao-inline-task')
    ?.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-testid="timeline-reserve-button"]',
    )
}

function mockSnapshot(tasks: CampaignTaskCache[]): void {
  vi.spyOn(messaging, 'sendMessage').mockImplementation(async (req) => {
    if (req.type === 'get-tasks-snapshot') {
      return {
        type: 'tasks-snapshot',
        byTweet: { '123456': tasks },
        byAuthor: {},
        ready: true,
      }
    }
    if (req.type === 'get-captured-actions') {
      return { type: 'captured-actions', actions: [] }
    }
    if (req.type === 'reserve-task') {
      return { type: 'reserve-result', ok: true }
    }
    return { type: 'ack' }
  })
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
})

afterEach(async () => {
  await act(async () => unmountAll())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('timelineOnly claim button in current-task panel', () => {
  it('renders 领取任务 for an unreserved timelineOnly task and claims via reserve-task', async () => {
    mockSnapshot([timelineTask])
    await act(async () => scanTimeline())

    const btn = claimButton()
    expect(btn).not.toBeNull()
    expect(btn?.textContent).toContain('领取任务')

    await act(async () => {
      btn?.click()
    })

    const send = messaging.sendMessage as unknown as ReturnType<typeof vi.fn>
    const types = send.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain('reserve-task')
    const reserveCall = send.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'reserve-task',
    )
    expect((reserveCall?.[0] as { campaignId: string }).campaignId).toBe(
      'timeline-like',
    )
    // 领取成功后 force-sync 触发 tasks-updated 回拉,卡片切到检测态。
    expect(types).toContain('force-sync')
  })

  it('shows the offered tier and reward, then explicitly confirms that exact tier', async () => {
    mockSnapshot([timelineTask])
    const send = vi.mocked(messaging.sendMessage)
    const original = send.getMockImplementation()!
    send.mockImplementation(async (req) => {
      if (req.type === 'reserve-task' && !req.confirmCascade)
        return {
          type: 'reserve-result',
          ok: false,
          code: 'RESERVE_FAILED',
          message: '请确认降档',
          cascadeWarning: {
            userTier: 'A',
            effectiveTier: 'B',
            userTierRewardLux: 20,
            effectiveTierRewardLux: 13.5,
          },
        }
      return original(req)
    })
    await act(async () => scanTimeline())
    await act(async () => claimButton()?.click())
    expect(claimButton()?.textContent).toContain('B')
    expect(panel()?.textContent).toContain('13.5')
    await act(async () => claimButton()?.click())
    expect(send).toHaveBeenCalledWith({
      type: 'reserve-task',
      campaignId: 'timeline-like',
      confirmCascade: true,
      confirmedCascadeTier: 'B',
    })
  })

  it('shows the verify button (not claim) once the timelineOnly task is reserved', async () => {
    mockSnapshot([reservedTimelineTask])
    await act(async () => scanTimeline())

    expect(claimButton()).toBeNull()
    expect(panel()?.textContent).toContain('完成上面步骤解锁')
  })

  it('does not render a verification panel for an unreserved normal task', async () => {
    mockSnapshot([normalTask])
    await act(async () => scanTimeline())

    expect(claimButton()).toBeNull()
    expect(panel() ?? null).toBeNull()
  })
})
