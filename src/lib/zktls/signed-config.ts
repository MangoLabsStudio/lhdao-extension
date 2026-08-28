import {
  assertConnectorAvailable,
  type Connector,
  canonicalJson,
  configDigest,
  validateConnector,
} from './interpreter'

const encoder = new TextEncoder()
const CONFIG_DOMAIN = 'lighthouse-zktls/config/v1:'
const TICKET_DOMAIN = 'lighthouse-zktls/session-ticket/v1:'
const MAX_SIGNED_CONFIG_RESPONSE_BYTES = 72 * 1024
const TICKET_ISSUED_AT_CLOCK_SKEW_MS = 5_000

export type Ticket = {
  schema: 1
  session_id: string
  connector_id: string
  revision: number
  interpreter_version: 1 | 2 | 3 | 4
  config_digest: string
  issued_at: string
  expires_at: string
  nonce: string
}

export type ConfigEnvelope = {
  key_id: string
  config: Connector
  config_digest: string
  signature: string
}

export type TicketEnvelope = {
  key_id: string
  ticket: Ticket
  signature: string
}

function fail(message: string): never {
  throw new Error(message)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value))
      deepFreeze((value as Record<PropertyKey, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) ||
      Number(declared) > MAX_SIGNED_CONFIG_RESPONSE_BYTES)
  )
    fail('signed config response is too large.')
  if (!response.body) fail('signed config response body is missing.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_SIGNED_CONFIG_RESPONSE_BYTES) {
        await reader.cancel()
        fail('signed config response is too large.')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'signed config response is too large.'
    )
      throw error
    fail('signed config response is invalid.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    fail('signed config response is invalid.')
  }
}
function object(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object.`)
}
function keys(value: unknown, allowed: string[], name: string): void {
  object(value, name)
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${name} contains an unknown field.`)
}
function string(
  value: unknown,
  name: string,
  max = 256,
): asserts value is string {
  if (typeof value !== 'string' || !value || encoder.encode(value).length > max)
    fail(`${name} must be a bounded string.`)
}
function token(
  value: unknown,
  name: string,
  max = 128,
): asserts value is string {
  string(value, name, max)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(`${name} must be a token.`)
}
function isoTime(value: unknown, name: string): number {
  string(value, name, 64)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    fail(`${name} is invalid.`)
  return parsed
}
function digest(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    fail(`${name} is invalid.`)
}
function fromBase64Url(value: unknown): Uint8Array {
  string(value, 'signature', 128)
  if (value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value))
    fail('signature is invalid.')
  const binary = atob(
    value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '='),
  )
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  if (bytes.length !== 64) fail('signature is invalid.')
  return bytes
}
async function verify(
  message: Uint8Array,
  signature: Uint8Array,
  keyId: string,
  publicKeys: Record<string, JsonWebKey>,
): Promise<void> {
  if (!Object.hasOwn(publicKeys, keyId)) fail('key_id is not allowlisted.')
  const key = await crypto.subtle.importKey(
    'jwk',
    publicKeys[keyId],
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      key,
      signature as BufferSource,
      message as BufferSource,
    ))
  )
    fail('signature is invalid.')
}
function ticketMessage(ticket: Ticket): Uint8Array {
  return encoder.encode(`${TICKET_DOMAIN}${canonicalJson(ticket)}`)
}
function validateTicket(value: unknown): Ticket {
  keys(
    value,
    [
      'schema',
      'session_id',
      'connector_id',
      'revision',
      'interpreter_version',
      'config_digest',
      'issued_at',
      'expires_at',
      'nonce',
    ],
    'ticket',
  )
  object(value, 'ticket')
  for (const field of [
    'schema',
    'session_id',
    'connector_id',
    'revision',
    'interpreter_version',
    'config_digest',
    'issued_at',
    'expires_at',
    'nonce',
  ])
    if (!(field in value)) fail(`ticket.${field} is required.`)
  if (
    value.schema !== 1 ||
    (value.interpreter_version !== 1 &&
      value.interpreter_version !== 2 &&
      value.interpreter_version !== 3 &&
      value.interpreter_version !== 4) ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 1
  )
    fail('ticket schema is unsupported.')
  token(value.session_id, 'ticket.session_id')
  token(value.connector_id, 'ticket.connector_id')
  digest(value.config_digest, 'ticket.config_digest')
  if (
    isoTime(value.expires_at, 'ticket.expires_at') <=
    isoTime(value.issued_at, 'ticket.issued_at')
  )
    fail('ticket expiry is invalid.')
  token(value.nonce, 'ticket.nonce', 256)
  return value as Ticket
}

