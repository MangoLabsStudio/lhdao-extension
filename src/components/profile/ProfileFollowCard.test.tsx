import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sendMessage } from '@/lib/messaging'
import { ProfileFollowCard } from './ProfileFollowCard'

vi.mock('@/lib/messaging', () => ({ sendMessage: vi.fn() }))
let host: HTMLDivElement
let root: Root
const props = {
  campaignId: 'follow-1',
  targetHandle: 'bundlessapp',
  reward: 11.4,
  reserved: false,
  followButtonPresent: false,
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.mocked(sendMessage).mockReset().mockResolvedValue({ type: 'ack' })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
it('opens the website instead of calling the forbidden reservation endpoint', async () => {
  await act(async () => root.render(<ProfileFollowCard {...props} />))
  expect(host.textContent).toContain('返回任务页预订')
  await act(async () => host.querySelector('button')!.click())
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'open-campaign',
    campaignId: 'follow-1',
  })
})
it('uses updated reservation props and the signed proof verification flow', async () => {
  await act(async () => root.render(<ProfileFollowCard {...props} />))
  await act(async () => root.render(<ProfileFollowCard {...props} reserved />))
  expect(host.textContent).toContain('我已关注，验证')
  vi.mocked(sendMessage).mockResolvedValue({
    type: 'verify-result',
    ok: true,
    reward: 0,
  })
  await act(async () => host.querySelector('button')!.click())
  expect(sendMessage).toHaveBeenCalledWith({
    type: 'verify-task',
    campaignId: 'follow-1',
  })
  expect(sendMessage).not.toHaveBeenCalledWith({
    type: 'reserve-task',
    campaignId: 'follow-1',
  })
  await act(async () =>
    root.render(<ProfileFollowCard {...props} reserved={false} />),
  )
  expect(host.textContent).not.toContain('我已关注，验证')
})

it('allows retry when the website cannot be opened', async () => {
  vi.mocked(sendMessage).mockResolvedValue({
    type: 'submit-result',
    ok: false,
    code: 'INTERNAL',
    message: 'failed',
  })
  await act(async () => root.render(<ProfileFollowCard {...props} />))
  await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).toContain('任务页打开失败，请重试')
  expect(host.querySelector('button')!.disabled).toBe(false)
})
it('disables verification while reservation sync is in flight', async () => {
  await act(async () =>
    root.render(<ProfileFollowCard {...props} reserved syncing />),
  )
  expect(host.textContent).toContain('同步接单状态')
  await act(async () => host.querySelector('button')!.click())
  expect(sendMessage).not.toHaveBeenCalled()
})

it('preserves the signed plugin reservation route for timeline-only tasks', async () => {
  const refresh = vi.fn()
  vi.mocked(sendMessage).mockResolvedValue({ type: 'reserve-result', ok: true })
  await act(async () =>
    root.render(
      <ProfileFollowCard {...props} timelineOnly onRefresh={refresh} />,
    ),
  )
  await act(async () => host.querySelector('button')!.click())
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
    type: 'reserve-task',
    campaignId: 'follow-1',
  })
  expect(refresh).toHaveBeenCalledOnce()
})
