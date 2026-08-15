import { describe, expect, test } from 'vitest'
import {
  revealConfig,
  sessionRegistrationPayload,
  verifierUrls,
} from '@/entrypoints/zktls-offscreen/worker'
import {
  configDigest,
  interpret,
  validateConnector,
} from '@/lib/zktls/interpreter'
import {
  parseZkTlsPageRequest,
  ZKTLS_PAGE_CHANNEL,
} from '@/lib/zktls/page-bridge'
import { parseZkTlsRuntimeRequest } from '@/lib/zktls/runtime-request'

const connector = {
  interpreter_version: 1,
  connector_id: 'github-login',
  revision: 1,
  disabled: false,
  expires_at: '2030-01-01T00:00:00.000Z',
  origin: 'https://github.com',
  identity_source: { kind: 'html_meta', name: 'user-login', max_bytes: 64 },
  request: {
    method: 'GET',
    path_template: '/me/${' + 'identity}',
    headers: { accept: 'application/json' },
    max_sent_data: 8192,
    max_recv_data: 65536,
  },
  response_format: 'json',
  response_status: 200,
  extraction: { kind: 'json_pointer', pointer: '/login' },
  verifier_profile_id: 'lighthouse-v1',
} as const

const htmlConnector = {
  ...connector,
  request: {
    ...connector.request,
    path_template: '/profile/${' + 'identity}',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  },
  response_format: 'html',
  extraction: {
    kind: 'html_literal_window',
    start: '<span data-user="',
    end: '"></span>',
    claim: `\${identity}`,
  },
} as const

const ticket = {
  schema: 1,
  session_id: 's1',
  connector_id: 'github-login',
  revision: 1,
  interpreter_version: 1,
  config_digest: 'a'.repeat(64),
  issued_at: '2026-08-15T00:00:00.000Z',
  expires_at: '2030-01-01T00:00:00.000Z',
  nonce: 'n1',
} as const

describe('zkTLS strict boundaries', () => {
  test('accepts only the fixed connector language', async () => {
    expect(validateConnector(connector)).toMatchObject({
      connector_id: 'github-login',
    })
    await expect(configDigest(connector)).resolves.toMatch(/^[a-f0-9]{64}$/)
    expect(
      interpret(connector, {
        response: '{"login":"octocat"}',
        status: 200,
        identity: 'octocat',
        now: '2026-08-15T00:00:00.000Z',
      }),
    ).toMatchObject({ claim: 'octocat', request_target: '/me/octocat' })
    expect(() =>
      validateConnector({ ...connector, origin: 'https://localhost' }),
    ).toThrow()
    expect(() =>
      validateConnector({
        ...connector,
        request: { ...connector.request, headers: { authorization: 'x' } },
      }),
    ).toThrow()
  })

  test('content parser rejects page-supplied config and extra fields', () => {
    const event = {
      source: globalThis.window,
      origin: 'https://app.lhdao.top',
      data: {
        channel: ZKTLS_PAGE_CHANNEL,
        type: 'prove',
        correlationId: 'c1',
        sessionId: 's1',
        connectorId: 'github-login',
      },
    } as unknown as MessageEvent
    expect(
      parseZkTlsPageRequest(
        event,
        globalThis.window,
        'https://app.lhdao.top',
        '/verify/s1',
      ),
    ).toMatchObject({ sessionId: 's1' })
    event.data.config = connector
    expect(
      parseZkTlsPageRequest(
        event,
        globalThis.window,
        'https://app.lhdao.top',
        '/verify/s1',
      ),
    ).toBeNull()
    const wrongPathEvent = {
      ...event,
      data: {
        channel: ZKTLS_PAGE_CHANNEL,
        type: 'prove',
        correlationId: 'c1',
        sessionId: 's1',
        connectorId: 'github-login',
      },
    } as unknown as MessageEvent
    expect(
      parseZkTlsPageRequest(
        wrongPathEvent,
        globalThis.window,
        'https://app.lhdao.top',
        '/verify/s2',
      ),
    ).toBeNull()
  })

  test('background parser independently requires exact sender origin and path', () => {
    const sender = {
      id: 'extension',
      frameId: 0,
      url: 'https://app.lhdao.top/verify/s1',
    } as chrome.runtime.MessageSender
    const request = {
      type: 'zktls-prove',
      correlationId: 'c1',
      sessionId: 's1',
      connectorId: 'github-login',
    }
    const runtime = globalThis.chrome.runtime
    Object.defineProperty(runtime, 'id', {
      value: 'extension',
      configurable: true,
    })
    expect(
      parseZkTlsRuntimeRequest(request, sender, 'https://app.lhdao.top'),
    ).toMatchObject({ connectorId: 'github-login' })
    expect(
      parseZkTlsRuntimeRequest(
        request,
        { ...sender, url: 'https://app.lhdao.top/verify/s2' },
        'https://app.lhdao.top',
      ),
    ).toBeNull()
    expect(
      parseZkTlsRuntimeRequest(
        { ...request, cookie: 'no' },
        sender,
        'https://app.lhdao.top',
      ),
    ).toBeNull()
  })

  test('uses the PR #11 verifier registration and complete replay ranges', () => {
    const message = {
      id: 'job1',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: 'github-login',
      config: htmlConnector,
      ticket,
      identity: 'octocat',
      cookie: 'session=secret',
    }
    expect(sessionRegistrationPayload(message)).toEqual({
      type: 'register',
      maxRecvData: 65536,
      maxSentData: 8192,
      sessionData: {
        session_id: 's1',
        connector_id: 'github-login',
        revision: '1',
        interpreter_version: '1',
        config_digest: 'a'.repeat(64),
        nonce: 'n1',
      },
    })
    expect(
      verifierUrls('ws://localhost:7047/session', 'registered1', 'github.com'),
    ).toEqual({
      verifierUrl: 'ws://localhost:7047/verifier?sessionId=registered1',
      proxyUrl: 'ws://localhost:7047/proxy?token=github.com',
    })
    const sent = new TextEncoder().encode(
      'GET /profile/octocat HTTP/1.1\r\nHost: github.com\r\n\r\n',
    )
    const received = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<span data-user="octocat"></span>',
    )
    const config = revealConfig(message, sent, received)
    expect(config.sent).toMatchObject([
      { start: 0, end: 'GET /profile/octocat HTTP/1.1\r\n'.length },
    ])
    expect(config.recv[0]).toMatchObject({
      start: 0,
      end: 'HTTP/1.1 200 OK\r\n'.length,
    })
    expect(config.recv).toHaveLength(4)
    expect(() =>
      revealConfig({ ...message, config: connector }, sent, received),
    ).toThrow('JSON connectors are unsupported')
  })
})
