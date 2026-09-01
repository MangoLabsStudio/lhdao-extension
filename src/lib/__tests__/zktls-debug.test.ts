import { describe, expect, it, vi } from 'vitest'
import {
  appendProductZkTlsDiagnostic,
  createProductZkTlsDiagnostic,
  createZkTlsDebugTrace,
  redactZkTlsHttpTranscript,
  sanitizeZkTlsDebugValue,
} from '../zktls/debug'

describe('zkTLS local diagnostics', () => {
  it('keeps public proof data and redacts nested credentials without reading accessors', () => {
    const secretGetter = vi.fn(() => 'never-read')
    const input = {
      method: 'POST',
      body: { events: [{ amount: '193.425611' }] },
      headers: {
        cookie: 'session=secret',
        authorization: 'Bearer secret',
        'x-nado-client-type': 'nado',
      },
      captured: {
        secrets: { 'x-api-key': 'private-key' },
        pluginToken: 'lhdao_pk_private',
      },
    }
    Object.defineProperty(input, 'macKey', {
      enumerable: true,
      get: secretGetter,
    })

    expect(sanitizeZkTlsDebugValue(input)).toEqual({
      method: 'POST',
      body: { events: [{ amount: '193.425611' }] },
      headers: {
        cookie: { present: true, length: 14 },
        authorization: { present: true, length: 13 },
        'x-nado-client-type': 'nado',
      },
      captured: {
        secrets: { present: true, length: 1 },
        pluginToken: { present: true, length: 16 },
      },
      macKey: '[accessor]',
    })
    expect(secretGetter).not.toHaveBeenCalled()
  })

  it('redacts sensitive HTTP headers while preserving the complete public body', () => {
    const transcript = new TextEncoder().encode(
      [
        'HTTP/1.1 200 OK',
        'Content-Type: application/json',
        'Set-Cookie: cf=secret',
        'Authorization: Bearer secret',
        '',
        '{"events":[{"amount":"193.425611"}]}',
      ].join('\r\n'),
    )

    const redacted = redactZkTlsHttpTranscript(transcript)
    expect(redacted).toContain('Content-Type: application/json')
    expect(redacted).toContain('{"events":[{"amount":"193.425611"}]}')
    expect(redacted).toContain('Set-Cookie: [redacted length=9]')
    expect(redacted).toContain('Authorization: [redacted length=13]')
    expect(redacted).not.toContain('cf=secret')
    expect(redacted).not.toContain('Bearer secret')
  })

  it('writes ordered stages only when enabled and contains logger failures', () => {
    const write = vi.fn()
    const trace = createZkTlsDebugTrace({
      enabled: true,
      correlationId: 'proof-1',
      write,
    })
    trace.stage('captured-request', { body: { value: 1 } })
    trace.fail('response-validation', new Error('failed for Bearer secret'), [
      'Bearer secret',
    ])

    expect(write).toHaveBeenCalledTimes(2)
    const output = JSON.stringify(write.mock.calls)
    expect(output).toContain('captured-request')
    expect(output).toContain('response-validation')
    expect(output).toContain('proof-1')
    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain('Bearer secret')

    const disabled = vi.fn()
    createZkTlsDebugTrace({
      enabled: false,
      correlationId: 'proof-2',
      write: disabled,
    }).stage('ignored')
    expect(disabled).not.toHaveBeenCalled()

    const throwing = createZkTlsDebugTrace({
      enabled: true,
      correlationId: 'proof-3',
      write: () => {
        throw new Error('console unavailable')
      },
    })
    expect(() => throwing.stage('safe')).not.toThrow()
  })

  it('prints binary HTTP bodies as complete base64', () => {
    const header = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n',
    )
    const transcript = new Uint8Array([...header, 0xff, 0x00, 0x80])
    expect(redactZkTlsHttpTranscript(transcript)).toContain('[body base64]/wCA')
  })

  it('stores bounded redacted popup diagnostics with exact error fields', () => {
    let attempt = createProductZkTlsDiagnostic('correlation-1', 100)
    attempt = appendProductZkTlsDiagnostic(
      attempt,
      {
        at: 101,
        stage: 'capture-failed',
        status: 'failed',
        details: { body: { amount: '193.425611' } },
        error: Object.assign(new Error('socket closed for Bearer abc'), {
          code: 'PROVER_FAILED',
        }),
      },
      ['Bearer abc'],
    )

    expect(attempt).toMatchObject({
      correlationId: 'correlation-1',
      startedAt: 100,
      updatedAt: 101,
    })
    expect(attempt.events[0]).toMatchObject({
      details: { body: { amount: '193.425611' } },
      error: {
        name: 'Error',
        message: 'socket closed for [REDACTED]',
        code: 'PROVER_FAILED',
      },
    })
    expect(JSON.stringify(attempt)).not.toContain('Bearer abc')

    for (let index = 0; index < 35; index += 1) {
      attempt = appendProductZkTlsDiagnostic(attempt, {
        at: 102 + index,
        stage: `stage-${index}`,
        status: 'passed',
      })
    }
    expect(attempt.events).toHaveLength(30)
    expect(attempt.events[0]?.stage).toBe('stage-5')
  })

  it('replaces oversized diagnostic values with a size marker', () => {
    const attempt = appendProductZkTlsDiagnostic(
      createProductZkTlsDiagnostic('correlation-2', 200),
      {
        at: 201,
        stage: 'captured-response',
        status: 'passed',
        details: { body: 'x'.repeat(65_537) },
      },
    )

    expect(attempt.events[0]?.details).toMatchObject({
      truncated: true,
    })
    expect(
      (attempt.events[0]?.details as { byteLength: number }).byteLength,
    ).toBeGreaterThan(65_536)
  })
})
