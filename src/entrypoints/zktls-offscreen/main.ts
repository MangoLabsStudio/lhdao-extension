type Result = { status: 'submitted' | 'error'; code?: string }
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
})
const pending = new Map<string, (result: Result) => void>()

worker.addEventListener(
  'message',
  (event: MessageEvent<{ id?: string; result?: Result }>) => {
    const id = event.data?.id
    if (!id) return
    const done = pending.get(id)
    if (!done) return
    pending.delete(id)
    done(event.data.result ?? { status: 'error', code: 'PROVER_FAILED' })
  },
)

chrome.runtime.onMessage.addListener((message) => {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { type?: unknown }).type !== 'zktls-offscreen-prove'
  )
    return
  const id = crypto.randomUUID()
  return new Promise<Result>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ status: 'error', code: 'PROVER_TIMEOUT' })
    }, 60_000)
    pending.set(id, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    worker.postMessage({
      ...(message as Record<string, unknown>),
      id,
      type: 'zktls-worker-prove',
    })
  })
})
