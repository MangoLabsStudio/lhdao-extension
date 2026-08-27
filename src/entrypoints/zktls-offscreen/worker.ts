import {
  type CapturedRequest,
  clearCapturedRequest,
  clearSecrets,
  matchRequest,
  matchRequestBody,
} from '@/lib/zktls/capture'
import {
  assertConnectorAvailable,
  type CapturedConnector,
  htmlBetweenDisclosureRanges,
  htmlDisclosureRanges,
  interpret,
  interpretCaptured,
  regexDisclosureRanges,
  requestTarget,
  type V1Connector,
  type V4Connector,
} from '@/lib/zktls/interpreter'
import { assertVerifierProfile, ZKTLS_PROFILE } from '@/lib/zktls/profile'
import {
  assertTicketAvailable,
  type ConfigEnvelope,
  type Ticket,
  type TicketEnvelope,
} from '@/lib/zktls/signed-config'
import {
  v4PublicRequestDetails,
  v4RequestDisclosureRanges,
  v4ResponseDisclosureRanges,
} from '@/lib/zktls/v4-disclosure'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const fatalDecoder = new TextDecoder('utf-8', { fatal: true })
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/

type CommonProveMessage = {
  id: string
  type: 'zktls-worker-prove'
  sessionId: string
  connectorId: string
  ticket: Ticket
  configEnvelope: ConfigEnvelope
  ticketEnvelope: TicketEnvelope
}
type V1ProveMessage = CommonProveMessage & {
  config: V1Connector
  identity: string
  cookie: string
}
type CapturedProveMessage = CommonProveMessage & {
  config: CapturedConnector
  captured: CapturedRequest
}
type V4ProveMessage = CommonProveMessage & {
  config: V4Connector
  captured: CapturedRequest
}
type ProveMessage = V1ProveMessage | CapturedProveMessage | V4ProveMessage

function isV1Message(message: ProveMessage): message is V1ProveMessage {
  return message.config.interpreter_version === 1
}

function isV4Message(message: ProveMessage): message is V4ProveMessage {
  return message.config.interpreter_version === 4
}

type SocketIo = {
  read: () => Promise<Uint8Array | null>
  write: (bytes: Uint8Array) => Promise<void>
  close: () => Promise<void>
}

type Range = { start: number; end: number }
type TranscriptRanges = { sent: Range[]; recv: Range[] }
type TranscriptRevealer = {
  reveal(
    config: TranscriptRanges & { server_identity: true },
    metadata: null,
  ): Promise<unknown>
}

type ProofHttpRequest = {
  uri: string
  method: 'GET' | 'POST'
  headers: Map<string, number[]>
  body: number[] | undefined
}

function header(value: string): number[] {
  return Array.from(encoder.encode(value))
}

export function proofHttpRequest(
  message: ProveMessage,
  secretBuffers: number[][] = [],
): ProofHttpRequest {
  const origin = new URL(message.config.origin)
  if (isV4Message(message)) {
    const replay = v4PublicRequestDetails({
      origin: message.config.origin,
      method: message.config.request.method,
      path: message.captured.path,
      body: message.captured.body,
      contentType: message.captured.content_type,
      contentEncoding: message.config.response_content_encoding,
    })
    if (replay.sentByteLength > message.config.request.max_sent_data)
      throw new Error('captured request did not match the signed provider')
    const encodedBody = replay.body ? Array.from(replay.body) : undefined
    return {
      uri: message.captured.path,
      method: message.config.request.method,
      headers: new Map([
        ['host', header(replay.host)],
        ['connection', header('close')],
        ...(replay.contentEncoding === 'gzip'
          ? [
              ['accept-encoding', header(replay.contentEncoding)] as [
                string,
                number[],
              ],
            ]
          : []),
        ...(encodedBody
          ? [
              ['content-type', header('application/json')] as [
                string,
                number[],
              ],
              ['content-length', header(String(encodedBody.length))] as [
                string,
                number[],
              ],
            ]
          : []),
      ]),
      body: encodedBody,
    }
  }

  const path = isV1Message(message)
    ? requestTarget(message.config, message.identity)
    : message.captured.path
  const secrets = isV1Message(message)
    ? { cookie: message.cookie }
    : message.captured.secrets
  const body =
    !isV1Message(message) && message.config.request.method === 'POST'
      ? message.captured.body
      : undefined
  if (message.config.request.method === 'POST' && !body)
    throw new Error('captured POST body was missing')
  return {
    uri: path,
    method: message.config.request.method,
    headers: new Map([
      ['host', header(origin.hostname)],
      ['accept-encoding', header('identity')],
      ['connection', header('close')],
      ...(!isV1Message(message) && message.config.request.method === 'POST'
        ? [
            ['content-type', header(message.captured.content_type!)] as [
              string,
              number[],
            ],
          ]
        : []),
      ...Object.entries(message.config.request.headers).map(
        ([key, value]) => [key, header(value)] as [string, number[]],
      ),
      ...Object.entries(secrets).map(([key, value]) => {
        const bytes = header(value)
        secretBuffers.push(bytes)
        return [key, bytes] as [string, number[]]
      }),
    ]),
    body: body ? header(body) : undefined,
  }
}

