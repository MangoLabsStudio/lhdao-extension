import { localStore } from './storage'

const DB_NAME = 'lhdao-plugin-security'
const DB_VERSION = 1
const KEY_STORE = 'device-keys'

export interface DeviceKeyPair {
  privateKey: CryptoKey
  publicKeyJwk: JsonWebKey
}

export interface DeviceIdentity extends DeviceKeyPair {
  deviceId: string
}

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(KEY_STORE)) {
        database.createObjectStore(KEY_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { privateKey: pair.privateKey, publicKeyJwk }
}

export async function saveDevicePrivateKey(
  deviceId: string,
  privateKey: CryptoKey,
): Promise<void> {
  const database = await openKeyDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE, 'readwrite')
      transaction.objectStore(KEY_STORE).put(privateKey, deviceId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

export async function loadDevicePrivateKey(
  deviceId: string,
): Promise<CryptoKey | null> {
  const database = await openKeyDatabase()
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE, 'readonly')
      const request = transaction.objectStore(KEY_STORE).get(deviceId)
      request.onsuccess = () => resolve((request.result as CryptoKey) ?? null)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

export async function getDeviceId(): Promise<string> {
  const existing = await localStore.get('deviceId')
  if (existing) return existing
  const created = crypto.randomUUID()
  await localStore.set('deviceId', created)
  return created
}

export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  let deviceId = await getDeviceId()
  const storedPublicKey = await localStore.get('devicePublicKeyJwk')
  const storedPrivateKey = await loadDevicePrivateKey(deviceId)
  if (storedPublicKey && storedPrivateKey) {
    return {
      deviceId,
      publicKeyJwk: storedPublicKey,
      privateKey: storedPrivateKey,
    }
  }

  if (storedPublicKey || storedPrivateKey) {
    deviceId = crypto.randomUUID()
    await localStore.set('deviceId', deviceId)
  }
  const generated = await generateDeviceKeyPair()
  await saveDevicePrivateKey(deviceId, generated.privateKey)
  await localStore.set('devicePublicKeyJwk', generated.publicKeyJwk)
  return { deviceId, ...generated }
}
