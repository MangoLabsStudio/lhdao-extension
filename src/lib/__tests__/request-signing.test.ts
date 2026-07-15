import { describe, expect, it } from 'vitest'
import { getPluginOperationByDocument } from '../plugin-operations'
import { ME_QUERY } from '../queries'
import {
  buildPluginSignatureMessage,
  signPluginRequest,
} from '../request-signing'

const PRIVATE_JWK: JsonWebKey = {
  kty: 'EC',
  x: 'RRkW-IilJGV1obxWUFjuV9WDdYnSWCL8HvYozQVkb-k',
  y: 'KDLbFMR8BLOocBojc769PKq7IWHnzCWSH_uEX0HFOjU',
  crv: 'P-256',
  d: 'FX9vTE5wCf1HecYJz9Io7_Q4R7B4aIgbKqrDlBLgMYA',
}

const PUBLIC_JWK: JsonWebKey = {
  kty: 'EC',
  x: PRIVATE_JWK.x,
  y: PRIVATE_JWK.y,
  crv: 'P-256',
}

describe('plugin request signing', () => {
  it('builds the versioned canonical signature message', () => {
    expect(
      buildPluginSignatureMessage({
        operationId: 'user.me.v1',
        documentSha256:
          'e2cf4ae81a912d91fcdc244de44253fc2408cc4bca9b95908691fd89c742143c',
        variablesSha256:
          '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        deviceId: 'device-test-1',
        timestamp: '1783944000000',
        nonce: 'nonce-test-123456',
      }),
    ).toBe(
      [
        'lhdao-plugin-v1',
        'user.me.v1',
        'e2cf4ae81a912d91fcdc244de44253fc2408cc4bca9b95908691fd89c742143c',
        '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        'device-test-1',
        '1783944000000',
        'nonce-test-123456',
      ].join('\n'),
    )
  })

  it('signs the allowlisted document and variables with P-256', async () => {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      PRIVATE_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      PUBLIC_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const operation = getPluginOperationByDocument(ME_QUERY, 'Me')

    const signed = await signPluginRequest({
      operation: operation!,
      variables: {},
      deviceId: 'device-test-1',
      privateKey,
      timestamp: '1783944000000',
      nonce: 'nonce-test-123456',
    })

    expect(signed.headers).toMatchObject({
      'x-plugin-operation-id': 'user.me.v1',
      'x-device-id': 'device-test-1',
      'x-request-timestamp': '1783944000000',
      'x-request-nonce': 'nonce-test-123456',
    })
    const signature = Uint8Array.from(
      atob(
        signed.headers['x-device-signature']
          .replace(/-/g, '+')
          .replace(/_/g, '/'),
      ),
      (char) => char.charCodeAt(0),
    )
    await expect(
      crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        signature,
        new TextEncoder().encode(signed.message),
      ),
    ).resolves.toBe(true)
  })
})
