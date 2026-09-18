import { describe, expect, it } from 'vitest'
import {
  CREATE_EXTENSION_PAIRING_LEGACY_MUTATION,
  CREATE_EXTENSION_PAIRING_MUTATION,
  createExtensionPairingLegacyVariables,
  createExtensionPairingVariables,
  isCreateExtensionPairingDeviceBindingUnsupported,
} from '../queries'

describe('extension pairing query', () => {
  it('passes deviceId and publicKeyJwk when creating a pairing slot', () => {
    const publicKeyJwk = {
      kty: 'EC',
      crv: 'P-256',
      x: 'x',
      y: 'y',
    }

    expect(CREATE_EXTENSION_PAIRING_MUTATION).toContain(
      'mutation CreateExtensionPairing($code: String!, $deviceId: String!, $publicKeyJwk: JSON!)',
    )
    expect(CREATE_EXTENSION_PAIRING_MUTATION).toContain(
      'createExtensionPairing(code: $code, deviceId: $deviceId, publicKeyJwk: $publicKeyJwk)',
    )
    expect(
      createExtensionPairingVariables(
        '0123456789abcdef0123456789abcdef',
        'd1',
        publicKeyJwk,
      ),
    ).toEqual({
      code: '0123456789abcdef0123456789abcdef',
      deviceId: 'd1',
      publicKeyJwk,
    })
  })

  it('keeps a legacy code-only mutation for older schemas', () => {
    expect(CREATE_EXTENSION_PAIRING_LEGACY_MUTATION).toContain(
      'mutation CreateExtensionPairing($code: String!)',
    )
    expect(CREATE_EXTENSION_PAIRING_LEGACY_MUTATION).toContain(
      'createExtensionPairing(code: $code)',
    )
    expect(
      createExtensionPairingLegacyVariables('0123456789abcdef0123456789abcdef'),
    ).toEqual({
      code: '0123456789abcdef0123456789abcdef',
    })
  })

  it('detects older schemas that reject device binding arguments', () => {
    expect(
      isCreateExtensionPairingDeviceBindingUnsupported(
        new Error(
          'GRAPHQL_VALIDATION_FAILED: Unknown argument "deviceId" on field "Mutation.createExtensionPairing".',
        ),
      ),
    ).toBe(true)
    expect(
      isCreateExtensionPairingDeviceBindingUnsupported(
        new Error(
          'GRAPHQL_VALIDATION_FAILED: Unknown argument "publicKeyJwk" on field "Mutation.createExtensionPairing".',
        ),
      ),
    ).toBe(true)
    expect(
      isCreateExtensionPairingDeviceBindingUnsupported(
        new Error(
          'GRAPHQL_VALIDATION_FAILED: Field "createExtensionPairing" argument "deviceId" of type "String!" is required, but it was not provided.',
        ),
      ),
    ).toBe(false)
  })
})
