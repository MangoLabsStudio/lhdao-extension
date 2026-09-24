import { describe, expect, it } from 'vitest'
import {
  computeGuideState,
  computeGuideStateForActions,
  groupCampaigns,
  requiredActionsFor,
  requiredActionsForMany,
} from '../guide-state'
import type { CampaignTaskCache } from '../storage'

function task(p: Partial<CampaignTaskCache>): CampaignTaskCache {
  return {
    campaignId: 'c1',
    tweetId: '100',
    actionType: 'LIKE',
    expectedReward: 1,
    ...p,
  }
}

describe('requiredActionsFor', () => {
  it('单动作原样返回', () => {
    expect(requiredActionsFor('LIKE')).toEqual(['LIKE'])
    expect(requiredActionsFor('RT')).toEqual(['RT'])
    expect(requiredActionsFor('COMMENT')).toEqual(['COMMENT'])
    expect(requiredActionsFor('FOLLOW')).toEqual(['FOLLOW'])
  })
  it('COMMENT_LIKE 展开为 COMMENT + LIKE', () => {
    expect(requiredActionsFor('COMMENT_LIKE')).toEqual(['COMMENT', 'LIKE'])
  })
  it('未知类型 → 空', () => {
    expect(requiredActionsFor('XYZ')).toEqual([])
  })
})

describe('computeGuideState', () => {
  const goal = 10000
  it('动作齐 + 停留够 → canVerify', () => {
    const s = computeGuideState('LIKE', new Set(['LIKE']), 10000, goal)
    expect(s.items).toEqual([{ key: 'LIKE', label: '点赞', done: true }])
    expect(s.dwellOk).toBe(true)
    expect(s.canVerify).toBe(true)
  })
  it('缺动作 → 不解锁', () => {
    const s = computeGuideState(
      'COMMENT_LIKE',
      new Set(['COMMENT']),
      10000,
      goal,
    )
    expect(s.items.map((i) => i.done)).toEqual([true, false])
    expect(s.canVerify).toBe(false)
  })
  it('动作齐但停留不够 → 不解锁,dwellOk=false', () => {
    const s = computeGuideState('LIKE', new Set(['LIKE']), 3000, goal)
    expect(s.dwellOk).toBe(false)
    expect(s.canVerify).toBe(false)
  })
  it('未知类型(无要求动作)→ 不解锁', () => {
    expect(computeGuideState('XYZ', new Set(), 99999, goal).canVerify).toBe(
      false,
    )
  })
})

describe('requiredActionsForMany', () => {
  it('跨 action 去重合并', () => {
    expect(requiredActionsForMany(['COMMENT_LIKE', 'LIKE'])).toEqual([
      'COMMENT',
      'LIKE',
    ])
    expect(requiredActionsForMany(['LIKE', 'RT', 'COMMENT'])).toEqual([
      'LIKE',
      'RT',
      'COMMENT',
    ])
  })
  it('空 / 未知 → 空', () => {
    expect(requiredActionsForMany([])).toEqual([])
    expect(requiredActionsForMany(['XYZ'])).toEqual([])
  })
})

describe('computeGuideStateForActions', () => {
  const goal = 10000
  it('多动作齐 + 停留够 → canVerify', () => {
    const s = computeGuideStateForActions(
      ['COMMENT', 'LIKE'],
      new Set(['COMMENT', 'LIKE']),
      10000,
      goal,
    )
    expect(s.items.map((i) => i.done)).toEqual([true, true])
    expect(s.canVerify).toBe(true)
  })
  it('缺一个动作 → 不解锁', () => {
    const s = computeGuideStateForActions(
      ['COMMENT', 'LIKE'],
      new Set(['COMMENT']),
      10000,
      goal,
    )
    expect(s.canVerify).toBe(false)
  })
})

