import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProductExperienceRule,
  ProductRuleMatch,
} from '@/types/product-experience'
import {
  createProductExperienceEvidenceMessage,
  startProductExperienceWatcher,
} from '../product-experience-watcher'
import {
  appendProductZkTlsDiagnostic,
  createProductZkTlsDiagnostic,
} from '../zktls/debug'

const CLIENT_ORIGIN = 'https://client.example'

function setUrl(url: string): void {
  ;(
    window as typeof window & {
      happyDOM: { setURL(nextUrl: string): void }
    }
  ).happyDOM.setURL(url)
}

function rule(
  id: string,
  selector: string,
  condition: ProductExperienceRule['condition'],
): ProductExperienceRule {
  return {
    id,
    title: id,
    urlPattern: `${CLIENT_ORIGIN}/app/*`,
    selector,
    condition,
  }
}

describe('product experience evaluator privacy', () => {
  beforeEach(() => {
    setUrl(`${CLIENT_ORIGIN}/app/start?private=query#private-fragment`)
    document.body.innerHTML = [
      '<input id="account" value="do-not-read" style="opacity: 1" />',
      '<iframe id="frame" style="opacity: 1"></iframe>',
      '<div id="copy" style="opacity: 1">safe marker: completed</div>',
      '<div id="state" data-state="done" style="opacity: 1"></div>',
    ].join('')
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
      {
        width: 10,
        height: 10,
      } as DOMRect,
    ] as unknown as DOMRectList)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('does not touch page credentials, storage, network APIs, or iframe documents', async () => {
    const cookie = vi.spyOn(Document.prototype, 'cookie', 'get')
    const outerHtml = vi.spyOn(Element.prototype, 'outerHTML', 'get')
    const inputValue = vi.spyOn(HTMLInputElement.prototype, 'value', 'get')
    const iframeDocument = vi.spyOn(
      HTMLIFrameElement.prototype,
      'contentDocument',
      'get',
    )
    const formData = vi.spyOn(window, 'FormData')
    const localStorage = vi.spyOn(window, 'localStorage', 'get')
    const sessionStorage = vi.spyOn(window, 'sessionStorage', 'get')
    const fetch = vi.spyOn(window, 'fetch')
    const xmlHttpRequest = vi.spyOn(window, 'XMLHttpRequest')
    const webSocket = vi.spyOn(window, 'WebSocket')
    const storageGetItem = vi.spyOn(Storage.prototype, 'getItem')
    const storageSetItem = vi.spyOn(Storage.prototype, 'setItem')
    const storageRemoveItem = vi.spyOn(Storage.prototype, 'removeItem')
    const storageClear = vi.spyOn(Storage.prototype, 'clear')
    const onEvidence = vi.fn()

    const watcher = startProductExperienceWatcher({
      rules: [
        rule('input-present', '#account', { type: 'ELEMENT_EXISTS' }),
        rule('frame-present', '#frame', { type: 'ELEMENT_EXISTS' }),
        rule('copy-ready', '#copy', {
          type: 'TEXT_CONTAINS',
          expected: 'completed',
        }),
        rule('state-ready', '#state', {
          type: 'ATTRIBUTE_EQUALS',
          attributeName: 'data-state',
          expected: 'done',
        }),
      ],
      allowedOrigins: [CLIENT_ORIGIN],
      completionMode: 'ALL',
      onEvidence,
    })

    await vi.waitFor(() => expect(onEvidence).toHaveBeenCalledTimes(1))
    watcher.stop()

    for (const forbiddenAccess of [
      cookie,
      outerHtml,
      inputValue,
      iframeDocument,
      formData,
      localStorage,
      sessionStorage,
      fetch,
      xmlHttpRequest,
      webSocket,
      storageGetItem,
      storageSetItem,
      storageRemoveItem,
      storageClear,
    ]) {
      expect(forbiddenAccess).not.toHaveBeenCalled()
    }
  })

  it('emits only the session ID and sanitized rule-match metadata', () => {
    const taintedMatch = {
      ruleId: 'onboarding-done',
      matchedAt: '2026-07-14T00:00:00.000Z',
      origin: CLIENT_ORIGIN,
      urlPathHash: 'a'.repeat(64),
      selector: '#private-selector',
      expected: 'private text',
      text: 'page body',
      dom: '<main>private</main>',
      url: `${CLIENT_ORIGIN}/app?secret=query#fragment`,
      ticket: 'private-ticket',
      macKey: 'private-mac-key',
      exactBody: '{"account":"private-account"}',
      requestBody: 'private-request-body',
      resolvedVariables: 'private-resolved-variables',
    } as ProductRuleMatch & Record<string, string>

    const message = createProductExperienceEvidenceMessage('session-1', [
      taintedMatch,
    ])

    expect(Object.keys(message).sort()).toEqual([
      'matches',
      'sessionId',
      'type',
    ])
    expect(message.type).toBe('product-experience-evidence')
    expect(Object.keys(message.matches[0] ?? {}).sort()).toEqual([
      'matchedAt',
      'origin',
      'ruleId',
      'urlPathHash',
    ])
    expect(message).toEqual({
      type: 'product-experience-evidence',
      sessionId: 'session-1',
      matches: [
        {
          ruleId: 'onboarding-done',
          matchedAt: '2026-07-14T00:00:00.000Z',
          origin: CLIENT_ORIGIN,
          urlPathHash: 'a'.repeat(64),
        },
      ],
    })

    const serialized = JSON.stringify(message)
    for (const forbiddenValue of [
      '#private-selector',
      'private text',
      'page body',
      '<main>private</main>',
      'secret=query',
      'fragment',
      'private-ticket',
      'private-mac-key',
      'private-account',
      'private-request-body',
      'private-resolved-variables',
    ]) {
      expect(serialized).not.toContain(forbiddenValue)
    }
  })

  it('defines the durable zkTLS queue as identifiers and public status only', async () => {
    const controllerSource = await import(
      '../product-experience-controller?raw'
    )
    const storageSource = await import('../storage?raw')
    const durableShape = [controllerSource.default, storageSource.default].join(
      '\n',
    )

    expect(durableShape).toContain('ProductZkTlsQueueItem')
    expect(durableShape).toContain("status: 'queued' | 'proving' | 'submitted'")
    for (const forbiddenField of [
      'connectorJson',
      'signedEnvelope',
      'requestCookie',
      'responseBody',
      'claimPayload',
      'proofPayload',
      'exactBody',
      'semanticDigest',
      'resolvedVariables',
      'resolved_variables',
      'requestBody',
      'request_body',
      'rawBody',
      'raw_body',
    ]) {
      expect(durableShape).not.toContain(forbiddenField)
    }
  })

  it('keeps captured public JSON while removing every credential from diagnostics and copied JSON', () => {
    const secrets = {
      cookie: 'cookie-private-1',
      authorization: 'Bearer private-2',
      setCookie: 'session=private-3',
      pluginToken: 'lhdao_pk_private-4',
      walletSignature: '0xprivate-signature-5',
      macKey: 'private-mac-6',
      hmac: 'private-hmac-7',
    }
    const publicResponse = {
      data: {
        account: '0x1234',
        postBalance: '301.022691071331912180',
        preBalance: '107.597080071331912181',
      },
    }
    const diagnostic = appendProductZkTlsDiagnostic(
      createProductZkTlsDiagnostic('privacy-proof', 100),
      {
        at: 101,
        stage: 'tls-transcript-received',
        status: 'failed',
        details: {
          publicResponse,
          headers: {
            Cookie: secrets.cookie,
            Authorization: secrets.authorization,
            'Set-Cookie': secrets.setCookie,
          },
          pluginToken: secrets.pluginToken,
          walletSignature: secrets.walletSignature,
          macKey: secrets.macKey,
          hmac: secrets.hmac,
        },
        error: new Error(
          `Verifier closed after ${secrets.authorization} ${secrets.walletSignature}`,
        ),
      },
      Object.values(secrets),
    )
    const copied = JSON.stringify({ zkTlsDiagnostic: diagnostic }, null, 2)

    expect(copied).toContain('301.022691071331912180')
    expect(copied).toContain('107.597080071331912181')
    expect(copied).toContain('Verifier closed after [REDACTED] [REDACTED]')
    for (const secret of Object.values(secrets)) {
      expect(copied).not.toContain(secret)
    }
  })
})
