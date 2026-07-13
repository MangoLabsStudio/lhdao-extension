import { describe, expect, it, vi } from 'vitest'
import { registerLegacyPluginDevice } from '../device-registration'

vi.mock('../env', () => ({ API_ENDPOINT: 'https://example.test/graphql' }))

describe('legacy device registration bridge', () => {
  it('uses the bearer token without request-signature headers', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { registerPluginDevice: true } }), {
        status: 200,
      }),
    )

    await registerLegacyPluginDevice(
      'lhdao_pk_existing',
      {
        deviceId: 'device-test-1',
        publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
      fetcher,
    )

    const init = fetcher.mock.calls[0][1] as RequestInit
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer lhdao_pk_existing',
      'x-device-id': 'device-test-1',
    })
    expect(init.headers).not.toHaveProperty('x-plugin-operation-id')
    expect(init.headers).not.toHaveProperty('x-device-signature')
    expect(JSON.parse(init.body as string)).toMatchObject({
      variables: {
        deviceId: 'device-test-1',
        publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
    })
  })
})
