import { describe, expect, it } from 'vitest'
import { parseRetryAfterMs, withBackoffJitter } from '../gql-backoff'

describe('plugin GraphQL backoff', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('12', 1_000)).toBe(12_000)
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:16 GMT', 1_000)).toBe(
      15_000,
    )
  })

  it('adds bounded jitter without shortening the server delay', () => {
    expect(withBackoffJitter(10_000, () => 0)).toBe(10_000)
    expect(withBackoffJitter(10_000, () => 1)).toBe(12_000)
  })
})