export async function sendProofHttpRequest<T>(
  message: ProveMessage,
  send: (request: ProofHttpRequest) => Promise<T>,
): Promise<T> {
  const secretBuffers: number[][] = []
  try {
    const request = proofHttpRequest(message, secretBuffers)
    if (isV1Message(message)) message.cookie = ''
    else clearSecrets(message.captured.secrets)
    return await send(request)
  } finally {
    if (isV1Message(message)) message.cookie = ''
    else clearSecrets(message.captured.secrets)
    for (const bytes of secretBuffers) bytes.fill(0)
  }
}

export function sessionRegistrationPayload(message: ProveMessage): object {
  return {
    type: 'register',
    maxRecvData: message.config.request.max_recv_data,
    maxSentData: message.config.request.max_sent_data,
    config_envelope: message.configEnvelope,
    ticket_envelope: message.ticketEnvelope,
    sessionData: {
      session_id: message.sessionId,
      connector_id: message.connectorId,
      revision: String(message.ticket.revision),
      interpreter_version: String(message.ticket.interpreter_version),
      config_digest: message.ticket.config_digest,
      nonce: message.ticket.nonce,
    },
  }
}

export function verifierUrls(
  endpoint: string,
  registeredSessionId: string,
): { verifierUrl: string; proxyUrl: string } {
  if (!TOKEN.test(registeredSessionId)) {
    throw new Error('verifier rejected session')
  }
  const base = new URL(endpoint)
  const verifier = new URL('/verifier', base)
  verifier.searchParams.set('sessionId', registeredSessionId)
  const proxy = new URL('/proxy', base)
  proxy.searchParams.set('sessionId', registeredSessionId)
  return { verifierUrl: verifier.href, proxyUrl: proxy.href }
}

function websocketIo(url: string): Promise<SocketIo> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    const queue: Uint8Array[] = []
    let next: ((value: Uint8Array | null) => void) | null = null
    let closed = false
    socket.onopen = () =>
      resolve({
        read: async () =>
          queue.shift() ??
          (closed
            ? null
            : new Promise((done) => {
                next = done
              })),
        write: async (bytes) => socket.send(bytes),
        close: async () => socket.close(),
      })
    socket.onerror = () => reject(new Error('verifier unavailable'))
    socket.onmessage = (event) => {
      const bytes = new Uint8Array(event.data as ArrayBuffer)
      if (next) {
        const done = next
        next = null
        done(bytes)
      } else queue.push(bytes)
    }
    socket.onclose = () => {
      closed = true
      next?.(null)
    }
  })
}

