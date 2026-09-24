import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import {
  generateDeviceKeyPair,
  loadDevicePrivateKey,
  saveDevicePrivateKey,
} from '../device-key'

describe('device key storage', () => {
  it('generates a non-extractable ECDSA P-256 private key', async () => {
    const identity = await generateDeviceKeyPair()

    expect(identity.privateKey.algorithm).toMatchObject({
      name: 'ECDSA',
      namedCurve: 'P-256',
    })
    expect(identity.privateKey.extractable).toBe(false)
    expect(identity.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    await expect(
      crypto.subtle.exportKey('jwk', identity.privateKey),
    ).rejects.toThrow()
  })

  it('round-trips the private CryptoKey through IndexedDB', async () => {
    const identity = await generateDeviceKeyPair()
    await saveDevicePrivateKey('device-test-1', identity.privateKey)

    const loaded = await loadDevicePrivateKey('device-test-1')
    expect(loaded).toBeInstanceOf(CryptoKey)
    expect(loaded?.extractable).toBe(false)
  })
})
