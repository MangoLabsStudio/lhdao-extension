import { DISCOVERY_LIMITS, type DiscoveryCandidate } from './candidate-store'
import { byteLength } from './redaction'

export type DiscoveryUploadBatch = {
  sessionId: string
  batchId: string
  candidates: DiscoveryCandidate[]
}
export type DiscoveryUploadState = {
  sessionId: string
  error: string | null
  candidates: {
    candidateId: string
    status: 'pending' | 'uploading' | 'uploaded' | 'failed'
    error: string | null
  }[]
}
export type SendDiscoveryBatch = (
  input: DiscoveryUploadBatch,
) => Promise<{ sessionId: string; batchId: string; pageOrigin: string }>

export const PRODUCT_DISCOVERY_UPLOAD_DOCUMENT =
  'mutation UploadProductDiscoveryBatch($sessionId: String!, $batchId: String!, $candidates: JSON!) { uploadProductDiscoveryBatch(sessionId: $sessionId, batchId: $batchId, candidates: $candidates) }'

type Entry = DiscoveryUploadState['candidates'][number] & {
  latest: string
  uploaded?: string
  batch?: { batchId: string; json: string }
}

export function discoveryUploadError(error: unknown): string {
  const value = error as {
    graphqlErrors?: { extensions?: { code?: unknown } }[]
    httpStatus?: number
    message?: string
  }
  const code = value?.graphqlErrors?.[0]?.extensions?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(code))
    return code
  if (value?.httpStatus) return `HTTP_${value.httpStatus}`
  if (
    typeof value?.message === 'string' &&
    /^DISCOVERY_[A-Z_]+$/.test(value.message)
  )
    return value.message
  return 'DISCOVERY_UPLOAD_NETWORK_ERROR'
}

export class DiscoverySampleUploader {
  private entries = new Map<string, Entry>()
  private connected = false
  private disposed = false
  private running?: Promise<void>
  private error: string | null = null
  constructor(
    private sessionId: string,
    private pageOrigin: string,
    private send: SendDiscoveryBatch,
    private changed: () => void,
  ) {}
  async connect() {
    try {
      const batchId = crypto.randomUUID()
      const result = await this.send({
        sessionId: this.sessionId,
        batchId,
        candidates: [],
      })
      if (result.pageOrigin !== this.pageOrigin)
        throw new Error('DISCOVERY_ORIGIN_MISMATCH')
      if (result.sessionId !== this.sessionId || result.batchId !== batchId)
        throw new Error('DISCOVERY_UPLOAD_INVALID_RESPONSE')
      this.connected = !this.disposed
    } catch (error) {
      this.error = discoveryUploadError(error)
      throw error
    }
  }
  enqueue(candidates: DiscoveryCandidate[]) {
    if (!this.connected || this.disposed) return
    // CandidateStore already bounds/redacts these snapshots. Keep at most one
    // newer revision per in-flight/failed candidate; never change a retry's body.
    for (const candidate of candidates) {
      const latest = JSON.stringify(candidate)
      const current = this.entries.get(candidate.candidateId)
      if (current?.latest === latest) continue
      const bytes =
        [...this.entries.values()].reduce(
          (sum, entry) => sum + byteLength(entry.latest),
          0,
        ) -
        (current ? byteLength(current.latest) : 0) +
        byteLength(latest)
      if (
        (!current && this.entries.size >= DISCOVERY_LIMITS.candidates) ||
        bytes > DISCOVERY_LIMITS.sessionBytes
      )
        throw new Error('DISCOVERY_UPLOAD_QUOTA_REACHED')
      if (current) {
        current.latest = latest
        if (current.status === 'uploaded') current.status = 'pending'
      } else
        this.entries.set(candidate.candidateId, {
          candidateId: candidate.candidateId,
          latest,
          status: 'pending',
          error: null,
        })
    }
    this.changed()
  }
  flush(): Promise<void> {
    if (this.running) return this.running
    if (!this.connected || this.disposed) return Promise.resolve()
    this.running = this.drain().finally(() => {
      this.running = undefined
    })
    return this.running
  }
  private async drain() {
    while (!this.disposed) {
      const entry = [...this.entries.values()].find(
        (item) => item.status === 'pending',
      )
      if (!entry) return
      entry.batch ??= { batchId: crypto.randomUUID(), json: entry.latest }
      const batch = entry.batch
      entry.status = 'uploading'
      this.changed()
      try {
        const result = await this.send({
          sessionId: this.sessionId,
          batchId: batch.batchId,
          candidates: [JSON.parse(batch.json)],
        })
        if (this.disposed) return
        if (
          result.sessionId !== this.sessionId ||
          result.batchId !== batch.batchId ||
          result.pageOrigin !== this.pageOrigin
        )
          throw new Error('DISCOVERY_UPLOAD_INVALID_RESPONSE')
        entry.uploaded = batch.json
        entry.batch = undefined
        entry.error = null
        entry.status = entry.latest === entry.uploaded ? 'uploaded' : 'pending'
      } catch (error) {
        if (this.disposed) return
        entry.status = 'failed'
        entry.error = discoveryUploadError(error)
      }
      this.changed()
    }
  }
  async retry() {
    await this.running
    for (const entry of this.entries.values())
      if (entry.status === 'failed') entry.status = 'pending'
    return this.flush()
  }
  snapshot(): DiscoveryUploadState {
    return {
      sessionId: this.sessionId,
      error: this.error,
      candidates: [...this.entries.values()].map(
        ({ candidateId, status, error }) => ({ candidateId, status, error }),
      ),
    }
  }
  dispose() {
    this.disposed = true
    this.entries.clear()
  }
}
