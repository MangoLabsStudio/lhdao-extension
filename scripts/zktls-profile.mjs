const LOCAL_PUBLIC_KEYS = {
  'local-dev-2026': {
    kty: 'OKP',
    crv: 'Ed25519',
    x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
  },
}
const DEV_PUBLIC_KEY_X = LOCAL_PUBLIC_KEYS['local-dev-2026'].x
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/
const ED25519_X = /^[A-Za-z0-9_-]{43}$/

function publicHostname(hostname) {
  const host = hostname.toLowerCase()
  const labels = host.split('.')
  if (
    host.includes(':') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (labels.length === 4 && labels.every((label) => /^\d+$/.test(label)))
  )
    return false
  return (
    host.includes('.') &&
    host.length <= 253 &&
    labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )
  )
}

function productUrl(value, protocol, name) {
  const url = new URL(value)
  if (
    url.protocol !== protocol ||
    url.username ||
    url.password ||
    url.hash ||
    !publicHostname(url.hostname)
  )
    throw new Error(`Product zkTLS ${name} is invalid.`)
  return url
}

export function validateProductZkTlsProfile({
  apiEndpoint,
  verifierEndpoint,
  publicKeys,
  verifierProfileId,
  existingApiEndpoint,
}) {
  const api = productUrl(apiEndpoint, 'https:', 'API endpoint')
  const verifier = productUrl(verifierEndpoint, 'wss:', 'verifier endpoint')
  if (api.origin !== new URL(existingApiEndpoint).origin)
    throw new Error('Product zkTLS API must share the extension API origin.')
  if (
    !publicKeys ||
    Array.isArray(publicKeys) ||
    Object.getPrototypeOf(publicKeys) !== Object.prototype ||
    Object.keys(publicKeys).length === 0
  )
    throw new Error('Product zkTLS requires public keys.')
  for (const [keyId, key] of Object.entries(publicKeys)) {
    if (
      !TOKEN.test(keyId) ||
      !key ||
      Array.isArray(key) ||
      Object.getPrototypeOf(key) !== Object.prototype ||
      key.kty !== 'OKP' ||
      key.crv !== 'Ed25519' ||
      typeof key.x !== 'string' ||
      !ED25519_X.test(key.x) ||
      'd' in key ||
      key.x === DEV_PUBLIC_KEY_X
    )
      throw new Error('Product zkTLS public key is invalid.')
  }
  if (!TOKEN.test(verifierProfileId) || /(?:local|dev|test)/i.test(verifierProfileId))
    throw new Error('Product zkTLS verifier profile is invalid.')
  return {
    apiEndpoint: api.href,
    verifierEndpoint: verifier.href,
    publicKeys,
    verifierProfileId,
  }
}

export function buildZkTlsProfile({ env, endpointPolicy, existingApiEndpoint }) {
  const enabled = env.WXT_ZKTLS_ENABLED === 'true'
  if (!enabled)
    return {
      enabled: false,
      local: endpointPolicy.localBuild,
      apiEndpoint: null,
      verifierEndpoint: null,
      verifierProfileId: null,
      publicKeys: {},
    }
  const apiEndpoint =
    env.WXT_ZKTLS_API_ENDPOINT ??
    (endpointPolicy.localBuild ? 'http://localhost:3031/signed-config' : '')
  const verifierEndpoint =
    env.WXT_ZKTLS_VERIFIER_ENDPOINT ??
    (endpointPolicy.localBuild ? 'ws://localhost:7047/session' : '')
  if (endpointPolicy.localBuild) {
    const api = new URL(apiEndpoint)
    const verifier = new URL(verifierEndpoint)
    if (
      api.protocol !== 'http:' ||
      api.hostname !== 'localhost' ||
      verifier.protocol !== 'ws:' ||
      verifier.hostname !== 'localhost'
    )
      throw new Error('Local zkTLS requires localhost HTTP API and WS verifier.')
    return {
      enabled: true,
      local: true,
      apiEndpoint: api.href,
      verifierEndpoint: verifier.href,
      verifierProfileId: 'lighthouse-local-v1',
      publicKeys: LOCAL_PUBLIC_KEYS,
    }
  }
  return {
    enabled: true,
    local: false,
    ...validateProductZkTlsProfile({
      apiEndpoint,
      verifierEndpoint,
      publicKeys: JSON.parse(env.WXT_ZKTLS_PUBLIC_KEYS ?? ''),
      verifierProfileId: env.WXT_ZKTLS_VERIFIER_PROFILE_ID ?? '',
      existingApiEndpoint,
    }),
  }
}