async function registerSession(message: ProveMessage): Promise<{
  socket: WebSocket
  verifierUrl: string
  proxyUrl: string
  completion: Promise<void>
}> {
  const endpoint = ZKTLS_PROFILE.verifierEndpoint
  if (!endpoint) throw new Error('verifier unavailable')
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint)
    let registered = false
    let complete: () => void = () => undefined
    let failCompletion: (error: Error) => void = () => undefined
    const completion = new Promise<void>((done, fail) => {
      complete = done
      failCompletion = fail
    })
    socket.onopen = () =>
      socket.send(JSON.stringify(sessionRegistrationPayload(message)))
    socket.onerror = () => {
      const error = new Error('verifier unavailable')
      registered ? failCompletion(error) : reject(error)
    }
    socket.onclose = () => {
      if (registered) failCompletion(new Error('verifier unavailable'))
    }
    socket.onmessage = (event) => {
      try {
        const value = JSON.parse(String(event.data)) as {
          type?: unknown
          sessionId?: unknown
        }
        if (value.type === 'session_completed') {
          complete()
          return
        }
        if (
          value.type !== 'session_registered' ||
          typeof value.sessionId !== 'string'
        )
          throw new Error('verifier rejected session')
        if (registered) throw new Error('verifier rejected session')
        registered = true
        resolve({
          socket,
          ...verifierUrls(endpoint, value.sessionId),
          completion,
        })
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new Error('verifier rejected session')
        registered ? failCompletion(failure) : reject(failure)
      }
    }
  })
}

function bytesRange(bytes: Uint8Array, value: string): Range {
  const needle = encoder.encode(value)
  for (let start = 0; start <= bytes.length - needle.length; start += 1) {
    if (needle.every((byte, offset) => bytes[start + offset] === byte))
      return { start, end: start + needle.length }
  }
  throw new Error('response did not match the signed connector')
}

export function requestStartLineRange(
  sent: Uint8Array,
  method: string,
  path: string,
): Range {
  const range = bytesRange(sent, `${method} ${path} HTTP/1.1\r\n`)
  if (range.start !== 0)
    throw new Error('response did not match the signed connector')
  return range
}

export function responseStatusLineRange(received: Uint8Array): Range {
  const end = received.indexOf(10)
  if (end < 0 || !decoder.decode(received.slice(0, end)).startsWith('HTTP/'))
    throw new Error('bad status line')
  return { start: 0, end: end + 1 }
}

function status(received: Uint8Array): number {
  const line = decoder.decode(
    received.slice(0, responseStatusLineRange(received).end),
  )
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |\r?$)/.exec(
    line.replace('\n', ''),
  )
  if (!match) throw new Error('bad status line')
  return Number(match[1])
}

function responseBody(received: Uint8Array): {
  offset: number
  text: string
} {
  for (let at = 0; at <= received.length - 4; at += 1) {
    if (
      received[at] === 13 &&
      received[at + 1] === 10 &&
      received[at + 2] === 13 &&
      received[at + 3] === 10
    ) {
      const offset = at + 4
      const headerLines = decoder
        .decode(received.slice(0, at))
        .split('\r\n')
        .slice(1)
      const headers = new Map<string, string[]>()
      for (const line of headerLines) {
        const colon = line.indexOf(':')
        if (
          colon < 1 ||
          /^[ \t]/.test(line) ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, colon))
        )
          throw new Error('bad response headers')
        const name = line.slice(0, colon).toLowerCase()
        headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1)])
      }
      if (headers.has('transfer-encoding'))
        throw new Error('unsupported response transfer encoding')
      const contentEncoding = headers.get('content-encoding')
      if (
        contentEncoding &&
        (contentEncoding.length !== 1 ||
          contentEncoding[0].trim().toLowerCase() !== 'identity')
      )
        throw new Error('unsupported response content encoding')
      const body = received.slice(offset)
      const contentLength = headers.get('content-length')
      if (contentLength) {
        const value = contentLength[0]?.trim()
        if (
          contentLength.length !== 1 ||
          !value ||
          !/^(?:0|[1-9]\d*)$/.test(value) ||
          Number(value) !== body.length
        )
          throw new Error('bad response content length')
      }
      if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf)
        throw new Error('response body UTF-8 BOM is unsupported')
      try {
        return { offset, text: fatalDecoder.decode(body) }
      } catch {
        throw new Error('response body must be valid UTF-8')
      }
    }
  }
  throw new Error('bad response body')
}

