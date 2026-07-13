import { sha256Hex } from './canonical-json'
import type { DeviceIdentity } from './device-key'
import { API_ENDPOINT } from './env'
import { localStore } from './storage'

const REGISTER_PLUGIN_DEVICE_MUTATION = `
  mutation RegisterPluginDevice($deviceId: String!, $publicKeyJwk: JSON!) {
    registerPluginDevice(deviceId: $deviceId, publicKeyJwk: $publicKeyJwk)
  }
`

const registrationsInFlight = new Map<string, Promise<void>>()

type PublicDeviceIdentity = Pick<DeviceIdentity, 'deviceId' | 'publicKeyJwk'>

export async function ensureLegacyDeviceRegistered(
  token: string,
  identity: PublicDeviceIdentity,
): Promise<void> {
  const tokenHash = await sha256Hex(token)
  if ((await localStore.get('deviceRegisteredTokenHash')) === tokenHash) return

  const pending = registrationsInFlight.get(tokenHash)
  if (pending) return pending
  const registration = registerLegacyPluginDevice(token, identity)
    .then(() => localStore.set('deviceRegisteredTokenHash', tokenHash))
    .finally(() => registrationsInFlight.delete(tokenHash))
  registrationsInFlight.set(tokenHash, registration)
  return registration
}

export async function registerLegacyPluginDevice(
  token: string,
  identity: PublicDeviceIdentity,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apollo-require-preflight': 'true',
      'X-Apollo-Operation-Name': 'RegisterPluginDevice',
      Authorization: `Bearer ${token}`,
      'x-device-id': identity.deviceId,
    },
    body: JSON.stringify({
      query: REGISTER_PLUGIN_DEVICE_MUTATION,
      variables: {
        deviceId: identity.deviceId,
        publicKeyJwk: identity.publicKeyJwk,
      },
    }),
  })
  const payload = (await response.json().catch(() => null)) as {
    data?: { registerPluginDevice?: boolean }
    errors?: { message?: string; extensions?: { code?: string } }[]
  } | null
  if (!response.ok || !payload?.data?.registerPluginDevice) {
    const error = payload?.errors?.[0]
    throw new Error(
      error?.extensions?.code
        ? `${error.extensions.code}: ${error.message ?? 'Device registration failed'}`
        : (error?.message ?? `Device registration failed (${response.status})`),
    )
  }
}
