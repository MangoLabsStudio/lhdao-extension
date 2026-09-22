import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import * as messaging from '@/lib/messaging'
import { SidebarCard } from './SidebarCard'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fakeBrowser.reset()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(messaging, 'sendMessage').mockResolvedValue({
    type: 'sidebar-data',
    tokenConfigured: true,
    lighthouseSelectedStatus: 'available',
    tweetCampaigns: [],
    profile: {
      id: 'user-1',
      displayName: 'Alice',
      avatar: null,
      twitterHandle: 'alice',
      tier: 'A',
      newLux: 10,
      todayEarnings: 1,
      lighthouseSelected: true,
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('Lighthouse Selected sidebar identity', () => {
  it('shows a pure-text current identity only for confirmed true', async () => {
    await act(async () => root.render(<SidebarCard />))
    await vi.waitFor(() => expect(container.textContent).toContain('灯塔严选'))
    const label = Array.from(container.querySelectorAll('span')).find(
      (node) => node.textContent === '灯塔严选',
    )
    expect(label?.querySelector('svg')).toBeNull()
    expect(label?.className).toContain('lh-selected-text')
  })

  it.each([
    ['loading', '资格确认中'],
    ['unavailable', '严选资格暂时无法确认'],
  ] as const)('renders the %s qualification state without marking it false', async (status, label) => {
    vi.mocked(messaging.sendMessage).mockResolvedValueOnce({
      type: 'sidebar-data',
      tokenConfigured: true,
      lighthouseSelectedStatus: status,
      tweetCampaigns: [],
      profile: {
        id: 'user-1',
        displayName: 'Alice',
        avatar: null,
        twitterHandle: 'alice',
        tier: 'A',
        newLux: 10,
        todayEarnings: 1,
      },
    })
    await act(async () => root.render(<SidebarCard />))
    await vi.waitFor(() => expect(container.textContent).toContain(label))
    expect(container.textContent).not.toContain('灯塔严选')
  })

  it('keeps a confirmed false qualification visually unmarked', async () => {
    vi.mocked(messaging.sendMessage).mockResolvedValueOnce({
      type: 'sidebar-data',
      tokenConfigured: true,
      lighthouseSelectedStatus: 'available',
      tweetCampaigns: [],
      profile: {
        id: 'user-1',
        displayName: 'Alice',
        avatar: null,
        twitterHandle: 'alice',
        tier: 'A',
        newLux: 10,
        todayEarnings: 1,
        lighthouseSelected: false,
      },
    })
    await act(async () => root.render(<SidebarCard />))
    await vi.waitFor(() => expect(container.textContent).toContain('Alice'))
    expect(container.querySelector('.lh-selected-text')).toBeNull()
  })

  it('renders selected scope once when an available Tweet task is selected-only', async () => {
    vi.mocked(messaging.sendMessage).mockResolvedValueOnce({
      type: 'sidebar-data',
      tokenConfigured: true,
      lighthouseSelectedStatus: 'available',
      profile: null,
      tweetCampaigns: [
        {
          campaignId: 'ordinary',
          projectName: '普通任务',
          brief: null,
          rewardLux: 1,
          submitClose: null,
          targetUrl: null,
          lighthouseSelectedOnly: false,
        },
        {
          campaignId: 'selected',
          projectName: '严选任务',
          brief: null,
          rewardLux: 2,
          submitClose: null,
          targetUrl: null,
          lighthouseSelectedOnly: true,
        },
      ],
    })
    await act(async () => root.render(<SidebarCard />))
    await vi.waitFor(() =>
      expect(container.textContent).toContain('仅灯塔严选可接'),
    )
    expect(container.textContent?.match(/仅灯塔严选可接/g)).toHaveLength(1)
  })
})