export async function transcriptRevealRanges(
  message: ProveMessage,
  sent: Uint8Array,
  received: Uint8Array,
): Promise<TranscriptRanges> {
  if (isV4Message(message)) {
    return {
      sent: v4RequestDisclosureRanges(sent, message.config, message.captured),
      recv: await v4ResponseDisclosureRanges(received, message.config),
    }
  }
  if (
    message.config.response_format === 'json' &&
    message.config.extraction.kind !== 'regex'
  )
    throw new Error('JSON connectors are unsupported by this runtime')
  const body = responseBody(received)
  const response = body.text
  const parsedStatus = status(received)
  let path: string
  let disclosure: {
    prefix: Range
    value: Range
    suffix: Range
  }
  if (isV1Message(message)) {
    path = requestTarget(message.config, message.identity)
    const ranges = htmlDisclosureRanges(
      message.config,
      response,
      message.identity,
    )
    interpret(message.config, {
      response,
      status: parsedStatus,
      identity: message.identity,
      now: new Date().toISOString(),
    })
    disclosure = {
      prefix: ranges.marker,
      value: ranges.claim,
      suffix: ranges.end,
    }
  } else {
    path = message.captured.path
    interpretCaptured(message.config, {
      response,
      status: parsedStatus,
      now: new Date().toISOString(),
      request_target: path,
    })
    disclosure =
      message.config.interpreter_version === 3 &&
      message.config.extraction.kind === 'regex'
        ? regexDisclosureRanges(message.config, response)
        : htmlBetweenDisclosureRanges(message.config, response)
  }
  return {
    sent: [requestStartLineRange(sent, message.config.request.method, path)],
    recv: [
      responseStatusLineRange(received),
      {
        start: body.offset + disclosure.prefix.start,
        end: body.offset + disclosure.prefix.end,
      },
      {
        start: body.offset + disclosure.suffix.start,
        end: body.offset + disclosure.suffix.end,
      },
      {
        start: body.offset + disclosure.value.start,
        end: body.offset + disclosure.value.end,
      },
    ],
  }
}

export async function revealTranscript(
  prover: TranscriptRevealer,
  ranges: TranscriptRanges,
): Promise<void> {
  await prover.reveal(
    {
      sent: ranges.sent,
      recv: ranges.recv,
      server_identity: true,
    },
    null,
  )
}

function assertAvailable(message: ProveMessage): void {
  const now = new Date().toISOString()
  assertConnectorAvailable(message.config, now)
  assertTicketAvailable(message.ticket, now)
  assertVerifierProfile(message.config)
}

function assertCapturedRequest(message: CapturedProveMessage): void {
  if (message.config.interpreter_version === 2) {
    if (message.captured.path !== message.config.request.path)
      throw new Error('captured request did not match the signed provider')
  } else {
    const querySlots = matchRequest(
      message.captured.path,
      message.captured.resource_type,
      message.config.request.matcher,
    )
    if (querySlots === null)
      throw new Error('captured request did not match the signed provider')
    if (message.config.request.method === 'POST') {
      if (
        !message.captured.body ||
        !message.captured.content_type ||
        !message.config.request.body
      )
        throw new Error('captured POST body was missing')
      const bodySlots = matchRequestBody(
        message.captured.body,
        message.captured.content_type,
        message.config.request.body,
      )
      if (bodySlots === null)
        throw new Error('captured request did not match the signed provider')
      const slots = { ...querySlots, ...bodySlots }
      if (
        Object.keys(slots).length !==
          Object.keys(querySlots).length + Object.keys(bodySlots).length ||
        JSON.stringify(slots) !== JSON.stringify(message.captured.slots ?? {})
      )
        throw new Error('captured request did not match the signed provider')
    } else if (
      message.captured.body !== undefined ||
      message.captured.content_type !== undefined ||
      JSON.stringify(querySlots) !==
        JSON.stringify(message.captured.slots ?? {})
    )
      throw new Error('captured request did not match the signed provider')
  }
  const names = Object.keys(message.captured.secrets)
  if (
    names.length !== message.config.request.secret_headers.length ||
    names.some(
      (name) =>
        !message.config.request.secret_headers.includes(
          name as (typeof message.config.request.secret_headers)[number],
        ) ||
        !message.captured.secrets[
          name as keyof typeof message.captured.secrets
        ],
    )
  )
    throw new Error('captured secret headers were invalid')
}

