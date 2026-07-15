import { describe, expect, it } from 'vitest'
import { GqlError } from '../gql'
import {
  childSpendActionKey,
  releaseSpendActionKey,
  releaseSpendActionKeyAfterDefiniteFailure,
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

  it.each([
    ['HTTP 5xx', new GqlError('gateway failed', undefined, 503, 'HTTP', true)],
    [
      'internal GraphQL error',
      new GqlError(
        'resolver failed',
        [
          {
            message: 'resolver failed',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
        200,
        'GRAPHQL',
        true,
      ),
    ],
    [
      'malformed mutation response',
      new GqlError(
        'GraphQL response missing data',
        undefined,
        200,
        'PROTOCOL',
        true,
      ),
    ],
  ])('retains the pending key after an uncertain %s outcome', (_label, error) => {
    const variables = {
      input: { tweetUrl: `https://x.com/a/status/${error.kind}` },
    }
    const first = spendActionKey('promote', variables)

    expect(
      releaseSpendActionKeyAfterDefiniteFailure('promote', variables, error),
    ).toBe(false)

    expect(spendActionKey('promote', variables)).toBe(first)
  })

  it.each([
    ['HTTP 4xx', new GqlError('bad request', undefined, 400, 'HTTP', false)],
    [
      'GraphQL business 4xx',
      new GqlError(
        'insufficient balance',
        [
          {
            message: 'insufficient balance',
            extensions: { code: 'BAD_USER_INPUT' },
          },
        ],
        400,
        'GRAPHQL',
        false,
      ),
    ],
  ])('rotates the pending key after a definite %s failure', (_label, error) => {
    const variables = {
      input: { tweetUrl: `https://x.com/a/status/400-${error.kind}` },
    }
    const first = spendActionKey('promote', variables)

    expect(
      releaseSpendActionKeyAfterDefiniteFailure('promote', variables, error),
    ).toBe(true)

    expect(spendActionKey('promote', variables)).not.toBe(first)
  })
})
