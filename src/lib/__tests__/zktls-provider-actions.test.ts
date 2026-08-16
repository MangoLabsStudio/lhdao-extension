import { describe, expect, test, vi } from 'vitest'
import { CaptureSession, createCaptureBinding } from '@/lib/zktls/capture'
import { validateConnector } from '@/lib/zktls/interpreter'
import {
  type ProviderAction,
  runProviderActionsInPage,
} from '@/lib/zktls/provider-actions'
import { runProviderActions } from '@/lib/zktls/runtime'

const request = {
  method: 'GET',
  matcher: {
    path: { kind: 'exact', value: '/settings/profile' },
    query: { required: {}, optional: {}, capture: {} },
    resource_types: ['fetch'],
  },
  headers: { accept: 'application/json' },
  secret_headers: ['cookie'],
  max_sent_data: 8192,
  max_recv_data: 65536,
  replay_safety_evidence: 'The profile endpoint is read-only.',
} as const

const connector = {
  interpreter_version: 3,
  connector_id: 'provider-actions-test',
  revision: 1,
  disabled: false,
  expires_at: '2030-01-01T00:00:00.000Z',
  origin: 'https://github.com',
  request,
  response_format: 'json',
  response_status: 200,
  extraction: {
    kind: 'json_path',
    path: '$.login',
    value_type: 'string',
    max_bytes: 64,
  },
  verifier_profile_id: 'lighthouse-v1',
} as const

const actions: ProviderAction[] = [
  { kind: 'wait_for_selector', selector: '#profile', timeout_ms: 100 },
  { kind: 'input', selector: '#profile', text: 'octocat' },
  { kind: 'click', selector: '#load-profile' },
]

describe('zkTLS v3 provider actions', () => {
  test('accepts only bounded signed v3 actions and rejects script fields', () => {
    expect(validateConnector({ ...connector, actions })).toMatchObject({
      actions,
    })
    expect(() =>
      validateConnector({
        ...connector,
        actions: [
          { kind: 'click', selector: '#load-profile', script: 'alert(1)' },
        ],
      }),
    ).toThrow('unknown field')
    expect(() =>
      validateConnector({
        ...connector,
        interpreter_version: 2,
        request: {
          method: 'GET',
          path: '/settings/profile',
          headers: request.headers,
          secret_headers: request.secret_headers,
          max_sent_data: request.max_sent_data,
          max_recv_data: request.max_recv_data,
          replay_safety_evidence: request.replay_safety_evidence,
        },
        response_format: 'html',
        extraction: {
          kind: 'html_between',
          prefix: '<span>',
          suffix: '</span>',
          max_bytes: 64,
        },
        actions,
      }),
    ).toThrow('connector contains an unknown field')
    expect(() =>
      validateConnector({
        ...connector,
        actions: [
          { kind: 'wait_for_selector', selector: '#profile', timeout_ms: 5001 },
        ],
      }),
    ).toThrow('timeout_ms')
  })

  test('runs the fixed CSS action interpreter without executing configuration code', async () => {
    document.body.innerHTML =
      '<form id="form"><input id="profile"><button id="load-profile" type="button">Load</button></form>'
    const click = vi.fn()
    document.querySelector<HTMLButtonElement>('#load-profile')!.onclick = click
    await runProviderActionsInPage(actions)
    expect(document.querySelector<HTMLInputElement>('#profile')!.value).toBe(
      'octocat',
    )
    expect(click).toHaveBeenCalledOnce()
  })

  test('injects only the packaged interpreter into the provider tab', async () => {
    const original = chrome.scripting.executeScript
    const executeScript = vi.fn().mockResolvedValue([])
    Object.defineProperty(chrome.scripting, 'executeScript', {
      configurable: true,
      value: executeScript,
    })
    try {
      await runProviderActions(7, actions)
      expect(executeScript).toHaveBeenCalledWith({
        target: { tabId: 7, frameIds: [0] },
        func: runProviderActionsInPage,
        args: [actions],
      })
    } finally {
      Object.defineProperty(chrome.scripting, 'executeScript', {
        configurable: true,
        value: original,
      })
    }
  })

  test('retains the exact signed matcher after actions run', () => {
    const config = validateConnector({ ...connector, actions })
    if (config.interpreter_version !== 3) throw new Error('wrong connector')
    const capture = new CaptureSession(
      createCaptureBinding({
        tabId: 7,
        frameId: 0,
        sessionId: 'session1',
        providerId: config.connector_id,
        revision: config.revision,
        origin: config.origin,
        matcher: config.request.matcher,
        secretHeaders: config.request.secret_headers,
      }),
    )
    capture.observe({
      requestId: 'unrelated',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://github.com/settings/security',
      type: 'fetch',
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
    })
    expect(capture.completes('unrelated')).toBe(false)
    capture.observe({
      requestId: 'matched',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://github.com/settings/profile',
      type: 'fetch',
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
    })
    expect(capture.take()).toMatchObject({ path: '/settings/profile' })
  })
})
