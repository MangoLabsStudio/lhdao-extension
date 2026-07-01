import md5 from 'md5'
import { describe, expect, it } from 'vitest'
import { solvePow, validatePow } from '../pow'

// 这些用例锁死 PoW 算法跟后端 backend/src/modules/watermark/pow-validator.ts
// 的契约:md5(challenge + nonce) 的 hex 前缀命中 difficulty。任一处改了哈希
// 输入拼法/算法,这里立刻挂,避免上线后 reserve 全被判 WM_POW_INVALID。

describe('solvePow', () => {
  it('produces a nonce whose md5(challenge+nonce) starts with difficulty', () => {
    const challenge = 'abcd1234'
    const difficulty = '0000'
    const { nonce, cost } = solvePow(challenge, difficulty)

    expect(md5(challenge + nonce).startsWith(difficulty)).toBe(true)
    expect(Number(nonce)).toBeGreaterThanOrEqual(0)
    expect(cost).toBeGreaterThan(0)
  })

  it('solution validates via the backend-mirrored validatePow', () => {
    const challenge = 'deadbeef'
    const difficulty = '000'
    const { nonce } = solvePow(challenge, difficulty)
    expect(validatePow(challenge, nonce, difficulty)).toBe(true)
  })
})

describe('validatePow', () => {
  it('rejects empty nonce', () => {
    expect(validatePow('abc', '', '0000')).toBe(false)
  })

  it('rejects a nonce that does not meet difficulty', () => {
    // md5('challenge' + '0') 几乎不可能以 ffff 开头
    expect(validatePow('challenge', '0', 'ffff')).toBe(false)
  })
})
