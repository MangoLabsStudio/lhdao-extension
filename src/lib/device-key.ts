import { localStore } from './storage'

const ECDSA_P256: EcKeyGenParams = {
  name: 'ECDSA',
  namedCurve: 'P-256',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPublicP256Jwk(value: unknown): value is JsonWebKey {
  return (
    isRecord(value) &&
    value.kty === 'EC' &&
    value.crv === 'P-256' &&
    typeof value.x === 'string' &&
    typeof value.y === 'string' &&
    !('d' in value)
  )
}

function isPrivateP256Jwk(value: unknown): value is JsonWebKey {
  return (
    isRecord(value) &&
    value.kty === 'EC' &&
    value.crv === 'P-256' &&
    typeof value.x === 'string' &&
    typeof value.y === 'string' &&
    typeof value.d === 'string'
  )
}

async function generateDeviceKeyPair(): Promise<{
  publicKeyJwk: JsonWebKey
  privateKeyJwk: JsonWebKey
}> {
  const pair = await crypto.subtle.generateKey(ECDSA_P256, true, [
    'sign',
    'verify',
  ])
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)

  if (!isPublicP256Jwk(publicKeyJwk) || !isPrivateP256Jwk(privateKeyJwk)) {
    throw new Error('Failed to generate a valid device key')
  }

  await localStore.set('devicePublicKeyJwk', publicKeyJwk)
  await localStore.set('devicePrivateKeyJwk', privateKeyJwk)
  return { publicKeyJwk, privateKeyJwk }
}

/**
 * Returns this browser's stable device key pair.
 *
 * The private key stays in chrome.storage.local and is used to sign plugin
 * GraphQL requests. Only the public JWK is ever sent to the backend.
 */
export async function getOrCreateDeviceKeyPair(): Promise<{
  publicKeyJwk: JsonWebKey
  privateKeyJwk: JsonWebKey
}> {
  const publicKeyJwk = await localStore.get('devicePublicKeyJwk')
  const privateKeyJwk = await localStore.get('devicePrivateKeyJwk')

  if (isPublicP256Jwk(publicKeyJwk) && isPrivateP256Jwk(privateKeyJwk)) {
    return { publicKeyJwk, privateKeyJwk }
  }

  return generateDeviceKeyPair()
}

/**
 * Returns this browser's stable device public key for extension pairing.
 */
export async function getOrCreateDevicePublicKeyJwk(): Promise<JsonWebKey> {
  return (await getOrCreateDeviceKeyPair()).publicKeyJwk
}
