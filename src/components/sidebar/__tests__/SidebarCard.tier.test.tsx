import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import * as messaging from '@/lib/messaging'
import { SidebarCard } from '../SidebarCard'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  fakeBrowser.reset()
  Object.assign(globalThis, {
    chrome: fakeBrowser,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  vi.spyOn(messaging, 'sendMessage').mockResolvedValue({
    type: 'sidebar-data',
    tokenConfigured: true,
    tweetCampaigns: [],
    lighthouseSelectedStatus: 'available',
    profile: {
      id: 'user-1',
      displayName: 'Tester',
      avatar: null,
      twitterHandle: 'tester',
      tier: 'F',
      newLux: 0,
      todayEarnings: 0,
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

it('shows F tier as D- in both sidebar labels', async () => {
  await act(async () => root.render(<SidebarCard />))
  expect(container.querySelector('.lh-tier-chip')?.textContent).toBe('TIER D-')
  expect(
    container.querySelector('.lh-foot-cell:last-child .lh-foot-value')
      ?.textContent,
  ).toBe('D-')
})
