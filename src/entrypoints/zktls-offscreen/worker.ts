import { type CapturedRequest, clearSecrets } from '@/lib/zktls/capture'
import {
  assertConnectorAvailable,
  htmlBetweenDisclosureRanges,
  htmlDisclosureRanges,
  interpret,
  interpretCaptured,
  requestTarget,
  type V1Connector,
  type V2Connector,
} from '@/lib/zktls/interpreter'
import { assertVerifierProfile, ZKTLS_PROFILE } from '@/lib/zktls/profile'
import { assertTicketAvailable, type Ticket } from '@/lib/zktls/signed-config'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/

type CommonProveMessage = {
  id: string
  type: 'zktls-worker-prove'
  sessionId: string
  connectorId: string
  ticket: Ticket
}
type V1ProveMessage = CommonProveMessage & {
  config: V1Connector
  identity: string
  cookie: string
}
type V2ProveMessage = CommonProveMessage & {
  config: V2Connector
  captured: CapturedRequest
}
type ProveMessage = V1ProveMessage | V2ProveMessage

function isV1Message(message: ProveMessage): message is V1ProveMessage {
  return message.config.interpreter_version === 1
}

type SocketIo = {
  read: () => Promise<Uint8Array | null>
  write: (bytes: Uint8Array) => Promise<void>
  close: () => Promise<void>
}

type Range = { start: number; end: number }
type RevealRange = Range & {
  handler: {
    type: 'SENT' | 'RECV'
    part: 'START_LINE' | 'BODY'
    action: { kind: 'REVEAL' }
  }
}

export function sessionRegistrationPayload(message: ProveMessage): object {
  return {
    type: 'register',
    maxRecvData: message.config.request.max_recv_data,
    maxSentData: message.config.request.max_sent_data,
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
  hostname: string,
): { verifierUrl: string; proxyUrl: string } {
  if (!TOKEN.test(registeredSessionId) || !hostname) {
    throw new Error('verifier rejected session')
  }
  const base = new URL(endpoint)
  const verifier = new URL('/verifier', base)
  verifier.searchParams.set('sessionId', registeredSessionId)
  const proxy = new URL('/proxy', base)
  proxy.searchParams.set('token', hostname)
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

async function registerSession(
  message: ProveMessage,
  hostname: string,
): Promise<{
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
          ...verifierUrls(endpoint, value.sessionId, hostname),
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

export function revealConfig(
  message: ProveMessage,
  sent: Uint8Array,
  received: Uint8Array,
): { sent: RevealRange[]; recv: RevealRange[] } {
  if (message.config.response_format !== 'html')
    throw new Error('JSON connectors are unsupported by this runtime')
  const response = decoder.decode(received)
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
    const ranges = htmlBetweenDisclosureRanges(message.config, response)
    interpretCaptured(message.config, {
      response,
      status: parsedStatus,
      now: new Date().toISOString(),
    })
    disclosure = ranges
  }
  return {
    sent: [
      {
        ...requestStartLineRange(sent, message.config.request.method, path),
        handler: {
          type: 'SENT',
          part: 'START_LINE',
          action: { kind: 'REVEAL' },
        },
      },
    ],
    recv: [
      {
        ...responseStatusLineRange(received),
        handler: {
          type: 'RECV',
          part: 'START_LINE',
          action: { kind: 'REVEAL' },
        },
      },
      {
        ...disclosure.prefix,
        handler: { type: 'RECV', part: 'BODY', action: { kind: 'REVEAL' } },
      },
      {
        ...disclosure.suffix,
        handler: { type: 'RECV', part: 'BODY', action: { kind: 'REVEAL' } },
      },
      {
        ...disclosure.value,
        handler: { type: 'RECV', part: 'BODY', action: { kind: 'REVEAL' } },
      },
    ],
  }
}

function assertAvailable(message: ProveMessage): void {
  const now = new Date().toISOString()
  assertConnectorAvailable(message.config, now)
  assertTicketAvailable(message.ticket, now)
  assertVerifierProfile(message.config)
}

function assertCapturedRequest(message: V2ProveMessage): void {
  if (message.captured.path !== message.config.request.path)
    throw new Error('captured request did not match the signed provider')
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

async function prove(message: ProveMessage): Promise<void> {
  if (message.config.response_format !== 'html')
    throw new Error('JSON connectors are unsupported by this runtime')
  const wasm = await import('tlsn-wasm')
  await wasm.default()
  await wasm.initialize(null, 1)
  const origin = new URL(message.config.origin)
  assertAvailable(message)
  if (!isV1Message(message)) assertCapturedRequest(message)
  const registration = await registerSession(message, origin.hostname)
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
    const path = isV1Message(message)
      ? requestTarget(message.config, message.identity)
      : message.captured.path
    const secrets = isV1Message(message)
      ? { cookie: message.cookie }
      : message.captured.secrets
    await prover.send_request(await websocketIo(registration.proxyUrl), {
      uri: path,
      method: 'GET',
      headers: new Map<string, number[]>([
        ['host', Array.from(encoder.encode(origin.hostname))],
        ['accept-encoding', Array.from(encoder.encode('identity'))],
        ['connection', Array.from(encoder.encode('close'))],
        ...Object.entries(message.config.request.headers).map(
          ([key, value]) =>
            [key, Array.from(encoder.encode(value))] as [string, number[]],
        ),
        ...Object.entries(secrets).map(
          ([key, value]) =>
            [key, Array.from(encoder.encode(value))] as [string, number[]],
        ),
      ]),
      body: undefined,
    })
    clearSecrets(secrets)
    const transcript = prover.transcript()
    const received = new Uint8Array(transcript.recv)
    if (received.length >= message.config.request.max_recv_data)
      throw new Error('response exceeded the signed receive limit')
    const config = revealConfig(
      message,
      new Uint8Array(transcript.sent),
      received,
    )
    registration.socket.send(
      JSON.stringify({ type: 'reveal_config', ...config }),
    )
    await prover.reveal(
      {
        sent: config.sent.map(({ start, end }) => ({ start, end })),
        recv: config.recv.map(({ start, end }) => ({ start, end })),
        server_identity: true,
      },
      null,
    )
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
        const secrets = message.captured.secrets
        message.captured.secrets = {}
        return prove({
          ...message,
          captured: { ...message.captured, secrets },
        }).finally(() => {
          clearSecrets(secrets)
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
