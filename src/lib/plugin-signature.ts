import { getOrCreateDeviceKeyPair } from './device-key'

const SIGNATURE_PREFIX = 'lhdao-plugin-v1'

const OPERATION_IDS: Record<string, string> = {
  CreateExtensionPairing: 'pairing.create.v1',
  PollExtensionPairing: 'pairing.poll.v1',
  Me: 'user.me.v1',
  AvailableEngagements: 'engagement.available.v1',
  MyReservedEngagements: 'engagement.reserved.v1',
  AvailableTweets: 'tweet.available.v1',
  LighthouseMembers: 'member.lookup.v1',
  RecordTweetDwell: 'dwell.record.v1',
  ReportEngagementCapture: 'capture.report.v1',
  MintEngagementTicket: 'verify.ticket.v1',
  SubmitEngagementProof: 'verify.proof.v1',
  ReserveTimelineEngagementSlot: 'engagement.reserve.v1',
  MintProductExperienceTicket: 'verify.product-experience.ticket.v1',
  MintProductExperienceTestTicket: 'verify.product-experience.test-ticket.v1',
  SubmitProductExperienceProof: 'verify.product-experience.proof.v1',
  PromoteTweet: 'spend.promote.v1',
  CreateAutoReinvestTask: 'spend.reinvest.v1',
}

export function pluginOperationIdFor(query: string): string | null {
  const operationName = inferOperationName(query)
  return operationName ? (OPERATION_IDS[operationName] ?? null) : null
}

export async function maybeAttachPluginSignature(
  headers: Record<string, string>,
  query: string,
  variables: unknown,
  deviceId: string,
): Promise<void> {
  const operationId = pluginOperationIdFor(query)
  if (!operationId) return

  const { privateKeyJwk } = await getOrCreateDeviceKeyPair()
  const timestamp = String(Date.now())
  const nonce = randomNonce()
  const documentSha256 = await sha256Hex(query)
  const variablesSha256 = await sha256Hex(canonicalJson(variables ?? {}))
  const message = buildPluginSignatureMessage({
    operationId,
    documentSha256,
    variablesSha256,
    deviceId,
    timestamp,
    nonce,
  })

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(message),
  )

  headers['x-plugin-operation-id'] = operationId
  headers['x-request-timestamp'] = timestamp
  headers['x-request-nonce'] = nonce
  headers['x-device-signature'] = bytesToB64url(signature)
}

function inferOperationName(query: string): string | null {
  const match = query.match(
    /^\s*(?:query|mutation|subscription)\s+([_A-Za-z][_A-Za-z0-9]*)/m,
  )
  return match?.[1] ?? null
}

function buildPluginSignatureMessage(input: {
  operationId: string
  documentSha256: string
  variablesSha256: string
  deviceId: string
  timestamp: string
  nonce: string
}): string {
  return [
    SIGNATURE_PREFIX,
    input.operationId,
    input.documentSha256,
    input.variablesSha256,
    input.deviceId,
    input.timestamp,
    input.nonce,
  ].join('\n')
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function bytesToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new WeakSet<object>(), false)
}

function serializeCanonical(
  value: unknown,
  ancestors: WeakSet<object>,
  objectField: boolean,
): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-JSON value')
      return JSON.stringify(value)
    case 'undefined':
      if (objectField) return ''
      throw new TypeError('non-JSON value')
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError('non-JSON value')
  }

  if (typeof value !== 'object') throw new TypeError('non-JSON value')
  if (ancestors.has(value)) throw new TypeError('non-JSON value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeCanonical(item, ancestors, false)).join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('non-JSON value')
    }

    const fields: string[] = []
    for (const key of Object.keys(value).sort()) {
      const fieldValue = (value as Record<string, unknown>)[key]
      if (fieldValue === undefined) continue
      fields.push(
        `${JSON.stringify(key)}:${serializeCanonical(fieldValue, ancestors, true)}`,
      )
    }
    return `{${fields.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}
