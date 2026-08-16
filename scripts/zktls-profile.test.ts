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
})
