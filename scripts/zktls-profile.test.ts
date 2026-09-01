import { describe, expect, test } from 'vitest'
import {
  buildZkTlsProfile,
  validateProductZkTlsProfile,
} from './zktls-profile.mjs'

const product = {
  apiEndpoint: 'https://api.lhdao.top/zktls/config',
  verifierEndpoint: 'wss://verifier.lhdao.top/session',
  existingApiEndpoint: 'https://api.lhdao.top/graphql',
  verifierProfileId: 'lighthouse-v1',
  publicKeys: {
    prod: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
  },
}

describe('zkTLS build profile', () => {
  test('accepts only a public same-origin product profile', () => {
    expect(validateProductZkTlsProfile(product)).toMatchObject({
      apiEndpoint: product.apiEndpoint,
      verifierEndpoint: product.verifierEndpoint,
      verifierProfileId: 'lighthouse-v1',
    })
  })

  test('fails closed for unsafe endpoints and key material', () => {
    for (const value of [
      { ...product, apiEndpoint: 'https://localhost/zktls/config' },
      { ...product, apiEndpoint: 'https://127.0.0.1/zktls/config' },
      { ...product, apiEndpoint: 'https://other.lhdao.top/zktls/config' },
      { ...product, apiEndpoint: 'https://user@api.lhdao.top/zktls/config' },
      { ...product, verifierEndpoint: 'wss://verifier.lhdao.top/session#x' },
      { ...product, publicKeys: {} },
      {
        ...product,
        publicKeys: {
          prod: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
          },
        },
      },
      {
        ...product,
        publicKeys: {
          prod: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43), d: 'secret' },
        },
      },
      { ...product, verifierProfileId: 'lighthouse-dev-v1' },
    ])
      expect(() => validateProductZkTlsProfile(value)).toThrow()
  })

  test('keeps the PR #11 local profile explicit', () => {
    expect(
      buildZkTlsProfile({
        env: { WXT_ZKTLS_ENABLED: 'true' },
        endpointPolicy: { localBuild: true },
        existingApiEndpoint: 'http://localhost:3000/graphql',
      }),
    ).toMatchObject({
      local: true,
      verifierProfileId: 'lighthouse-local-v1',
      verifierEndpoint: 'ws://localhost:7047/session',
    })
  })

  test('enables local diagnostics only for an explicit Beta zkTLS build', () => {
    const env = {
      WXT_ZKTLS_ENABLED: 'true',
      WXT_ZKTLS_DEBUG: 'true',
      WXT_ZKTLS_API_ENDPOINT:
        'https://service.lhdaobeta.top/zktls/signed-config',
      WXT_ZKTLS_VERIFIER_ENDPOINT:
        'wss://verifier.lhdaobeta.top/session',
      WXT_ZKTLS_VERIFIER_PROFILE_ID: 'lighthouse-beta-v1',
      WXT_ZKTLS_PUBLIC_KEYS: JSON.stringify(product.publicKeys),
    }

    expect(
      buildZkTlsProfile({
        env,
        endpointPolicy: { localBuild: false },
        existingApiEndpoint: 'https://service.lhdaobeta.top/graphql',
      }),
    ).toMatchObject({ enabled: true, local: false, debug: true })

    for (const [overrides, endpoint] of [
      [{ WXT_ZKTLS_DEBUG: undefined }, 'https://service.lhdaobeta.top/graphql'],
      [{ WXT_ZKTLS_DEBUG: 'false' }, 'https://service.lhdaobeta.top/graphql'],
      [
        {
          WXT_ZKTLS_DEBUG: 'true',
          WXT_ZKTLS_API_ENDPOINT: 'https://api.lhdao.top/zktls/config',
        },
        'https://api.lhdao.top/graphql',
      ],
    ] as const) {
      expect(
        buildZkTlsProfile({
          env: { ...env, ...overrides },
          endpointPolicy: { localBuild: false },
          existingApiEndpoint: endpoint,
        }).debug,
      ).toBe(false)
    }
  })
})
