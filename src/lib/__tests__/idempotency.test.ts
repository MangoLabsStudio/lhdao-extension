import { describe, expect, it } from 'vitest'
import {
  childSpendActionKey,
  releaseSpendActionKey,
  spendActionKey,
} from '../spend-idempotency'

describe('spend idempotency keys', () => {
  it('reuses a pending action key and rotates after a completed action', () => {
    const variables = { input: { tweetUrl: 'https://x.com/a/status/1' } }
    const first = spendActionKey('promote', variables)
    expect(spendActionKey('promote', variables)).toBe(first)

    releaseSpendActionKey('promote', variables)
    expect(spendActionKey('promote', variables)).not.toBe(first)
  })

  it('derives stable per-campaign child keys', () => {
    expect(childSpendActionKey('promote:abc', 'campaign-1')).toBe(
      'promote:abc:campaign-1',
    )
  })
})
