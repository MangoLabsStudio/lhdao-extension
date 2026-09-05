import { describe, expect, it, vi } from 'vitest'
import { CandidateStore } from '../zktls/discovery/candidate-store'
import { DiscoverySampleUploader } from '../zktls/discovery/sample-uploader'

function candidate() {
  const store = new CandidateStore()
  store.add({
    method: 'POST',
    url: 'https://archive.example/v1',
    documentUrl: 'https://app.example/history',
    requestBody: '{"events":{}}',
    requestHeaders: {
      'content-type': 'application/json',
      authorization: 'Bearer secret',
    },
    contentType: 'application/json',
    responseBody: '{"amount":"100","token":"secret"}',
    status: 200,
  })
  return store.snapshot().candidates[0]!
}

describe('discovery sample uploader', () => {
  it('checks the backend page origin before any data upload', async () => {
    const send = vi.fn().mockResolvedValue({
      sessionId: 'server',
      batchId: 'handshake',
      pageOrigin: 'https://other.example',
    })
    const uploader = new DiscoverySampleUploader(
      'server',
      'https://app.example',
      send,
      () => {},
    )
    await expect(uploader.connect()).rejects.toThrow(
      'DISCOVERY_ORIGIN_MISMATCH',
    )
    expect(send.mock.calls[0][0].candidates).toEqual([])
  })

  it('retains a failed batch and reuses its ID on manual retry without leaking credentials', async () => {
    const send = vi.fn(async (input) => ({
      ...input,
      pageOrigin: 'https://app.example',
    }))
    const uploader = new DiscoverySampleUploader(
      'server',
      'https://app.example',
      send,
      () => {},
    )
    await uploader.connect()
    send.mockRejectedValueOnce(new Error('offline'))
    uploader.enqueue([candidate()])
    await uploader.flush()
    expect(uploader.snapshot().candidates[0].status).toBe('failed')
    await uploader.retry()
    expect(send.mock.calls[1][0].batchId).toBe(send.mock.calls[2][0].batchId)
    expect(JSON.stringify(send.mock.calls[1][0])).not.toContain('secret')
    expect(uploader.snapshot().candidates[0].status).toBe('uploaded')
  })

  it('coalesces newer candidate snapshots and does not reupload unchanged data', async () => {
    const send = vi.fn(async (input) => ({
      ...input,
      pageOrigin: 'https://app.example',
    }))
    const uploader = new DiscoverySampleUploader(
      'server',
      'https://app.example',
      send,
      () => {},
    )
    await uploader.connect()
    const first = candidate()
    uploader.enqueue([first])
    await uploader.flush()
    uploader.enqueue([first])
    await uploader.flush()
    expect(send).toHaveBeenCalledTimes(2)
    uploader.enqueue([{ ...first, occurrences: 2 }])
    await uploader.flush()
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('does not send pending samples after disposal', async () => {
    const send = vi.fn(async (input) => ({
      ...input,
      pageOrigin: 'https://app.example',
    }))
    const uploader = new DiscoverySampleUploader(
      'server',
      'https://app.example',
      send,
      () => {},
    )
    await uploader.connect()
    uploader.enqueue([candidate()])
    uploader.dispose()
    await uploader.flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('drains an earlier candidate updated while a later candidate is uploading', async () => {
    let resume!: () => void
    const send = vi.fn(async (input) => {
      if (input.candidates[0]?.candidateId === 'second')
        await new Promise<void>((resolve) => {
          resume = resolve
        })
      return { ...input, pageOrigin: 'https://app.example' }
    })
    const uploader = new DiscoverySampleUploader(
      'server',
      'https://app.example',
      send,
      () => {},
    )
    await uploader.connect()
    const first = candidate()
    uploader.enqueue([first, { ...first, candidateId: 'second' }])
    const flushed = uploader.flush()
    await vi.waitFor(() => expect(resume).toBeTypeOf('function'))
    uploader.enqueue([{ ...first, occurrences: 2 }])
    void uploader.flush()
    resume()
    await flushed
    expect(
      uploader
        .snapshot()
        .candidates.every((item) => item.status === 'uploaded'),
    ).toBe(true)
    expect(send.mock.calls.at(-1)?.[0].candidates[0].occurrences).toBe(2)
  })
})