function assertV4CapturedRequest(message: V4ProveMessage): void {
  if (
    Object.keys(message.captured.secrets).length !== 0 ||
    !message.config.request.matcher.resource_types.includes(
      message.captured.resource_type!,
    ) ||
    (message.config.request.method === 'POST') !==
      (message.captured.method === 'POST')
  )
    throw new Error('captured request did not match the signed provider')
}

export function tlsnWasmModuleUrl(
  workerUrl = globalThis.location.href,
): string {
  const url = new URL(workerUrl)
  if (url.protocol !== 'chrome-extension:' && url.protocol !== 'moz-extension:')
    throw new Error('TLSNotary module URL is invalid')
  url.pathname = '/tlsn_wasm.js'
  url.search = ''
  url.hash = ''
  return url.href
}

async function loadTlsnWasm(): Promise<typeof import('tlsn-wasm')> {
  return import(/* @vite-ignore */ tlsnWasmModuleUrl()) as Promise<
    typeof import('tlsn-wasm')
  >
}

async function prove(message: ProveMessage): Promise<void> {
  if (
    !isV4Message(message) &&
    message.config.response_format === 'json' &&
    message.config.extraction.kind !== 'regex'
  )
    throw new Error('JSON connectors are unsupported by this runtime')
  const wasm = await loadTlsnWasm()
  await wasm.default()
  await wasm.initialize(null, 1)
  const origin = new URL(message.config.origin)
  assertAvailable(message)
  if (isV4Message(message)) assertV4CapturedRequest(message)
  else if (!isV1Message(message)) assertCapturedRequest(message)
  const registration = await registerSession(message)
  const prover = new wasm.Prover({
    server_name: origin.hostname,
    mode: 'Mpc',
    max_sent_data: message.config.request.max_sent_data,
    max_sent_records: undefined,
    max_recv_data_online: undefined,
    max_recv_data: message.config.request.max_recv_data,
    max_recv_records_online: undefined,
    defer_decryption_from_start: undefined,
    network: 'Bandwidth',
    client_auth: undefined,
    root_certs: undefined,
  })
  try {
    await prover.setup(await websocketIo(registration.verifierUrl))
    assertAvailable(message)
    const proxyIo = await websocketIo(registration.proxyUrl)
    await sendProofHttpRequest(message, (request) =>
      prover.send_request(proxyIo, request),
    )
    const transcript = prover.transcript()
    const received = new Uint8Array(transcript.recv)
    if (received.length > message.config.request.max_recv_data)
      throw new Error('response exceeded the signed receive limit')
    const ranges = await transcriptRevealRanges(
      message,
      new Uint8Array(transcript.sent),
      received,
    )
    await revealTranscript(prover, ranges)
    await registration.completion
  } finally {
    registration.socket.close()
    prover.free()
  }
}

self.addEventListener('message', (event: MessageEvent<ProveMessage>) => {
  const message = event.data
  if (!message || message.type !== 'zktls-worker-prove') return
  const task = isV1Message(message)
    ? (() => {
        const cookie = message.cookie
        message.cookie = ''
        return prove({ ...message, cookie }).finally(() => {
          message.cookie = ''
        })
      })()
    : (() => {
        const captured = message.captured
        message.captured = { path: '', secrets: {} }
        return prove({
          ...message,
          captured,
        }).finally(() => {
          clearCapturedRequest(captured)
        })
      })()
  void task.then(
    () => self.postMessage({ id: message.id, result: { status: 'submitted' } }),
    (error: unknown) =>
      self.postMessage({
        id: message.id,
        result: {
          status: 'error',
          code:
            error instanceof Error && error.message.includes('JSON connectors')
              ? 'UNSUPPORTED_CONNECTOR'
              : 'PROVER_FAILED',
        },
      }),
  )
})
