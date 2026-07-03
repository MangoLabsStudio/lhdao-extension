import { describe, expect, it } from 'vitest'
import { computeGuideState, requiredActionsFor } from '../guide-state'

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