describe('groupCampaigns', () => {
  it('同 campaign 多 action entry 归并:合并动作 + 汇总奖励', () => {
    const g = groupCampaigns([
      task({ campaignId: 'c1', actionType: 'COMMENT', expectedReward: 3 }),
      task({ campaignId: 'c1', actionType: 'LIKE', expectedReward: 3 }),
    ])
    expect(g).toHaveLength(1)
    expect(g[0].requiredActions).toEqual(['COMMENT', 'LIKE'])
    expect(g[0].totalReward).toBe(6)
  })
  it('COMMENT_LIKE 单 entry 展开为评论+点赞', () => {
    const g = groupCampaigns([
      task({ campaignId: 'c2', actionType: 'COMMENT_LIKE', expectedReward: 8 }),
    ])
    expect(g[0].requiredActions).toEqual(['COMMENT', 'LIKE'])
    expect(g[0].totalReward).toBe(8)
  })
  it('多 campaign 按总奖励降序', () => {
    const g = groupCampaigns([
      task({ campaignId: 'lo', actionType: 'LIKE', expectedReward: 2 }),
      task({ campaignId: 'hi', actionType: 'RT', expectedReward: 9 }),
    ])
    expect(g.map((c) => c.campaignId)).toEqual(['hi', 'lo'])
  })
  it('已预约(reserved)优先于奖励更高的未预约(修 NO_ACTIVE_RESERVATION)', () => {
    // 同一推文:转发单奖励最高但未预约;评论单奖励低但已预约。[0] 必须是评论。
    const g = groupCampaigns([
      task({
        campaignId: 'rt',
        actionType: 'RT',
        expectedReward: 9,
        reserved: false,
      }),
      task({
        campaignId: 'like',
        actionType: 'LIKE',
        expectedReward: 5,
        reserved: false,
      }),
      task({
        campaignId: 'cmt',
        actionType: 'COMMENT',
        expectedReward: 2,
        reserved: true,
      }),
    ])
    expect(g[0].campaignId).toBe('cmt')
    expect(g[0].reserved).toBe(true)
    // 其余未预约的仍按奖励降序
    expect(g.map((c) => c.campaignId)).toEqual(['cmt', 'rt', 'like'])
  })
  it('多个已预约时,已预约之间仍按奖励降序', () => {
    const g = groupCampaigns([
      task({
        campaignId: 'rlo',
        actionType: 'LIKE',
        expectedReward: 3,
        reserved: true,
      }),
      task({
        campaignId: 'rhi',
        actionType: 'RT',
        expectedReward: 7,
        reserved: true,
      }),
      task({
        campaignId: 'un',
        actionType: 'COMMENT',
        expectedReward: 99,
        reserved: false,
      }),
    ])
    expect(g.map((c) => c.campaignId)).toEqual(['rhi', 'rlo', 'un'])
  })
  it('取 author / keyword / targetUsername 首个非空', () => {
    const g = groupCampaigns([
      task({
        campaignId: 'c3',
        actionType: 'COMMENT',
        commentKeyword: 'gm',
        authorName: null,
        authorHandle: 'solana',
      }),
      task({
        campaignId: 'c3',
        actionType: 'FOLLOW',
        targetUsername: 'solana',
        authorName: 'Solana Labs',
      }),
    ])
    expect(g[0].commentKeyword).toBe('gm')
    expect(g[0].targetUsername).toBe('solana')
    expect(g[0].authorName).toBe('Solana Labs')
    expect(g[0].authorHandle).toBe('solana')
  })
  it('同 (campaignId, actionType) 重复(byTweet+byAuthor 交集)只计一次', () => {
    // 纯 FOLLOW 单同时出现在 byTweet 与 byAuthor,序列化后成两个对象
    const dup = () =>
      task({
        campaignId: 'f1',
        actionType: 'FOLLOW',
        expectedReward: 5,
        targetUsername: 'alice',
      })
    const g = groupCampaigns([dup(), dup()])
    expect(g).toHaveLength(1)
    expect(g[0].requiredActions).toEqual(['FOLLOW'])
    expect(g[0].totalReward).toBe(5)
  })
  it('空输入 → 空', () => {
    expect(groupCampaigns([])).toEqual([])
  })
})

describe('order-scoped comment guidance', () => {
  it('keeps same-tweet orders separate, including cached errors and known null', () => {
    const grouped = groupCampaigns([
      task({
        campaignId: 'a',
        actionType: 'COMMENT',
        commentGuide: 'A 原文',
        commentGuideStatus: 'stale',
      }),
      task({
        campaignId: 'b',
        actionType: 'COMMENT_LIKE',
        commentGuide: 'B 原文',
        commentGuideStatus: 'ready',
      }),
      task({
        campaignId: 'c',
        actionType: 'COMMENT',
        commentGuide: null,
        commentGuideStatus: 'ready',
        commentKeyword: '不能替代引导',
      }),
      task({
        campaignId: 'd',
        actionType: 'COMMENT',
        commentKeyword: '不能替代引导',
      }),
    ])
    expect(
      grouped.map((c) => [c.campaignId, c.commentGuide, c.commentGuideStatus]),
    ).toEqual([
      ['a', 'A 原文', 'stale'],
      ['b', 'B 原文', 'ready'],
      ['c', null, 'ready'],
      ['d', undefined, 'unavailable'],
    ])
  })
})
