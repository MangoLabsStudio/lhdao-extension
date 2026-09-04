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
})
