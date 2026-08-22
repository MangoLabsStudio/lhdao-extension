import { type CapturedRequest, clearCapturedRequest } from '@/lib/zktls/capture'

type Result = { status: 'submitted' | 'error'; code?: string }
type Generation = {
  worker: Worker
  token: symbol
  terminated: boolean
}
type Pending = {
  id: string
  generation: Generation
  timer: ReturnType<typeof setTimeout>
  settled: boolean
  resolve: (result: Result) => void
}

const pending = new Map<string, Pending>()
let current: Generation | null = null

function settle(job: Pending, result: Result): boolean {
  if (job.settled) return false
  job.settled = true
  clearTimeout(job.timer)
  if (pending.get(job.id) === job) pending.delete(job.id)
  job.resolve(result)
  return true
}

function retire(generation: Generation): void {
  if (generation.terminated) return
  generation.terminated = true
  generation.worker.terminate()
  if (current === generation) current = null
}

function failGeneration(generation: Generation): void {
  retire(generation)
  for (const job of pending.values()) {
    if (job.generation === generation)
      settle(job, { status: 'error', code: 'PROVER_FAILED' })
  }
}

function createWorker(): Generation {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  })
  const generation: Generation = {
    worker,
    token: Symbol('zktls-worker-generation'),
    terminated: false,
  }
  worker.addEventListener(
    'message',
    (event: MessageEvent<{ id?: string; result?: Result }>) => {
      const id = event.data?.id
      if (!id || generation.terminated) return
      const job = pending.get(id)
      if (!job || job.generation.token !== generation.token) return
      settle(
        job,
        event.data.result ?? { status: 'error', code: 'PROVER_FAILED' },
      )
    },
  )
  worker.addEventListener('error', () => failGeneration(generation))
  current = generation
  return generation
}

function activeWorker(): Generation {
  return current && !current.terminated ? current : createWorker()
}

function clearProofMessage(message: Record<string, unknown>): void {
  if (typeof message.cookie === 'string') message.cookie = ''
  const captured = message.captured
  try {
    if (
      captured &&
      typeof captured === 'object' &&
      typeof (captured as { path?: unknown }).path === 'string' &&
      (captured as { secrets?: unknown }).secrets &&
      typeof (captured as { secrets?: unknown }).secrets === 'object'
    )
      clearCapturedRequest(captured as CapturedRequest)
  } finally {
    message.captured = undefined
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { type?: unknown }).type !== 'zktls-offscreen-prove'
  )
    return
  const proofMessage = message as Record<string, unknown>
  if (pending.size > 0) {
    clearProofMessage(proofMessage)
    return Promise.resolve<Result>({
      status: 'error',
      code: 'PROVER_BUSY',
    })
  }
  const id = crypto.randomUUID()
  return new Promise<Result>((resolve) => {
    let generation: Generation
    try {
      generation = activeWorker()
    } catch {
      clearProofMessage(proofMessage)
      resolve({ status: 'error', code: 'PROVER_FAILED' })
      return
    }
    const job: Pending = {
      id,
      generation,
      settled: false,
      resolve,
      timer: setTimeout(() => {
        if (!settle(job, { status: 'error', code: 'PROVER_TIMEOUT' })) return
        retire(generation)
        for (const other of pending.values()) {
          if (other.generation === generation)
            settle(other, { status: 'error', code: 'PROVER_FAILED' })
        }
      }, 60_000),
    }
    pending.set(id, job)
    try {
      generation.worker.postMessage({
        ...proofMessage,
        id,
        type: 'zktls-worker-prove',
      })
    } catch {
      failGeneration(generation)
    } finally {
      clearProofMessage(proofMessage)
    }
  })
})
