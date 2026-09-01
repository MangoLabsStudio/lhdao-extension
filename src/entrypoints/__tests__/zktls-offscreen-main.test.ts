import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type Result = { status: 'submitted' | 'error'; code?: string }
type RuntimeListener = (message: Record<string, unknown>) => Promise<Result>
type WorkerListener = (event: Event) => void

class FakeWorker {
  static instances: FakeWorker[] = []

  readonly posts: Record<string, unknown>[] = []
  readonly terminate = vi.fn()
  readonly listeners = new Map<string, WorkerListener[]>()

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this)
  }

  postMessage(message: Record<string, unknown>): void {
    this.posts.push(structuredClone(message))
  }

  addEventListener(type: string, listener: WorkerListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  emit(type: 'message' | 'error', data: unknown): void {
    const event =
      type === 'message'
        ? new MessageEvent(type, { data })
        : new ErrorEvent(type, { message: String(data) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

let runtimeListener: RuntimeListener

async function loadOffscreen(): Promise<void> {
  vi.stubGlobal('Worker', FakeWorker)
  vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation(((
    listener: RuntimeListener,
  ) => {
    runtimeListener = listener
  }) as never)
  await import('../zktls-offscreen/main')
}

function proofMessage(): Record<string, unknown> {
  return {
    type: 'zktls-offscreen-prove',
    sessionId: 'session-1',
    connectorId: 'connector-1',
    correlationId: 'proof-correlation-1',
    cookie: 'private-cookie',
    captured: {
      path: '/private',
      body: '{"private":true}',
      content_type: 'application/json',
      secrets: { authorization: 'private-token' },
    },
  }
}

describe('zkTLS offscreen worker lifecycle', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    FakeWorker.instances = []
    await loadOffscreen()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('terminates a hung worker once and uses a fresh generation', async () => {
    const firstMessage = proofMessage()
    const firstCapture = firstMessage.captured as {
      path: string
      body: string
      secrets: Record<string, string>
    }
    const first = runtimeListener(firstMessage)
    const oldWorker = FakeWorker.instances[0]!
    const oldId = oldWorker.posts[0]!.id

    expect(oldWorker.posts[0]).toMatchObject({
      cookie: 'private-cookie',
      captured: {
        path: '/private',
        body: '{"private":true}',
        secrets: { authorization: 'private-token' },
      },
    })
    expect(firstMessage.captured).toBeUndefined()
    expect(firstMessage.cookie).toBe('')
    expect(firstCapture).toMatchObject({ path: '', body: '', secrets: {} })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(oldWorker.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(oldWorker.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(180_000)
    await expect(first).resolves.toEqual({
      status: 'error',
      code: 'PROVER_TIMEOUT',
    })
    expect(oldWorker.terminate).toHaveBeenCalledTimes(1)

    const second = runtimeListener(proofMessage())
    const newWorker = FakeWorker.instances[1]!
    expect(newWorker).toBeDefined()
    expect(newWorker).not.toBe(oldWorker)

    oldWorker.emit('message', {
      id: oldId,
      result: { status: 'submitted' },
    })
    expect(newWorker.terminate).not.toHaveBeenCalled()

    newWorker.emit('message', {
      id: newWorker.posts[0]!.id,
      result: { status: 'submitted' },
    })
    await expect(second).resolves.toEqual({ status: 'submitted' })
    expect(newWorker.terminate).not.toHaveBeenCalled()
  })

  test('rejects a concurrent proof before posting and clears its secrets', async () => {
    const first = runtimeListener(proofMessage())
    const worker = FakeWorker.instances[0]!
    const busyMessage = proofMessage()
    const busyCapture = busyMessage.captured as {
      path: string
      body: string
      secrets: Record<string, string>
    }

    await expect(runtimeListener(busyMessage)).resolves.toEqual({
      status: 'error',
      code: 'PROVER_BUSY',
    })
    expect(worker.posts).toHaveLength(1)
    expect(busyMessage.cookie).toBe('')
    expect(busyMessage.captured).toBeUndefined()
    expect(busyCapture).toMatchObject({ path: '', body: '', secrets: {} })

    worker.emit('message', {
      id: worker.posts[0]!.id,
      result: { status: 'submitted' },
    })
    await first

    const next = runtimeListener(proofMessage())
    expect(worker.posts).toHaveLength(2)
    worker.emit('message', {
      id: worker.posts[1]!.id,
      result: { status: 'submitted' },
    })
    await expect(next).resolves.toEqual({ status: 'submitted' })
  })

  test('forwards worker proof diagnostics without settling the proof', async () => {
    const sendMessage = vi
      .spyOn(chrome.runtime, 'sendMessage')
      .mockResolvedValue(undefined)
    const message = {
      ...proofMessage(),
      correlationId: 'proof-correlation-1',
    }
    const proving = runtimeListener(message)
    const worker = FakeWorker.instances[0]!
    const id = worker.posts[0]!.id

    worker.emit('message', {
      id,
      diagnostic: {
        at: 123,
        stage: 'tls-transcript-received',
        status: 'passed',
        details: { sentBytes: 100, receivedBytes: 200 },
      },
    })

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'product-experience-proof-diagnostic',
        sessionId: 'session-1',
        connectorId: 'connector-1',
        correlationId: 'proof-correlation-1',
        event: {
          at: 123,
          stage: 'tls-transcript-received',
          status: 'passed',
          details: { sentBytes: 100, receivedBytes: 200 },
        },
      }),
    )

    worker.emit('message', {
      id,
      result: { status: 'submitted' },
    })
    await expect(proving).resolves.toEqual({ status: 'submitted' })
  })

  test('waits for queued diagnostics before settling the final result', async () => {
    let finishDiagnostic: (() => void) | undefined
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDiagnostic = resolve
        }) as never,
    )
    const proving = runtimeListener(proofMessage())
    const worker = FakeWorker.instances[0]!
    const id = worker.posts[0]!.id
    let settled = false
    void proving.then(() => {
      settled = true
    })

    worker.emit('message', {
      id,
      diagnostic: {
        at: 123,
        stage: 'verifier-session-registered:failed',
        status: 'failed',
        error: { message: 'connection refused' },
      },
    })
    worker.emit('message', {
      id,
      result: { status: 'error', code: 'PROVER_FAILED' },
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    finishDiagnostic?.()
    await expect(proving).resolves.toEqual({
      status: 'error',
      code: 'PROVER_FAILED',
    })
  })

  test('ignores a late old-generation result even when request IDs repeat', async () => {
    const repeatedId = '00000000-0000-4000-8000-000000000000'
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(repeatedId)
    const first = runtimeListener(proofMessage())
    const oldWorker = FakeWorker.instances[0]!
    await vi.advanceTimersByTimeAsync(300_000)
    await first

    const second = runtimeListener(proofMessage())
    const newWorker = FakeWorker.instances[1]!
    oldWorker.emit('message', {
      id: repeatedId,
      result: { status: 'submitted' },
    })
    expect(newWorker.terminate).not.toHaveBeenCalled()

    newWorker.emit('message', {
      id: repeatedId,
      result: { status: 'error', code: 'EXPECTED_NEW_RESULT' },
    })
    await expect(second).resolves.toEqual({
      status: 'error',
      code: 'EXPECTED_NEW_RESULT',
    })
    expect(uuid).toHaveBeenCalledTimes(2)
  })

  test('retires an errored worker and creates a new one for the next proof', async () => {
    const first = runtimeListener(proofMessage())
    const broken = FakeWorker.instances[0]!
    broken.emit('error', 'wasm setup failed')

    await expect(first).resolves.toEqual({
      status: 'error',
      code: 'PROVER_FAILED',
    })
    expect(broken.terminate).toHaveBeenCalledTimes(1)

    const second = runtimeListener(proofMessage())
    const replacement = FakeWorker.instances[1]!
    replacement.emit('message', {
      id: replacement.posts[0]!.id,
      result: { status: 'submitted' },
    })
    await expect(second).resolves.toEqual({ status: 'submitted' })
  })

  test('first settlement cancels the timeout without retiring the worker', async () => {
    const first = runtimeListener(proofMessage())
    const worker = FakeWorker.instances[0]!
    worker.emit('message', {
      id: worker.posts[0]!.id,
      result: { status: 'submitted' },
    })
    await expect(first).resolves.toEqual({ status: 'submitted' })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.terminate).not.toHaveBeenCalled()

    const second = runtimeListener(proofMessage())
    expect(FakeWorker.instances).toHaveLength(1)
    worker.emit('message', {
      id: worker.posts[1]!.id,
      result: { status: 'submitted' },
    })
    await expect(second).resolves.toEqual({ status: 'submitted' })
  })
})