export function assertTicketAvailable(ticket: Ticket, now: string): void {
  const current = isoTime(now, 'now')
  if (
    current + TICKET_ISSUED_AT_CLOCK_SKEW_MS < Date.parse(ticket.issued_at) ||
    current >= Date.parse(ticket.expires_at)
  )
    fail('ticket is unavailable.')
}

export async function verifyConfigEnvelope(
  value: unknown,
  publicKeys: Record<string, JsonWebKey>,
): Promise<Connector> {
  keys(
    value,
    ['key_id', 'config', 'config_digest', 'signature'],
    'config envelope',
  )
  object(value, 'config envelope')
  token(value.key_id, 'key_id')
  digest(value.config_digest, 'config_digest')
  const config = validateConnector(value.config)
  if ((await configDigest(config)) !== value.config_digest)
    fail('config_digest did not match config.')
  await verify(
    encoder.encode(`${CONFIG_DOMAIN}${value.config_digest}`),
    fromBase64Url(value.signature),
    value.key_id,
    publicKeys,
  )
  return config
}

export async function verifyTicketEnvelope(
  value: unknown,
  options: {
    config: Connector
    publicKeys: Record<string, JsonWebKey>
    now: string
  },
): Promise<Ticket> {
  keys(value, ['key_id', 'ticket', 'signature'], 'ticket envelope')
  object(value, 'ticket envelope')
  token(value.key_id, 'key_id')
  const ticket = validateTicket(value.ticket)
  await verify(
    ticketMessage(ticket),
    fromBase64Url(value.signature),
    value.key_id,
    options.publicKeys,
  )
  if (
    ticket.connector_id !== options.config.connector_id ||
    ticket.revision !== options.config.revision ||
    ticket.interpreter_version !== options.config.interpreter_version ||
    ticket.config_digest !== (await configDigest(options.config))
  )
    fail('ticket did not bind the verified config.')
  assertTicketAvailable(ticket, options.now)
  return ticket
}

export async function fetchAndVerifySignedConfig(
  endpoint: string,
  options: {
    publicKeys: Record<string, JsonWebKey>
    now: string | (() => string)
    local: boolean
  },
): Promise<{
  config: Connector
  ticket: Ticket
  configEnvelope: ConfigEnvelope
  ticketEnvelope: TicketEnvelope
}> {
  const url = new URL(endpoint)
  if (
    url.username ||
    url.password ||
    url.hash ||
    (options.local
      ? url.protocol !== 'http:' || url.hostname !== 'localhost'
      : url.protocol !== 'https:')
  )
    fail('signed config endpoint is invalid.')
  const response = await fetch(url.href, { credentials: 'omit' })
  if (!response.ok) fail('signed config request failed.')
  const payload = await boundedResponseJson(response)
  keys(
    payload,
    ['config_envelope', 'ticket_envelope'],
    'signed config response',
  )
  object(payload, 'signed config response')
  const config = await verifyConfigEnvelope(
    payload.config_envelope,
    options.publicKeys,
  )
  const now = typeof options.now === 'function' ? options.now() : options.now
  const ticket = await verifyTicketEnvelope(payload.ticket_envelope, {
    config,
    publicKeys: options.publicKeys,
    now,
  })
  assertConnectorAvailable(config, now)
  const configEnvelope = deepFreeze(payload.config_envelope as ConfigEnvelope)
  const ticketEnvelope = deepFreeze(payload.ticket_envelope as TicketEnvelope)
  return {
    config,
    ticket,
    configEnvelope,
    ticketEnvelope,
  }
}
