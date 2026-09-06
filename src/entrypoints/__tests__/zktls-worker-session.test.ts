import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ZKTLS_PROFILE } from '@/lib/zktls/profile'
import { registerSession, websocketIo } from '../zktls-offscreen/worker'

class Socket {
  static latest: Socket
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null
  send = vi.fn()
  close = vi.fn()
  constructor() {
    Socket.latest = this
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}

function message(): Parameters<typeof registerSession>[0] {
  const entry = JSON.parse(
    readFileSync(
      'test/fixtures/product-zktls-discovery-workbench.json',
      'utf8',
    ),
  ).cases[0]
  return {
    type: 'zktls-worker-prove',
    id: 'job',
    sessionId: entry.registration.ticket.session_id,
    connectorId: entry.connector.connector_id,
    config: entry.connector,
    ticket: entry.registration.ticket,
    configEnvelope: {
      key_id: entry.registration.keyId,
      config: entry.connector,
      config_digest: entry.configDigest,
      signature: entry.registration.configSignature,
    },
    ticketEnvelope: {
      key_id: entry.registration.keyId,
      ticket: entry.registration.ticket,
      signature: entry.registration.ticketSignature,
    },
    captured: { path: '/v1', secrets: {} },
  }
}

const originalEndpoint = ZKTLS_PROFILE.verifierEndpoint
beforeEach(() => {
  vi.stubGlobal('WebSocket', Socket)
  ZKTLS_PROFILE.verifierEndpoint = 'wss://verifier.test/session'
})
afterEach(() => {
  vi.unstubAllGlobals()
  ZKTLS_PROFILE.verifierEndpoint = originalEndpoint
})

test('preserves the verifier terminal message and safe stage metadata', async () => {
  const pending = registerSession(message())
  Socket.latest.message({
    type: 'session_registered',
    sessionId: 'server-session',
  })
  const session = await pending
  const result = expect(session.completion).rejects.toMatchObject({
    message: 'verification failed',
    code: 'VERIFY_TIMEOUT',
    stage: 'accept',
    reason: 'deadline exceeded',
  })
  Socket.latest.message({
    type: 'error',
    message: 'verification failed',
    code: 'VERIFY_TIMEOUT',
    stage: 'accept',
    reason: 'deadline exceeded',
    authorization: 'never copy me',
  })
  await result
  await session.completion.catch((error) =>
    expect(error.authorization).toBeUndefined(),
  )
})

test('rejects a close before registration instead of leaving registration pending', async () => {
  const pending = registerSession(message())
  const result = expect(pending).rejects.toMatchObject({
    code: 'VERIFIER_SESSION_CLOSED',
    closeCode: 1006,
  })
  Socket.latest.onclose?.({ code: 1006, reason: '', wasClean: false })
  await result
})

test('interrupts pending local work on verifier failure', async () => {
  const pending = registerSession(message())
  Socket.latest.message({
    type: 'session_registered',
    sessionId: 'server-session',
  })
  const session = await pending
  const continued = vi.fn()
  const failed = vi.fn()
  const result = session
    .waitFor(new Promise<void>(() => {}))
    .then(continued, failed)
  Socket.latest.message({ type: 'error', message: 'verification failed' })
  await result
  expect(continued).not.toHaveBeenCalled()
  expect(failed).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'verification failed' }),
  )
})

test('server completion cannot skip unfinished local proof work', async () => {
  const pending = registerSession(message())
  Socket.latest.message({
    type: 'session_registered',
    sessionId: 'server-session',
  })
  const session = await pending
  let finish!: () => void
  const continued = vi.fn()
  const result = session
    .waitFor(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    .then(continued)
  Socket.latest.message({ type: 'session_completed' })
  await session.completion
  await Promise.resolve()
  expect(continued).not.toHaveBeenCalled()
  finish()
  await result
  expect(continued).toHaveBeenCalledOnce()
})

test('rejects completion before registration as a protocol error', async () => {
  const pending = registerSession(message())
  const result = expect(pending).rejects.toThrow('verifier rejected session')
  Socket.latest.message({ type: 'session_completed' })
  await result
})

test('rejects an invalid registration identifier without hanging', async () => {
  const pending = registerSession(message())
  const result = expect(pending).rejects.toThrow('verifier rejected session')
  Socket.latest.message({ type: 'session_registered', sessionId: '../secret' })
  await result
  expect(Socket.latest.close).toHaveBeenCalledOnce()
})

test('closes pending binary reads on cancellation', async () => {
  const controller = new AbortController()
  const pending = websocketIo('wss://verifier.test/verifier', controller.signal)
  Socket.latest.onopen?.()
  const io = await pending
  const read = io.read()
  controller.abort()
  await expect(read).resolves.toBeNull()
  expect(Socket.latest.close).toHaveBeenCalledOnce()
})

test('rejects transport closure before open without waiting for the job timeout', async () => {
  const pending = websocketIo(
    'wss://verifier.test/verifier',
    new AbortController().signal,
  )
  const result = expect(pending).rejects.toMatchObject({ closeCode: 1006 })
  Socket.latest.onclose?.({ code: 1006, reason: '', wasClean: false })
  await result
})
