import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as messaging from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'
import type { MsgResponse } from '@/types/messages'
import {
  refreshFollowTaskSnapshot,
  refreshTasksSnapshot,
  scanProfileFollowTask,
  unmountAll,
} from '../content'

vi.mock('@/lib/dwell-tracker', () => ({
  initDwellTracker: () => {},
  onDwellUrlChange: () => {},
}))
let rows: CampaignTaskCache[]
let syncFailed: boolean
const task = (id: string, reserved = false): CampaignTaskCache => ({
  campaignId: id,
  tweetId: '',
  actionType: 'FOLLOW',
  targetUsername: 'bundlessapp',
  expectedReward: 11.4,
  reserved,
})
const card = () => document.querySelector('.lhdao-follow-card')?.shadowRoot
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.history.replaceState({}, '', '/Bundlessapp')
  document.body.innerHTML =
    '<main data-testid="primaryColumn"><div><div data-testid="UserName">Bundless</div></div><button data-testid="123-follow">Follow</button></main>'
  rows = [task('follow-1')]
  syncFailed = false
  vi.spyOn(messaging, 'sendMessage').mockImplementation(async (req) => {
    if (
      req.type === 'get-tasks-snapshot' ||
      req.type === 'get-current-follow-task-snapshot'
    )
      return {
        type: 'tasks-snapshot',
        byTweet: {},
        byAuthor: { bundlessapp: rows },
        syncFailed,
      }
    return { type: 'ack' }
  })
})
afterEach(async () => {
  await act(async () => unmountAll())
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('refreshes once per profile visit and rerenders reservation changes on the same host', async () => {
  await act(async () => scanProfileFollowTask())
  const host = document.querySelector('.lhdao-follow-card')
  expect(card()?.textContent).toContain('返回任务页预订')
  rows = [task('follow-1', true)]
  await act(async () => refreshTasksSnapshot())
  await act(async () => scanProfileFollowTask())
  expect(document.querySelector('.lhdao-follow-card')).toBe(host)
  expect(card()?.textContent).toContain('我已关注，验证')
  for (let i = 0; i < 5; i++) await act(async () => scanProfileFollowTask())
  expect(
    vi
      .mocked(messaging.sendMessage)
      .mock.calls.filter(
        ([req]) => req.type === 'get-current-follow-task-snapshot',
      ),
  ).toHaveLength(1)
  rows = [task('follow-1', false)]
  await act(async () => refreshTasksSnapshot())
  await act(async () => scanProfileFollowTask())
  expect(card()?.textContent).toContain('返回任务页预订')
})
it('prefers an already reserved task for the same account and verifies its id', async () => {
  rows = [task('available'), task('reserved', true)]
  await act(async () => scanProfileFollowTask())
  await act(async () => card()?.querySelector('button')?.click())
  expect(messaging.sendMessage).toHaveBeenCalledWith({
    type: 'verify-task',
    campaignId: 'reserved',
  })
})
it('updates the hint after following and recovers a card replaced by X', async () => {
  rows = [task('follow-1', true)]
  await act(async () => scanProfileFollowTask())
  expect(card()?.textContent).toContain('完成关注后点击验证')
  document
    .querySelector('[data-testid="123-follow"]')!
    .setAttribute('data-testid', '123-unfollow')
  await act(async () => scanProfileFollowTask())
  expect(card()?.textContent).toContain('确认已关注 @bundlessapp')
  document.querySelector('.lhdao-follow-card')!.remove()
  await act(async () => scanProfileFollowTask())
  expect(card()?.textContent).toContain('我已关注，验证')
})
it('shows a retry on refresh failure instead of treating the stale reservation as current', async () => {
  syncFailed = true
  await act(async () => refreshTasksSnapshot())
  await act(async () => scanProfileFollowTask())
  expect(card()?.textContent).toContain('重试同步')
  syncFailed = false
  rows = [task('follow-1', true)]
  await act(async () => card()?.querySelector('button')?.click())
  expect(card()?.textContent).toContain('我已关注，验证')
})
it('does not restore an old profile when its refresh completes after navigation', async () => {
  let finish!: (response: MsgResponse) => void
  vi.mocked(messaging.sendMessage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => scanProfileFollowTask())
  window.history.replaceState({}, '', '/home')
  await act(async () => scanProfileFollowTask())
  await act(async () =>
    finish({
      type: 'tasks-snapshot',
      byTweet: {},
      byAuthor: { bundlessapp: [task('follow-1', true)] },
    }),
  )
  expect(card()).toBeUndefined()
})
it('keeps unrelated profiles quiet and removes a card when the task disappears', async () => {
  await act(async () => scanProfileFollowTask())
  rows = []
  await act(async () => refreshFollowTaskSnapshot())
  expect(card()).toBeUndefined()
  window.history.replaceState({}, '', '/someoneelse')
  await act(async () => scanProfileFollowTask())
  expect(card()).toBeUndefined()
})

it('keeps its card when another extension runs legacy cleanup', async () => {
  rows = [task('follow-1', true)]
  await act(async () => scanProfileFollowTask())
  document
    .querySelectorAll('[data-lhdao-follow-card], [data-lhdao-host="1"]')
    .forEach((host) => {
      host.remove()
    })
  expect(card()?.textContent).toContain('我已关注，验证')
})
it('mounts alongside other versions and leaves their cards intact', async () => {
  const legacyCard = document.createElement('span')
  legacyCard.setAttribute('data-lhdao-follow-card', '1')
  const otherCard = document.createElement('span')
  otherCard.setAttribute('data-lhdao-follow-card-owner', 'other-extension')
  document.body.append(legacyCard, otherCard)
  await act(async () => scanProfileFollowTask())
  expect(card()?.textContent).toContain('返回任务页预订')
  rows = []
  await act(async () => refreshFollowTaskSnapshot())
  expect(card()).toBeUndefined()
  expect(legacyCard.isConnected).toBe(true)
  expect(otherCard.isConnected).toBe(true)
})
