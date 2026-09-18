import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrCreateDevicePublicKeyJwk } from '../device-key'

const storage = new Map<string, unknown>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          for (const [key, val] of Object.entries(value)) storage.set(key, val)
        }),
        remove: vi.fn(async (key: string) => {
          storage.delete(key)
        }),
      },
    },
  })
})

describe('device key', () => {
  it('creates and stores an ECDSA P-256 public key JWK without private material', async () => {
    const publicKeyJwk = await getOrCreateDevicePublicKeyJwk()

    expect(publicKeyJwk).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
    })
    expect(publicKeyJwk.x).toEqual(expect.any(String))
    expect(publicKeyJwk.y).toEqual(expect.any(String))
    expect(publicKeyJwk).not.toHaveProperty('d')
    expect(storage.get('devicePublicKeyJwk')).toEqual(publicKeyJwk)

    const privateKeyJwk = storage.get('devicePrivateKeyJwk') as JsonWebKey
    expect(privateKeyJwk).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
    })
    expect(privateKeyJwk.d).toEqual(expect.any(String))
  })

  it('reuses a stored valid public key', async () => {
    const first = await getOrCreateDevicePublicKeyJwk()
    const second = await getOrCreateDevicePublicKeyJwk()

    expect(second).toEqual(first)
  })
})
