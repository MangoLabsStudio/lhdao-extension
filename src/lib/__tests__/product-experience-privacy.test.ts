import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProductExperienceRule,
  ProductRuleMatch,
} from '@/types/product-experience'
import {
  createProductExperienceEvidenceMessage,
  startProductExperienceWatcher,
} from '../product-experience-watcher'

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
    ]) {
      expect(durableShape).not.toContain(forbiddenField)
    }
  })
})
