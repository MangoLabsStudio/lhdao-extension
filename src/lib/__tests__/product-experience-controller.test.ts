import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProductExperienceRule,
  ProductExperienceTaskRef,
  ProductExperienceTicket,
  ProductRuleMatch,
  ProductZkTlsRuleProgress,
} from '../../types/product-experience'
import {
  controllerStateToPublicSource,
  ProductExperienceController,
  type ProductExperienceControllerDependencies,
  type ProductExperienceControllerStorage,
  type ProductExperienceRuntimeSender,
  type ProductExperienceSession,
} from '../product-experience-controller'
import { clearProductExperienceStorage } from '../storage'

const NOW = Date.parse('2026-07-13T10:00:00.000Z')
const CLIENT_ORIGIN = 'https://client.example'
const SECOND_ORIGIN = 'https://second.example'

const rules: ProductExperienceRule[] = [
  {
    id: 'rule-a',
    title: 'First step',
    urlPattern: `${CLIENT_ORIGIN}/app/*`,
    selector: '[data-step="a"]',
    condition: { type: 'ELEMENT_EXISTS' },
  },
  {
    id: 'rule-b',
    title: 'Second step',
    urlPattern: `${CLIENT_ORIGIN}/app/*`,
    selector: '[data-step="b"]',
    condition: { type: 'ELEMENT_EXISTS' },
  },
]

function task(
  ticketKind: ProductExperienceTaskRef['ticketKind'] = 'PARTICIPANT',
): ProductExperienceTaskRef {
  return {
    campaignId: 'campaign-product-001',
    ticketKind,
    configVersion: 3,
    title: 'Try the product',
    savedAt: NOW,
  }
}

function replacementTask(): ProductExperienceTaskRef {
  return {
    ...task('TEST'),
    campaignId: 'campaign-product-002',
    configVersion: 3,
    title: 'Try another product',
  }
}

function ticket(overrides: Partial<ProductExperienceTicket> = {}) {
  return {
    ticket: 'ticket-value',
    macKey: 'mac-key',
    expiresAt: '2026-07-13T10:30:00.000Z',
    ruleSetVersion: 3,
    allowedOrigins: [CLIENT_ORIGIN, SECOND_ORIGIN],
    completionMode: 'ALL' as const,
    verificationMode: 'LEGACY_DOM' as const,
    rules,
    ...overrides,
  }
}

function match(ruleId: string, origin = CLIENT_ORIGIN): ProductRuleMatch {
  return {
    ruleId,
    matchedAt: '2026-07-13T10:00:01.000Z',
    origin,
    urlPathHash: ruleId === 'rule-a' ? 'a'.repeat(64) : 'b'.repeat(64),
  }
}

function sender(
  overrides: Partial<ProductExperienceRuntimeSender> = {},
): ProductExperienceRuntimeSender {
  return {
    extensionId: 'extension-id',
    tabId: 7,
    frameId: 0,
    origin: CLIENT_ORIGIN,
    ...overrides,
  }
}

class MemoryProductStorage implements ProductExperienceControllerStorage {
  activeTask: ProductExperienceTaskRef | null = null
  session: ProductExperienceSession | null = null
  engagementState = { untouched: true }
  clearCalls = 0

  async getTask() {
    return structuredClone(this.activeTask)
  }

  async setTask(value: ProductExperienceTaskRef) {
    this.activeTask = structuredClone(value)
  }

  async getSession() {
    return structuredClone(this.session)
  }

  async setSession(value: ProductExperienceSession) {
    this.session = structuredClone(value)
  }

  async clearProduct() {
    this.activeTask = null
    this.session = null
    this.clearCalls += 1
  }
}

function acceptedResult(
  campaignId = 'campaign-product-001',
  configVersion = 3,
) {
  return {
    submitProductExperienceProof: {
      accepted: true,
      code: 'ACCEPTED',
      campaignId,
      configVersion,
      verificationKind: 'EXPERIENCE' as const,
      verifiedAt: '2026-07-13T10:00:03.000Z',
    },
  }
}

function transportError(uncertain: boolean): Error & { uncertain: boolean } {
  return Object.assign(new Error(uncertain ? 'offline' : 'forbidden'), {
    uncertain,
  })
}

function createHarness(diagnosticsEnabled = false) {
  const storage = new MemoryProductStorage()
  const activeTab: { value: { id: number; url: string } | null } = {
    value: { id: 7, url: `${CLIENT_ORIGIN}/app/start` },
  }
  const mintParticipant = vi.fn(async (_campaignId: string) => ticket())
  const mintTest = vi.fn(async (_campaignId: string) => ticket())
  const submit = vi.fn(
    async (
      _input: Parameters<ProductExperienceControllerDependencies['submit']>[0],
    ) => acceptedResult(),
  )
  const inject = vi.fn(async (_tabId: number) => undefined)
  const notifyStateChanged = vi.fn(async () => undefined)
  const randomSessionId = vi.fn(() => 'session-12345678')
  const startZkTls = vi.fn<
    ProductExperienceControllerDependencies['startZkTls']
  >(async () => ({
    sessionId: 'zktls-session-1',
    connectorId: 'trusted-connector-1',
    expiresAt: '2026-07-13T10:10:00.000Z',
  }))
  const proveZkTls = vi.fn<
    ProductExperienceControllerDependencies['proveZkTls']
  >(async (input) => ({
    type: 'zktls-prove-result',
    correlationId: input.correlationId,
    status: 'submitted',
  }))
  const readZkTlsProgress = vi.fn(
    async (): Promise<ProductZkTlsRuleProgress[]> =>
      rules.map((rule) => ({
        ruleId: rule.id,
        title: rule.title,
        status: 'PENDING',
        current: null,
        target: true,
        unit: null,
      })),
  )
  const readIntegration = vi.fn(async () => ({
    configVersion: 3,
    experiencePassed: false,
    experiencePassedAt: null as string | null,
  }))
  const sign = vi.fn(
    async (
      _macKey: string,
      _input: Parameters<ProductExperienceControllerDependencies['sign']>[1],
    ) => 'signed-proof',
  )
  const dependencies: ProductExperienceControllerDependencies = {
    diagnosticsEnabled,
    storage,
    getActiveTab: vi.fn(async () => activeTab.value),
    inject,
    mintParticipant,
    mintTest,
    submit,
    now: () => NOW,
    randomNonce: () => '00112233445566778899aabbccddeeff',
    randomSessionId,
    runtimeId: () => 'extension-id',
    sign,
    startZkTls,
    proveZkTls,
    readZkTlsProgress,
    readIntegration,
    notifyStateChanged,
  }
  return {
    activeTab,
    controller: new ProductExperienceController(dependencies),
    dependencies,
    inject,
    mintParticipant,
    mintTest,
    notifyStateChanged,
    randomSessionId,
    sign,
    startZkTls,
    proveZkTls,
    readZkTlsProgress,
    readIntegration,
    storage,
    submit,
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ProductExperienceController authorization and lifecycle', () => {
  let harness: ReturnType<typeof createHarness>

  beforeEach(async () => {
    harness = createHarness()
    await harness.controller.saveTask(task())
  })

  it('fails closed without an active tab and does not mint', async () => {
    harness.activeTab.value = null

    await expect(harness.controller.start()).resolves.toMatchObject({
      status: 'error',
      error: 'EXTENSION_ERROR',
    })
    expect(harness.mintParticipant).not.toHaveBeenCalled()
    expect(harness.inject).not.toHaveBeenCalled()
  })

  it('stores credentials before injecting the runtime evaluator', async () => {
    harness.inject.mockImplementationOnce(async (tabId) => {
      expect(tabId).toBe(7)
      expect(await harness.storage.getSession()).toMatchObject({
        ticket: 'ticket-value',
        macKey: 'mac-key',
        tabId: 7,
        status: 'observing',
      })
    })

    await expect(harness.controller.start()).resolves.toMatchObject({
      status: 'observing',
      currentOriginAllowed: true,
      authorizationRequired: false,
    })
    expect(harness.mintParticipant).toHaveBeenCalledTimes(1)
    expect(harness.inject).toHaveBeenCalledWith(7)
  })

  it('records the click and injection before waiting for page evidence', async () => {
    harness = createHarness(true)
    await harness.controller.saveTask(task())
    harness.mintParticipant.mockResolvedValueOnce(
      ticket({ verificationMode: 'ZKTLS' }),
    )

    await harness.controller.start()
    await harness.controller.bootstrap(sender())
    await harness.controller.ready(sender(), 'session-12345678')
    await harness.controller.handleDiagnostic(sender(), 'session-12345678', {
      at: NOW,
      stage: 'rule-evaluated',
      status: 'running',
      details: {
        ruleId: 'rule-a',
        selector: '[data-step="a"]',
        matchedElementCount: 0,
      },
    })
    const state = await harness.controller.handleDiagnostic(
      sender(),
      'session-12345678',
      {
        at: NOW,
        stage: 'evidence-sent',
        status: 'passed',
      },
    )

    expect(state.zkTlsDiagnostic?.events.map((event) => event.stage)).toEqual([
      'start-request-received',
      'page-watcher-injected',
      'watcher-bootstrapped',
      'watcher-ready',
      'rule-evaluated',
      'evidence-sent',
    ])
    expect(harness.storage.session?.zkTlsDiagnostic).toEqual(
      state.zkTlsDiagnostic,
    )
  })

  it('ignores page diagnostics from the wrong tab', async () => {
    harness = createHarness(true)
    await harness.controller.saveTask(task())
    harness.mintParticipant.mockResolvedValueOnce(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    await harness.controller.start()

    await harness.controller.handleDiagnostic(
      sender({ tabId: 99 }),
      'session-12345678',
      {
        at: NOW,
        stage: 'rule-evaluated',
        status: 'passed',
      },
    )

    expect(
      harness.storage.session?.zkTlsDiagnostic?.events.map(
        (event) => event.stage,
      ),
    ).not.toContain('rule-evaluated')
  })

  it.each([
    'ready',
    'authorizing',
    'observing',
    'submitting',
    'verified',
    'expired',
    'origin-mismatch',
    'reauthorize',
    'error',
  ] as const)('derives the page-safe %s projection from the same popup state', (status) => {
    const popupState = {
      campaignId: 'campaign-product-001',
      title: 'Private popup title',
      status,
      matchedRuleIds: ['rule-a'],
      totalRuleCount: 2,
      authorizationRequired: status === 'ready' || status === 'reauthorize',
      currentOriginAllowed: status === 'observing',
      error: status === 'error' ? ('EXTENSION_ERROR' as const) : null,
      zkTlsFailureCode: 'PROVER_TIMEOUT' as const,
    }

    expect(controllerStateToPublicSource(popupState)).toEqual({
      campaignId: popupState.campaignId,
      status: popupState.status,
      matchedRuleIds: popupState.matchedRuleIds,
      totalRuleCount: popupState.totalRuleCount,
      authorizationRequired: popupState.authorizationRequired,
      currentOriginAllowed: popupState.currentOriginAllowed,
      error: popupState.error,
    })
    expect(controllerStateToPublicSource(popupState)).not.toHaveProperty(
      'title',
    )
    expect(controllerStateToPublicSource(popupState)).not.toHaveProperty(
      'zkTlsFailureCode',
    )
  })

  it('rejects an active origin outside the ticket allowlist', async () => {
    harness.activeTab.value = { id: 7, url: 'https://evil.example/private' }

    await expect(harness.controller.start()).resolves.toMatchObject({
      status: 'origin-mismatch',
      currentOriginAllowed: false,
      authorizationRequired: true,
      error: 'ORIGIN_NOT_ALLOWED',
    })
    expect(harness.inject).not.toHaveBeenCalled()
    expect(harness.storage.session).toBeNull()
  })

  it('uses the Buyer test mutation for TEST tasks', async () => {
    await harness.controller.saveTask(task('TEST'))

    await harness.controller.start()

    expect(harness.mintTest).toHaveBeenCalledWith('campaign-product-001')
    expect(harness.mintParticipant).not.toHaveBeenCalled()
  })

  it('fails closed on ticket version drift or an already expired ticket', async () => {
    harness.mintParticipant.mockResolvedValueOnce(ticket({ ruleSetVersion: 4 }))
    await expect(harness.controller.start()).resolves.toMatchObject({
      status: 'error',
      error: 'VERSION_MISMATCH',
    })
    expect(harness.inject).not.toHaveBeenCalled()

    await harness.controller.saveTask(task())
    harness.mintParticipant.mockResolvedValueOnce(
      ticket({ expiresAt: '2026-07-13T09:59:59.000Z' }),
    )
    await expect(harness.controller.start()).resolves.toMatchObject({
      status: 'expired',
      error: 'SESSION_EXPIRED',
    })
  })

  it('reinjects on same-origin document loads without minting again', async () => {
    await harness.controller.start()
    expect(harness.inject).toHaveBeenCalledTimes(1)

    await harness.controller.handleTabUpdated(7, {
      status: 'complete',
      url: `${CLIENT_ORIGIN}/app/second-page`,
    })

    expect(harness.inject).toHaveBeenCalledTimes(2)
    expect(harness.mintParticipant).toHaveBeenCalledTimes(1)
  })

  it('does not retry a pending proof because an unrelated tab updated', async () => {
    await harness.controller.start()
    harness.submit.mockRejectedValueOnce(transportError(true))
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])
    expect(harness.submit).toHaveBeenCalledTimes(1)
    expect(harness.storage.session?.pendingSubmit).not.toBeNull()

    harness.submit.mockResolvedValueOnce(acceptedResult())
    await expect(
      harness.controller.handleTabUpdated(99, {
        status: 'complete',
        url: 'https://unrelated.example/page',
      }),
    ).resolves.toMatchObject({ status: 'submitting' })

    expect(harness.submit).toHaveBeenCalledTimes(1)
    expect(harness.storage.session?.pendingSubmit).not.toBeNull()
  })

  it('requires reauthorization when a completed navigation URL is hidden', async () => {
    await harness.controller.start()

    await expect(
      harness.controller.handleTabUpdated(7, { status: 'complete' }),
    ).resolves.toMatchObject({
      status: 'reauthorize',
      authorizationRequired: true,
      currentOriginAllowed: false,
      error: 'AUTHORIZATION_REQUIRED',
    })

    expect(harness.inject).toHaveBeenCalledTimes(1)
    expect(harness.storage.session).not.toBeNull()
  })

  it('preserves the session when automatic same-origin reinjection loses permission', async () => {
    await harness.controller.start()
    harness.inject.mockRejectedValueOnce(new Error('activeTab grant revoked'))

    await expect(
      harness.controller.handleTabUpdated(7, {
        status: 'complete',
        url: `${CLIENT_ORIGIN}/app/reloaded`,
      }),
    ).resolves.toMatchObject({
      status: 'reauthorize',
      authorizationRequired: true,
      currentOriginAllowed: true,
      error: 'AUTHORIZATION_REQUIRED',
    })

    expect(harness.storage.activeTask?.campaignId).toBe('campaign-product-001')
    expect(harness.storage.session?.sessionId).toBe('session-12345678')
  })

  it('requires another user gesture after crossing origins and reuses a valid ticket', async () => {
    await harness.controller.start()

    await expect(
      harness.controller.handleTabUpdated(7, {
        status: 'complete',
        url: `${SECOND_ORIGIN}/next`,
      }),
    ).resolves.toMatchObject({
      status: 'reauthorize',
      authorizationRequired: true,
      currentOriginAllowed: true,
    })
    expect(harness.inject).toHaveBeenCalledTimes(1)
    expect(harness.mintParticipant).toHaveBeenCalledTimes(1)

    harness.activeTab.value = { id: 7, url: `${SECOND_ORIGIN}/next` }
    await harness.controller.start()

    expect(harness.inject).toHaveBeenCalledTimes(2)
    expect(harness.mintParticipant).toHaveBeenCalledTimes(1)
  })

  it('keeps reauthorization sticky after returning to the original origin', async () => {
    await harness.controller.start()

    await harness.controller.handleTabUpdated(7, {
      status: 'complete',
      url: `${SECOND_ORIGIN}/next`,
    })
    await expect(
      harness.controller.handleTabUpdated(7, {
        status: 'complete',
        url: `${CLIENT_ORIGIN}/app/return`,
      }),
    ).resolves.toMatchObject({
      status: 'reauthorize',
      authorizationRequired: true,
      currentOriginAllowed: true,
      error: 'AUTHORIZATION_REQUIRED',
    })

    expect(harness.inject).toHaveBeenCalledTimes(1)
    expect(harness.mintParticipant).toHaveBeenCalledTimes(1)
  })

  it('clears only product state when the bound tab closes', async () => {
    await harness.controller.start()

    await harness.controller.handleTabRemoved(7)

    expect(harness.storage.activeTask).toBeNull()
    expect(harness.storage.session).toBeNull()
    expect(harness.storage.engagementState).toEqual({ untouched: true })
  })

  it('discards a late mint after the page saves a different task', async () => {
    let resolveMint: ((value: ProductExperienceTicket) => void) | undefined
    harness.mintParticipant.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMint = resolve
        }),
    )
    const authorization = harness.controller.start()
    await vi.waitFor(() =>
      expect(harness.mintParticipant).toHaveBeenCalledTimes(1),
    )

    await expect(
      harness.controller.saveTask(replacementTask()),
    ).resolves.toMatchObject({ saved: true })
    resolveMint?.(ticket())
    await authorization

    expect(harness.storage.activeTask?.campaignId).toBe('campaign-product-002')
    expect(harness.storage.session).toBeNull()
    expect(harness.inject).not.toHaveBeenCalled()
  })

  it('discards a late mint after cancel', async () => {
    let resolveMint: ((value: ProductExperienceTicket) => void) | undefined
    harness.mintParticipant.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMint = resolve
        }),
    )
    const authorization = harness.controller.start()
    await vi.waitFor(() =>
      expect(harness.mintParticipant).toHaveBeenCalledTimes(1),
    )

    await harness.controller.cancel()
    resolveMint?.(ticket())
    await authorization

    expect(harness.storage.activeTask).toBeNull()
    expect(harness.storage.session).toBeNull()
    expect(harness.inject).not.toHaveBeenCalled()
  })

  it('discards a late mint after the authorizing tab closes', async () => {
    let resolveMint: ((value: ProductExperienceTicket) => void) | undefined
    harness.mintParticipant.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMint = resolve
        }),
    )
    const authorization = harness.controller.start()
    await vi.waitFor(() =>
      expect(harness.mintParticipant).toHaveBeenCalledTimes(1),
    )

    await harness.controller.handleTabRemoved(7)
    resolveMint?.(ticket())
    await authorization

    expect(harness.storage.activeTask).toBeNull()
    expect(harness.storage.session).toBeNull()
    expect(harness.inject).not.toHaveBeenCalled()
  })

  it('does not let a stale tab-removal read clear a newer saved task', async () => {
    const staleSession = await harness.storage.getSession()
    let resolveStaleRead:
      | ((value: ProductExperienceSession | null) => void)
      | undefined
    vi.spyOn(harness.storage, 'getSession').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStaleRead = resolve
        }),
    )

    const removal = harness.controller.handleTabRemoved(7)
    await vi.waitFor(() => expect(resolveStaleRead).toBeTypeOf('function'))
    await expect(
      harness.controller.saveTask(replacementTask()),
    ).resolves.toMatchObject({ saved: true })
    resolveStaleRead?.(staleSession)
    await removal

    expect(harness.storage.activeTask?.campaignId).toBe('campaign-product-002')
    expect(harness.storage.session).toBeNull()
  })

  it('ignores an old authorizing tab after a replacement binds another tab', async () => {
    let resolveOldMint: ((value: ProductExperienceTicket) => void) | undefined
    harness.mintParticipant.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldMint = resolve
        }),
    )
    const oldAuthorization = harness.controller.start()
    await vi.waitFor(() =>
      expect(harness.mintParticipant).toHaveBeenCalledTimes(1),
    )

    await harness.controller.saveTask(replacementTask())
    harness.activeTab.value = { id: 8, url: `${CLIENT_ORIGIN}/app/new-task` }
    await harness.controller.start()
    await harness.controller.handleTabRemoved(7)

    expect(harness.storage.activeTask?.campaignId).toBe('campaign-product-002')
    expect(harness.storage.session).toMatchObject({
      campaignId: 'campaign-product-002',
      tabId: 8,
    })

    resolveOldMint?.(ticket())
    await oldAuthorization
    expect(harness.storage.activeTask?.campaignId).toBe('campaign-product-002')
    expect(harness.storage.session).toMatchObject({
      campaignId: 'campaign-product-002',
      tabId: 8,
    })
  })
})

describe('ProductExperienceController runtime messages and replay safety', () => {
  let harness: ReturnType<typeof createHarness>

  beforeEach(async () => {
    harness = createHarness()
    await harness.controller.saveTask(task())
    await harness.controller.start()
  })

  it('returns rules only to the bound top-frame extension sender', async () => {
    await expect(
      harness.controller.bootstrap(sender({ tabId: 99 })),
    ).resolves.toEqual({ ok: false, error: 'INVALID_SENDER' })

    const response = await harness.controller.bootstrap(sender())
    expect(response).toMatchObject({
      ok: true,
      sessionId: 'session-12345678',
      ruleSetVersion: 3,
      allowedOrigins: [CLIENT_ORIGIN, SECOND_ORIGIN],
      completionMode: 'ALL',
      evaluationMode: 'STRICT',
      rules,
    })
    expect(JSON.stringify(response)).not.toContain('ticket-value')
    expect(JSON.stringify(response)).not.toContain('mac-key')
  })

  it('uses selector-only evaluation only for a TEST ticket', async () => {
    harness = createHarness()
    await harness.controller.saveTask(task('TEST'))
    await harness.controller.start()

    await expect(harness.controller.bootstrap(sender())).resolves.toMatchObject(
      { ok: true, evaluationMode: 'SELECTOR_ONLY' },
    )
  })

  it('accumulates ALL rule metadata and submits exactly once', async () => {
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    expect(harness.submit).not.toHaveBeenCalled()

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])

    expect(harness.sign).toHaveBeenCalledTimes(1)
    expect(harness.submit).toHaveBeenCalledTimes(1)
    expect(harness.submit.mock.calls[0]?.[0]).toMatchObject({
      input: {
        version: 'product-experience-v1',
        campaignId: 'campaign-product-001',
        ticket: 'ticket-value',
        ruleSetVersion: 3,
        nonce: '00112233445566778899aabbccddeeff',
        ts: Math.floor(NOW / 1000),
        ruleMatches: [match('rule-a'), match('rule-b')],
        sig: 'signed-proof',
      },
    })
    expect(harness.storage.engagementState).toEqual({ untouched: true })
  })

  it('persists the complete signed input before starting fetch', async () => {
    let resolveSubmit:
      | ((value: ReturnType<typeof acceptedResult>) => void)
      | undefined
    harness.submit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve
        }),
    )

    const submission = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a'), match('rule-b')],
    )

    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1))
    const persisted = await harness.storage.getSession()
    expect(persisted?.pendingSubmit).toEqual(harness.submit.mock.calls[0]?.[0])

    resolveSubmit?.(acceptedResult())
    await submission
  })

  it('retries the exact durable input after a worker restart or popup read', async () => {
    harness.submit.mockRejectedValueOnce(transportError(true))
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])
    const pending = structuredClone(harness.storage.session?.pendingSubmit)
    expect(pending).not.toBeNull()

    harness.submit.mockResolvedValueOnce(acceptedResult())
    const restarted = new ProductExperienceController(harness.dependencies)
    await restarted.getState()

    expect(harness.submit).toHaveBeenCalledTimes(2)
    expect(harness.submit.mock.calls[1]?.[0]).toEqual(pending)
    expect(harness.storage.activeTask).toBeNull()
    expect(harness.storage.session).toBeNull()
    expect(harness.storage.engagementState).toEqual({ untouched: true })
  })

  it('retries an uncertain durable input even after the local ticket expiry', async () => {
    harness.submit.mockRejectedValueOnce(transportError(true))
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])
    const pending = structuredClone(harness.storage.session?.pendingSubmit)
    expect(pending).not.toBeNull()

    harness.dependencies.now = () => Date.parse('2026-07-13T10:31:00.000Z')
    harness.submit.mockResolvedValueOnce(acceptedResult())
    const restarted = new ProductExperienceController(harness.dependencies)

    await expect(restarted.resumePendingSubmit()).resolves.toMatchObject({
      status: 'verified',
    })
    expect(harness.submit).toHaveBeenCalledTimes(2)
    expect(harness.submit.mock.calls[1]?.[0]).toEqual(pending)
  })

  it('blocks a different task from replacing an uncertain in-flight proof', async () => {
    let rejectSubmit: ((error: unknown) => void) | undefined
    harness.submit.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSubmit = reject
        }),
    )
    const submission = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a'), match('rule-b')],
    )
    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1))

    const replacement = harness.controller.saveTask(replacementTask())
    rejectSubmit?.(transportError(true))
    await submission

    await expect(replacement).resolves.toMatchObject({
      saved: false,
      state: { campaignId: 'campaign-product-001', status: 'submitting' },
    })
    expect(harness.storage.activeTask?.campaignId).toBe('campaign-product-001')
    expect(harness.storage.session?.pendingSubmit).toEqual(
      harness.submit.mock.calls[0]?.[0],
    )
  })

  it('does not let a late submit callback revive state after the tab closes', async () => {
    let resolveSubmit:
      | ((value: ReturnType<typeof acceptedResult>) => void)
      | undefined
    harness.submit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve
        }),
    )
    const submission = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a'), match('rule-b')],
    )
    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1))

    await harness.controller.handleTabRemoved(7)
    resolveSubmit?.(acceptedResult())

    await expect(submission).resolves.toMatchObject({ status: 'idle' })
    expect(harness.storage.activeTask).toBeNull()
    expect(harness.storage.session).toBeNull()
    await expect(harness.controller.getState()).resolves.toMatchObject({
      status: 'idle',
    })
  })

  it('drains a newer pending proof after an older in-flight request resolves', async () => {
    let resolveOldSubmit:
      | ((value: ReturnType<typeof acceptedResult>) => void)
      | undefined
    harness.submit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldSubmit = resolve
        }),
    )
    const oldSubmission = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a'), match('rule-b')],
    )
    await vi.waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1))

    await harness.controller.handleTabRemoved(7)
    await harness.controller.saveTask(replacementTask())
    await harness.controller.start()
    const newSession = await harness.storage.getSession()
    if (!newSession) throw new Error('missing replacement session')
    if (!newSession.ticket) throw new Error('missing legacy ticket')
    newSession.matches = [match('rule-a'), match('rule-b')]
    newSession.pendingSubmit = {
      input: {
        version: 'product-experience-v1',
        campaignId: 'campaign-product-002',
        ticket: newSession.ticket,
        ruleSetVersion: 3,
        nonce: 'ffeeddccbbaa99887766554433221100',
        ts: Math.floor(NOW / 1000),
        ruleMatches: [match('rule-a'), match('rule-b')],
        sig: 'new-signed-proof',
      },
    }
    newSession.status = 'submitting'
    await harness.storage.setSession(newSession)
    harness.submit.mockResolvedValueOnce(acceptedResult('campaign-product-002'))
    const newSubmission = harness.controller.resumePendingSubmit()
    expect(harness.submit).toHaveBeenCalledTimes(1)

    resolveOldSubmit?.(acceptedResult())
    await Promise.all([oldSubmission, newSubmission])

    expect(harness.submit).toHaveBeenCalledTimes(2)
    expect(harness.submit.mock.calls[1]?.[0].input.campaignId).toBe(
      'campaign-product-002',
    )
    expect(harness.storage.activeTask).toBeNull()
    expect(harness.storage.session).toBeNull()
  })

  it('discards a late signature after a different task is saved', async () => {
    let resolveSignature: ((value: string) => void) | undefined
    harness.sign.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSignature = resolve
        }),
    )
    const submission = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a'), match('rule-b')],
    )
    await vi.waitFor(() => expect(harness.sign).toHaveBeenCalledTimes(1))

    await expect(
      harness.controller.saveTask(replacementTask()),
    ).resolves.toMatchObject({ saved: true })
    resolveSignature?.('late-signature')
    await submission

    expect(harness.submit).not.toHaveBeenCalled()
    expect(harness.storage.activeTask?.campaignId).toBe('campaign-product-002')
    expect(harness.storage.session).toBeNull()
  })

  it('does not let a late signature revive credentials after tab close', async () => {
    let resolveSignature: ((value: string) => void) | undefined
    harness.sign.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSignature = resolve
        }),
    )
    const submission = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a'), match('rule-b')],
    )
    await vi.waitFor(() => expect(harness.sign).toHaveBeenCalledTimes(1))

    await harness.controller.handleTabRemoved(7)
    resolveSignature?.('late-signature')
    await submission

    expect(harness.submit).not.toHaveBeenCalled()
    expect(harness.storage.activeTask).toBeNull()
    expect(harness.storage.session).toBeNull()
  })

  it('rejects unknown rules, sender origins, and session IDs without submitting', async () => {
    await harness.controller.handleEvidence(sender(), 'wrong-session', [
      match('rule-a'),
    ])
    await harness.controller.handleEvidence(
      sender({ origin: 'https://evil.example' }),
      'session-12345678',
      [match('rule-a')],
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('unknown-rule'),
    ])

    expect(harness.submit).not.toHaveBeenCalled()
    expect(harness.storage.session?.matches).toEqual([])
    expect(harness.storage.session).toMatchObject({
      status: 'reauthorize',
      currentOriginAllowed: false,
      error: 'ORIGIN_NOT_ALLOWED',
    })
  })

  it('expires before accepting late evidence and clears only product keys', async () => {
    harness.dependencies.now = () => Date.parse('2026-07-13T10:31:00.000Z')

    await expect(
      harness.controller.handleEvidence(sender(), 'session-12345678', [
        match('rule-a'),
        match('rule-b'),
      ]),
    ).resolves.toMatchObject({
      status: 'expired',
      error: 'SESSION_EXPIRED',
    })
    expect(harness.storage.session).toBeNull()
    expect(harness.storage.engagementState).toEqual({ untouched: true })
  })

  it('clears product credentials on a terminal submit error', async () => {
    harness.submit.mockRejectedValueOnce(transportError(false))

    await expect(
      harness.controller.handleEvidence(sender(), 'session-12345678', [
        match('rule-a'),
        match('rule-b'),
      ]),
    ).resolves.toMatchObject({
      status: 'error',
      error: 'VERIFICATION_FAILED',
    })
    expect(harness.storage.activeTask).toBeNull()
    expect(harness.storage.session).toBeNull()
    expect(harness.storage.engagementState).toEqual({ untouched: true })
  })
})

describe('ProductExperienceController zkTLS authority queue', () => {
  let harness: ReturnType<typeof createHarness>

  beforeEach(async () => {
    vi.useFakeTimers()
    harness = createHarness()
    harness.mintParticipant.mockResolvedValue(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    harness.mintTest.mockResolvedValue(ticket({ verificationMode: 'ZKTLS' }))
    await harness.controller.saveTask(task())
    await harness.controller.start()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('proves a shared connector once and closes terminal yes/no without claiming all rules passed', async () => {
    harness.startZkTls.mockResolvedValue({
      sessionId: 'proof-shared',
      connectorId: 'shared',
      expiresAt: '2026-07-13T10:10:00.000Z',
      executionPlan: {
        version: 1,
        steps: [
          {
            connectorId: 'shared',
            triggerPaths: ['/app'],
            dependentFactIds: ['shared:a', 'shared:b'],
            dependentRuleIds: ['rule-a', 'rule-b'],
          },
        ],
      },
    })
    harness.readZkTlsProgress.mockResolvedValue([
      {
        ruleId: 'rule-a',
        title: 'A',
        status: 'VERIFIED',
        current: 1,
        target: 1,
        unit: null,
      },
      {
        ruleId: 'rule-b',
        title: 'B',
        status: 'VERIFIED_NO',
        current: 2,
        target: 3,
        actual: 2,
        required: 3,
        comparator: 'GTE',
        unit: null,
      },
    ])
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    const state = await harness.controller.getState()
    expect(state).toMatchObject({
      status: 'observing',
      matchedRuleIds: ['rule-a'],
      error: null,
      zkTlsFinished: true,
    })
    await harness.controller.start()
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
  })

  it('starts a backend execution plan from Lighthouse without a target tab or DOM evidence', async () => {
    const fresh = createHarness()
    fresh.activeTab.value = {
      id: 99,
      url: 'https://lighthouse.example/campaign',
    }
    fresh.mintParticipant.mockResolvedValue(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    fresh.startZkTls.mockResolvedValue({
      sessionId: 'proof-plan',
      connectorId: 'metric',
      expiresAt: '2026-07-13T10:10:00.000Z',
      executionPlan: {
        version: 1,
        steps: [
          {
            connectorId: 'metric',
            triggerPaths: ['/app'],
            dependentFactIds: ['metric:a'],
            dependentRuleIds: ['rule-a'],
          },
        ],
      },
    })
    await fresh.controller.saveTask(task())
    await fresh.controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fresh.proveZkTls).toHaveBeenCalledTimes(1)
    expect(fresh.proveZkTls.mock.calls[0][0]).toMatchObject({
      sessionId: 'proof-plan',
      connectorId: 'metric',
    })
    expect(fresh.proveZkTls.mock.calls[0][0]).not.toHaveProperty('triggerPaths')
    expect(fresh.inject).not.toHaveBeenCalled()
  })

  it('finishes TEST only on the current backend integration check without business verification', async () => {
    await harness.controller.saveTask(task('TEST'))
    await harness.controller.start()
    harness.readIntegration.mockResolvedValue({
      configVersion: 3,
      experiencePassed: true,
      experiencePassedAt: '2026-07-13T10:00:01.000Z',
    })
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(await harness.controller.getState()).toMatchObject({
      zkTlsFinished: true,
      zkTlsTestPassed: true,
      matchedRuleIds: [],
      error: null,
    })
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
  })

  it.each([
    'empty',
    'submitted',
  ] as const)('does not finish a TEST %s plan from business VERIFIED progress', async (kind) => {
    const fresh = createHarness()
    fresh.mintTest.mockResolvedValue(ticket({ verificationMode: 'ZKTLS' }))
    fresh.startZkTls.mockResolvedValue({
      sessionId: 'test-proof',
      connectorId: 'metric',
      expiresAt: '2026-07-13T10:10:00.000Z',
      executionPlan: {
        version: 1,
        steps:
          kind === 'empty'
            ? []
            : [
                {
                  connectorId: 'metric',
                  triggerPaths: ['/app'],
                  dependentFactIds: ['metric:a', 'metric:b'],
                  dependentRuleIds: ['rule-a', 'rule-b'],
                },
              ],
      },
    })
    fresh.readZkTlsProgress.mockResolvedValue(
      rules.map((rule) => ({
        ruleId: rule.id,
        title: rule.title,
        status: 'VERIFIED',
        current: 1,
        target: 1,
        unit: null,
      })),
    )
    await fresh.controller.saveTask(task('TEST'))
    await fresh.controller.start({ executePlan: true })
    await vi.advanceTimersByTimeAsync(1100)
    const state = await fresh.controller.getState()
    expect(state.status).not.toBe('verified')
    expect(state.zkTlsFinished).toBe(false)
    expect(state.zkTlsTestPassed).not.toBe(true)
    expect(state.matchedRuleIds).toEqual([])
  })

  it('keeps an earlier terminal NO out of verified IDs while polling its sibling', async () => {
    const steps = rules.map((rule) => ({
      connectorId: rule.id,
      triggerPaths: ['/app'],
      dependentFactIds: [`${rule.id}:value`],
      dependentRuleIds: [rule.id],
    }))
    harness.startZkTls.mockImplementation(async ({ ruleId }) => ({
      sessionId: `${ruleId}-proof`,
      connectorId: ruleId,
      expiresAt: '2026-07-13T10:10:00.000Z',
      executionPlan: { version: 1, steps },
    }))
    harness.readZkTlsProgress
      .mockResolvedValueOnce(
        rules.map((rule) => ({
          ruleId: rule.id,
          title: rule.title,
          status: rule.id === 'rule-a' ? 'VERIFIED_NO' : 'PENDING',
          current: 0,
          target: 1,
          unit: null,
        })),
      )
      .mockResolvedValue(
        rules.map((rule) => ({
          ruleId: rule.id,
          title: rule.title,
          status: 'VERIFIED',
          current: 1,
          target: 1,
          unit: null,
        })),
      )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(
      (await harness.controller.getState()).zkTlsConditions?.[0].status,
    ).toBe('verified_no')
    await vi.advanceTimersByTimeAsync(3100)
    const state = await harness.controller.getState()
    expect(state).toMatchObject({
      status: 'observing',
      zkTlsFinished: true,
      matchedRuleIds: ['rule-b'],
    })
    expect(state.zkTlsConditions?.[0].status).toBe('verified_no')
    expect(harness.storage.session?.verifiedRuleIds).toEqual(['rule-b'])
  })

  it('reuses a legacy null-plan preflight session when DOM evidence arrives', async () => {
    const fresh = createHarness()
    fresh.mintParticipant.mockResolvedValue(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    fresh.startZkTls
      .mockResolvedValueOnce({
        sessionId: 'live-first-proof',
        connectorId: 'legacy',
        expiresAt: '2026-07-13T10:10:00.000Z',
        executionPlan: null,
      })
      .mockRejectedValue(new Error('PRODUCT_ZKTLS_PROOF_PENDING'))
    await fresh.controller.saveTask(task())
    await fresh.controller.start({ executePlan: true })
    await fresh.controller.resumePendingSubmit()
    expect(fresh.proveZkTls).not.toHaveBeenCalled()
    await fresh.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(fresh.startZkTls).toHaveBeenCalledTimes(1)
    expect(fresh.proveZkTls).toHaveBeenCalledTimes(1)
    expect(fresh.proveZkTls.mock.calls[0][0]).toMatchObject({
      sessionId: 'live-first-proof',
      connectorId: 'legacy',
    })
  })

  it('closes an empty authoritative plan from progress instead of waiting for DOM', async () => {
    const fresh = createHarness()
    fresh.mintParticipant.mockResolvedValue(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    fresh.startZkTls.mockResolvedValue({
      sessionId: 'proof-empty',
      connectorId: 'metric',
      expiresAt: '2026-07-13T10:10:00.000Z',
      executionPlan: { version: 1, steps: [] },
    })
    fresh.readZkTlsProgress.mockResolvedValue(
      rules.map((rule) => ({
        ruleId: rule.id,
        title: rule.title,
        status: 'VERIFIED_NO',
        current: 0,
        target: 1,
        unit: null,
      })),
    )
    await fresh.controller.saveTask(task())
    await fresh.controller.start({ executePlan: true })
    expect(await fresh.controller.getState()).toMatchObject({
      zkTlsFinished: true,
      matchedRuleIds: [],
      error: null,
    })
    expect(fresh.proveZkTls).not.toHaveBeenCalled()
    expect(fresh.inject).not.toHaveBeenCalled()
  })

  it('continues a completed binding prerequisite into the metric without making it a business condition', async () => {
    const metric = {
      connectorId: 'metric',
      triggerPaths: ['/app'],
      dependentFactIds: ['metric:a'],
      dependentRuleIds: ['rule-a'],
    }
    const binding = {
      connectorId: 'binding',
      triggerPaths: ['/account'],
      dependentFactIds: [],
      dependentRuleIds: ['rule-a'],
    }
    harness.startZkTls
      .mockResolvedValueOnce({
        sessionId: 'proof-binding',
        connectorId: 'binding',
        expiresAt: '2026-07-13T10:10:00.000Z',
        executionPlan: { version: 1, steps: [binding, metric] },
      })
      .mockResolvedValueOnce({
        sessionId: 'proof-metric',
        connectorId: 'metric',
        expiresAt: '2026-07-13T10:10:00.000Z',
        executionPlan: { version: 1, steps: [metric] },
      })
    harness.readZkTlsProgress.mockResolvedValueOnce([
      {
        ruleId: 'rule-a',
        title: 'A',
        status: 'PARTIAL',
        current: null,
        target: 1,
        unit: null,
      },
    ])
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(
      harness.proveZkTls.mock.calls.map(([input]) => input.connectorId),
    ).toEqual(['binding', 'metric'])
    expect(harness.storage.session?.verifiedRuleIds).toEqual([])
  })

  it('retains both metric connectors after their shared binding completes', async () => {
    const a = {
      connectorId: 'metric-a',
      triggerPaths: ['/a'],
      dependentFactIds: ['metric-a:value'],
      dependentRuleIds: ['rule-a'],
    }
    const b = {
      connectorId: 'metric-b',
      triggerPaths: ['/b'],
      dependentFactIds: ['metric-b:value'],
      dependentRuleIds: ['rule-b'],
    }
    const binding = {
      connectorId: 'binding',
      triggerPaths: ['/account'],
      dependentFactIds: [],
      dependentRuleIds: ['rule-a', 'rule-b'],
    }
    harness.startZkTls
      .mockResolvedValueOnce({
        sessionId: 'binding-session',
        connectorId: 'binding',
        expiresAt: '2026-07-13T10:10:00.000Z',
        executionPlan: { version: 1, steps: [binding, a, b] },
      })
      .mockResolvedValueOnce({
        sessionId: 'a-session',
        connectorId: 'metric-a',
        expiresAt: '2026-07-13T10:10:00.000Z',
        executionPlan: { version: 1, steps: [a, b] },
      })
      .mockResolvedValueOnce({
        sessionId: 'b-session',
        connectorId: 'metric-b',
        expiresAt: '2026-07-13T10:10:00.000Z',
        executionPlan: { version: 1, steps: [a, b] },
      })
    harness.readZkTlsProgress.mockResolvedValueOnce(
      rules.map((rule) => ({
        ruleId: rule.id,
        title: rule.title,
        status: 'PARTIAL',
        current: null,
        target: 1,
        unit: null,
      })),
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(
      harness.proveZkTls.mock.calls.map(([input]) => input.connectorId),
    ).toEqual(['binding', 'metric-a', 'metric-b'])
  })

  it('submits each TEST metric once before waiting for the whole-plan current-version check', async () => {
    await harness.controller.saveTask(task('TEST'))
    await harness.controller.start()
    const a = {
      connectorId: 'metric-a',
      triggerPaths: ['/a'],
      dependentFactIds: ['metric-a:value'],
      dependentRuleIds: ['rule-a'],
    }
    const b = {
      connectorId: 'metric-b',
      triggerPaths: ['/b'],
      dependentFactIds: ['metric-b:value'],
      dependentRuleIds: ['rule-b'],
    }
    harness.startZkTls
      .mockResolvedValueOnce({
        sessionId: 'a-session',
        connectorId: 'metric-a',
        expiresAt: '2026-07-13T10:10:00.000Z',
        executionPlan: { version: 1, steps: [a, b] },
      })
      .mockResolvedValueOnce({
        sessionId: 'b-session',
        connectorId: 'metric-b',
        expiresAt: '2026-07-13T10:10:00.000Z',
        executionPlan: { version: 1, steps: [a, b] },
      })
    harness.readIntegration
      .mockResolvedValueOnce({
        configVersion: 4,
        experiencePassed: true,
        experiencePassedAt: '2026-07-13T10:00:01.000Z',
      })
      .mockResolvedValueOnce({
        configVersion: 3,
        experiencePassed: false,
        experiencePassedAt: null,
      })
      .mockResolvedValue({
        configVersion: 3,
        experiencePassed: true,
        experiencePassedAt: '2026-07-13T10:00:01.000Z',
      })
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(
      harness.proveZkTls.mock.calls.map(([input]) => input.connectorId),
    ).toEqual(['metric-a', 'metric-b'])
    expect((await harness.controller.getState()).zkTlsFinished).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect((await harness.controller.getState()).zkTlsFinished).toBe(false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(await harness.controller.getState()).toMatchObject({
      zkTlsFinished: true,
      zkTlsTestPassed: true,
      matchedRuleIds: [],
    })
    expect(harness.proveZkTls).toHaveBeenCalledTimes(2)
  })

  it('projects safe condition diagnostics without enabling detailed debug storage', async () => {
    harness.proveZkTls.mockImplementation(async (input) => {
      await input.onDiagnostic?.({
        at: NOW,
        stage: 'capture-failed',
        status: 'failed',
        error: {
          code: 'REQUEST_TEMPLATE_MISMATCH',
          differences: [
            {
              category: 'EXTRA_FIELD',
              pointer: '/body/*',
              value: 'private-value',
            },
          ],
          raw: 'private-value',
        },
      })
      return {
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'action_required',
        code: 'REQUEST_TEMPLATE_MISMATCH',
      }
    })
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(0)
    const state = await harness.controller.getState()
    expect(state.zkTlsConditions?.[0]).toMatchObject({
      stage: 'capture-failed',
      code: 'REQUEST_TEMPLATE_MISMATCH',
      details: [{ category: 'EXTRA_FIELD', pointer: '/body/*' }],
    })
    expect(state.zkTlsDiagnostic).toBeUndefined()
    expect(JSON.stringify(state)).not.toContain('private-value')
  })

  it('pauses incomplete planned metric data for explicit retry without losing the condition', async () => {
    harness.startZkTls.mockResolvedValue({
      sessionId: 'metric-session',
      connectorId: 'metric',
      expiresAt: '2026-07-13T10:10:00.000Z',
      executionPlan: {
        version: 1,
        steps: [
          {
            connectorId: 'metric',
            triggerPaths: ['/app'],
            dependentFactIds: ['metric:a'],
            dependentRuleIds: ['rule-a'],
          },
        ],
      },
    })
    harness.readZkTlsProgress.mockResolvedValue([
      {
        ruleId: 'rule-a',
        title: 'A',
        status: 'INSUFFICIENT_DATA',
        current: null,
        target: 1,
        unit: null,
      },
    ])
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(
      (await harness.controller.getState()).zkTlsConditions?.[0],
    ).toMatchObject({ status: 'action_required', code: 'INSUFFICIENT_DATA' })
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
  })

  it('retains terminal planned conditions and their correlation across another start', async () => {
    harness.startZkTls.mockResolvedValue({
      sessionId: 'shared-session',
      connectorId: 'shared',
      expiresAt: '2026-07-13T10:10:00.000Z',
      executionPlan: {
        version: 1,
        steps: [
          {
            connectorId: 'shared',
            triggerPaths: ['/app'],
            dependentFactIds: ['shared:a', 'shared:b'],
            dependentRuleIds: ['rule-a', 'rule-b'],
          },
        ],
      },
    })
    harness.readZkTlsProgress.mockResolvedValue(
      rules.map((rule) => ({
        ruleId: rule.id,
        title: rule.title,
        status: 'VERIFIED',
        current: 1,
        target: 1,
        unit: null,
      })),
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(1100)
    expect(await harness.controller.getState()).toMatchObject({
      status: 'verified',
      zkTlsFinished: true,
      zkTlsConditions: [
        {
          ruleId: 'rule-a',
          status: 'verified',
          correlationId: 'session-12345678',
        },
        {
          ruleId: 'rule-b',
          status: 'verified',
          correlationId: 'session-12345678',
        },
      ],
    })
    await harness.controller.start()
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
  })

  it('retries only an owned paused rule and preserves completed conditions', async () => {
    harness.proveZkTls.mockResolvedValueOnce({
      type: 'zktls-prove-result',
      correlationId: 'c1',
      status: 'action_required',
      code: 'NO_REQUEST_OBSERVED',
    })
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(
      (await harness.controller.getState()).zkTlsConditions?.[0],
    ).toMatchObject({
      ruleId: 'rule-a',
      status: 'action_required',
      code: 'NO_REQUEST_OBSERVED',
    })
    await harness.controller.retryRule('wrong-campaign', 'rule-a')
    await harness.controller.retryRule(task().campaignId, 'rule-b')
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
    await harness.controller.retryRule(task().campaignId, 'rule-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(2)
  })

  it('coalesces DOM matches into one rule job without local verification or HMAC submission', async () => {
    const first = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a')],
    )
    const duplicate = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a')],
    )
    await Promise.all([first, duplicate])
    await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.startZkTls).toHaveBeenCalledWith({
      campaignId: 'campaign-product-001',
      ruleId: 'rule-a',
      ticketKind: 'PARTICIPANT',
    })
    expect(harness.submit).not.toHaveBeenCalled()
    expect(harness.sign).not.toHaveBeenCalled()
    const durable = JSON.stringify(harness.storage.session)
    expect(durable).not.toContain('ticket-value')
    expect(durable).not.toContain('mac-key')
    expect(durable).not.toContain('"ticket":')
    expect(durable).not.toContain('"macKey":')
    expect(await harness.controller.getState()).toMatchObject({
      status: 'submitting',
      matchedRuleIds: [],
    })
  })

  it('records capture diagnostics emitted by the current proof attempt', async () => {
    await harness.controller.cancel()
    harness = createHarness(true)
    harness.mintParticipant.mockResolvedValue(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    await harness.controller.saveTask(task())
    await harness.controller.start()
    harness.proveZkTls.mockImplementationOnce(async (input) => {
      await input.onDiagnostic?.({
        at: NOW,
        stage: 'request-captured',
        status: 'passed',
        details: {
          method: 'GET',
          url: 'https://archive.prod.nado.xyz/v1/history',
          responseContentEncoding: 'gzip',
        },
      })
      return {
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'submitted',
      }
    })

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(async () =>
      expect(
        (await harness.controller.getState()).zkTlsDiagnostic?.events,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 'request-captured',
            status: 'passed',
            details: expect.objectContaining({
              responseContentEncoding: 'gzip',
            }),
          }),
        ]),
      ),
    )
  })

  it('records evidence acceptance before requesting a signed proof session', async () => {
    await harness.controller.cancel()
    harness = createHarness(true)
    harness.mintParticipant.mockResolvedValue(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    await harness.controller.saveTask(task())
    await harness.controller.start()

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.startZkTls).toHaveBeenCalledTimes(1))

    const stages = harness.storage.session?.zkTlsDiagnostic?.events.map(
      (event) => event.stage,
    )
    expect(stages).toEqual(
      expect.arrayContaining(['evidence-accepted', 'proof-session-requested']),
    )
    expect(stages?.indexOf('evidence-accepted')).toBeLessThan(
      stages?.indexOf('proof-session-requested') ?? -1,
    )
  })

  it('keeps the direct signed-session error in retryable diagnostics', async () => {
    await harness.controller.cancel()
    harness = createHarness(true)
    harness.mintParticipant.mockResolvedValue(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    harness.startZkTls.mockRejectedValueOnce(
      Object.assign(new Error('session bootstrap unavailable'), {
        code: 'SESSION_START_FAILED',
        authorization: 'Bearer api-secret',
      }),
    )
    await harness.controller.saveTask(task())
    await harness.controller.start()

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(async () =>
      expect(await harness.controller.getState()).toMatchObject({
        status: 'observing',
        error: 'VERIFICATION_FAILED',
      }),
    )

    const diagnostic = harness.storage.session?.zkTlsDiagnostic
    expect(diagnostic?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'proof-session-failed',
          status: 'failed',
          error: expect.objectContaining({
            name: 'Error',
            message: 'session bootstrap unavailable',
            code: 'SESSION_START_FAILED',
            authorization: { present: true, length: 17 },
          }),
        }),
      ]),
    )
    const durable = JSON.stringify(harness.storage.session)
    expect(durable).not.toContain('api-secret')
    expect(durable).not.toContain('ticket-value')
    expect(durable).not.toContain('mac-key')
  })

  it('runs one proof at a time while preserving other matched rules in the queue', async () => {
    let finishFirst:
      | ((value: Awaited<ReturnType<typeof harness.proveZkTls>>) => void)
      | undefined
    harness.proveZkTls.mockImplementationOnce(
      (_input) =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(1))
    expect(harness.storage.session?.zkTlsQueue).toMatchObject([
      expect.objectContaining({ ruleId: 'rule-a', status: 'proving' }),
      {
        ruleId: 'rule-b',
        status: 'queued',
        sessionId: null,
        connectorId: null,
        expiresAt: null,
      },
    ])

    finishFirst?.({
      type: 'zktls-prove-result',
      correlationId: harness.proveZkTls.mock.calls[0]?.[0].correlationId ?? '',
      status: 'submitted',
    })
    await flushAsync()
    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
  })

  it.each([
    'PARTICIPANT',
    'TEST',
  ] as const)('passes %s ticket kind to the matching zkTLS start dependency', async (ticketKind) => {
    if (ticketKind === 'TEST') {
      await harness.controller.cancel()
      await harness.controller.saveTask(task('TEST'))
      await harness.controller.start()
    }

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.startZkTls).toHaveBeenCalledWith(
        expect.objectContaining({ ticketKind }),
      ),
    )
  })

  it('polls submitted work on the bounded schedule and completes only from backend VERIFIED', async () => {
    harness.readZkTlsProgress
      .mockResolvedValueOnce([
        {
          ruleId: 'rule-a',
          title: 'First step',
          status: 'SUBMITTED',
          current: null,
          target: true,
          unit: null,
        },
        {
          ruleId: 'rule-b',
          title: 'Second step',
          status: 'PENDING',
          current: null,
          target: true,
          unit: null,
        },
      ])
      .mockResolvedValueOnce(
        rules.map((rule) => ({
          ruleId: rule.id,
          title: rule.title,
          status: 'VERIFIED' as const,
          current: true,
          target: true,
          unit: null,
        })),
      )

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])
    await flushAsync()
    expect(await harness.controller.getState()).not.toMatchObject({
      status: 'verified',
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(1)
    expect(await harness.controller.getState()).not.toMatchObject({
      status: 'verified',
    })

    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsync()
    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(2)
    expect(await harness.controller.getState()).toMatchObject({
      status: 'verified',
      matchedRuleIds: ['rule-a', 'rule-b'],
    })
    expect(harness.storage.session).toBeNull()
  })

  it.each([
    'PARTIAL',
    'INSUFFICIENT_DATA',
  ] as const)('ends a %s attempt and allows later DOM evidence to start a new session', async (backendStatus) => {
    harness.startZkTls
      .mockResolvedValueOnce({
        sessionId: 'aggregate-day-1',
        connectorId: 'trusted-connector-1',
        expiresAt: '2026-07-13T10:10:00.000Z',
      })
      .mockResolvedValueOnce({
        sessionId: 'aggregate-day-2',
        connectorId: 'trusted-connector-1',
        expiresAt: '2026-07-13T10:10:00.000Z',
      })
    harness.readZkTlsProgress.mockResolvedValueOnce([
      {
        ruleId: 'rule-a',
        title: 'Three trading days',
        status: backendStatus,
        current: 1,
        target: 3,
        unit: 'days',
      },
      {
        ruleId: 'rule-b',
        title: 'Second step',
        status: 'PENDING',
        current: null,
        target: true,
        unit: null,
      },
    ])

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsync()

    expect(harness.storage.session?.zkTlsQueue).toEqual([])
    const partialState = await harness.controller.getState()
    expect(partialState).toMatchObject({
      status: 'observing',
      matchedRuleIds: [],
    })
    expect(partialState.zkTlsProgress).toContainEqual(
      expect.objectContaining({
        ruleId: 'rule-a',
        status: backendStatus,
        current: 1,
        target: 3,
      }),
    )
    expect(harness.startZkTls).toHaveBeenCalledTimes(1)

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))
    expect(harness.startZkTls).toHaveBeenLastCalledWith(
      expect.objectContaining({ ruleId: 'rule-a' }),
    )
    expect(harness.proveZkTls).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'aggregate-day-2' }),
    )
  })

  it('keeps verifier-pending work submitted after the 1,2,4,8,15 second poll budget', async () => {
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await flushAsync()

    await vi.advanceTimersByTimeAsync(30_000)
    await flushAsync()

    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(5)
    expect(harness.storage.session?.zkTlsQueue).toMatchObject([
      expect.objectContaining({ ruleId: 'rule-a', status: 'submitted' }),
    ])
    expect(await harness.controller.getState()).toMatchObject({
      status: 'submitting',
      matchedRuleIds: [],
    })
  })

  it('uses a later trigger to ask the backend for the next connector', async () => {
    harness.startZkTls
      .mockResolvedValueOnce({
        sessionId: 'binding-session',
        connectorId: 'account-binding',
        expiresAt: '2026-07-13T10:10:00.000Z',
      })
      .mockResolvedValueOnce({
        sessionId: 'metric-session',
        connectorId: 'daily-volume-metric',
        expiresAt: '2026-07-13T10:10:00.000Z',
      })

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(30_000)
    await flushAsync()

    expect(harness.startZkTls).toHaveBeenNthCalledWith(1, {
      campaignId: 'campaign-product-001',
      ruleId: 'rule-a',
      ticketKind: 'PARTICIPANT',
    })
    expect(harness.proveZkTls).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'binding-session',
        connectorId: 'account-binding',
      }),
    )
    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(5)

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    expect(harness.startZkTls).toHaveBeenNthCalledWith(2, {
      campaignId: 'campaign-product-001',
      ruleId: 'rule-a',
      ticketKind: 'PARTICIPANT',
    })
    expect(harness.proveZkTls).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'metric-session',
        connectorId: 'daily-volume-metric',
      }),
    )
    expect(harness.storage.session?.zkTlsQueue).toMatchObject([
      expect.objectContaining({ ruleId: 'rule-a' }),
    ])
  })

  it('does not start another polling budget for duplicate DOM evidence', async () => {
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])

    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsync()

    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(5)
    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
  })

  it('does not automatically retry a failed flight because duplicate evidence arrived', async () => {
    harness.proveZkTls.mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status: 'error',
      code: 'REQUEST_NOT_CAPTURED',
    }))

    const first = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a')],
    )
    const duplicate = harness.controller.handleEvidence(
      sender(),
      'session-12345678',
      [match('rule-a')],
    )
    await Promise.all([first, duplicate])
    await vi.waitFor(() =>
      expect(harness.storage.session?.error).toBe('VERIFICATION_FAILED'),
    )
    await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['PROVER_TIMEOUT', 'PROVER_TIMEOUT'],
    ['native error: secret details', 'ZKTLS_UNKNOWN_FAILURE'],
  ] as const)('keeps only the safe zkTLS failure code for %s', async (code, expected) => {
    harness.proveZkTls.mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status: 'error',
      code,
    }))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.error).toBe('VERIFICATION_FAILED'),
    )

    expect(await harness.controller.getState()).toMatchObject({
      status: 'observing',
      error: 'VERIFICATION_FAILED',
      zkTlsFailureCode: expected,
    })
    expect(harness.storage.session?.zkTlsFailureCode).toBe(expected)
    if (expected === 'ZKTLS_UNKNOWN_FAILURE') {
      expect(JSON.stringify(harness.storage.session)).not.toContain(code)
    }
  })

  it('clears a stale zkTLS failure code when retry submits', async () => {
    harness.proveZkTls
      .mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'error',
        code: 'PROVER_FAILED',
      }))
      .mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'submitted',
      }))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.error).toBe('VERIFICATION_FAILED'),
    )
    expect(await harness.controller.getState()).toMatchObject({
      zkTlsFailureCode: 'PROVER_FAILED',
    })

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )

    expect(await harness.controller.getState()).toMatchObject({
      status: 'submitting',
      error: null,
      zkTlsFailureCode: null,
    })
  })

  it('reuses an unexpired backend session after a later proof trigger', async () => {
    harness.startZkTls.mockResolvedValueOnce({
      sessionId: 'failed-session',
      connectorId: 'failed-connector',
      expiresAt: '2026-07-13T10:10:00.000Z',
    })
    harness.proveZkTls
      .mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'error',
        code: 'REQUEST_NOT_CAPTURED',
      }))
      .mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'submitted',
      }))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]).toMatchObject({
        ruleId: 'rule-a',
        status: 'paused',
        sessionId: 'failed-session',
        connectorId: 'failed-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      }),
    )
    await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'failed-session',
        connectorId: 'failed-connector',
      }),
    )
  })

  it('reuses an unexpired backend session after a thrown prover error', async () => {
    harness.startZkTls.mockResolvedValueOnce({
      sessionId: 'failed-session',
      connectorId: 'failed-connector',
      expiresAt: '2026-07-13T10:10:00.000Z',
    })
    harness.proveZkTls
      .mockRejectedValueOnce(new Error('prover failed'))
      .mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'submitted',
      }))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.error).toBe('VERIFICATION_FAILED'),
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'failed-session',
        connectorId: 'failed-connector',
      }),
    )
  })

  it.each([
    'start',
    'prove-throw',
    'prove-result',
  ] as const)('continues queued work after failed %s without retrying the failed rule', async (failureStage) => {
    let finishFailure: (() => void) | undefined
    if (failureStage === 'start') {
      harness.startZkTls.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            finishFailure = () => reject(new Error('start failed'))
          }),
      )
    } else {
      harness.proveZkTls.mockImplementationOnce(
        (input) =>
          new Promise((resolve, reject) => {
            finishFailure =
              failureStage === 'prove-throw'
                ? () => reject(new Error('prove failed'))
                : () =>
                    resolve({
                      type: 'zktls-prove-result',
                      correlationId: input.correlationId,
                      status: 'error',
                      code: 'REQUEST_NOT_CAPTURED',
                    })
          }),
      )
    }

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => {
      if (failureStage === 'start') {
        expect(harness.startZkTls).toHaveBeenCalledTimes(1)
      } else {
        expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
      }
    })
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    finishFailure?.()
    await vi.waitFor(() =>
      expect(
        harness.storage.session?.zkTlsQueue.find(
          (item) => item.ruleId === 'rule-b',
        )?.status,
      ).toBe('submitted'),
    )
    await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledTimes(2)
    expect(harness.startZkTls).toHaveBeenNthCalledWith(2, {
      campaignId: 'campaign-product-001',
      ruleId: 'rule-b',
      ticketKind: 'PARTICIPANT',
    })
    expect(harness.proveZkTls).toHaveBeenCalledTimes(
      failureStage === 'start' ? 1 : 2,
    )
    expect(harness.storage.session?.zkTlsQueue).toMatchObject([
      {
        ruleId: 'rule-a',
        status: 'paused',
        sessionId: failureStage === 'start' ? null : 'zktls-session-1',
        connectorId: failureStage === 'start' ? null : 'trusted-connector-1',
        expiresAt: failureStage === 'start' ? null : '2026-07-13T10:10:00.000Z',
      },
      {
        ruleId: 'rule-b',
        status: 'submitted',
        sessionId: 'zktls-session-1',
        connectorId: 'trusted-connector-1',
        expiresAt: '2026-07-13T10:10:00.000Z',
      },
    ])
    expect(await harness.controller.getState()).toMatchObject({
      status: 'submitting',
      error: 'VERIFICATION_FAILED',
    })
  })

  it.each([
    'start',
    'prove-throw',
    'prove-result',
  ] as const)('continues same-batch queued work after failed %s without retrying the failed rule', async (failureStage) => {
    if (failureStage === 'start') {
      harness.startZkTls.mockRejectedValueOnce(new Error('start failed'))
    } else if (failureStage === 'prove-throw') {
      harness.proveZkTls.mockRejectedValueOnce(new Error('prove failed'))
    } else {
      harness.proveZkTls.mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'error',
        code: 'REQUEST_NOT_CAPTURED',
      }))
    }

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
      match('rule-b'),
    ])
    await vi.waitFor(() =>
      expect(
        harness.storage.session?.zkTlsQueue.find(
          (item) => item.ruleId === 'rule-b',
        )?.status,
      ).toBe('submitted'),
    )

    expect(harness.startZkTls).toHaveBeenCalledTimes(2)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(
      failureStage === 'start' ? 1 : 2,
    )
    expect(harness.storage.session?.zkTlsQueue).toMatchObject([
      expect.objectContaining({ ruleId: 'rule-a', status: 'paused' }),
      expect.objectContaining({ ruleId: 'rule-b', status: 'submitted' }),
    ])
  })

  it('keeps a failed rule paused across a controller restart until matching evidence returns', async () => {
    harness.proveZkTls.mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status: 'error',
      code: 'REQUEST_NOT_CAPTURED',
    }))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('paused'),
    )

    const restarted = new ProductExperienceController(harness.dependencies)
    await restarted.resumePendingSubmit()
    await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
    expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('paused')

    await restarted.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))
    expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted')
  })

  it('keeps a paused failure visible when the page watcher becomes ready again', async () => {
    harness.proveZkTls.mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status: 'error',
      code: 'PROVER_FAILED',
    }))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session).toMatchObject({
        error: 'VERIFICATION_FAILED',
        zkTlsFailureCode: 'PROVER_FAILED',
        zkTlsQueue: [
          expect.objectContaining({ ruleId: 'rule-a', status: 'paused' }),
        ],
      }),
    )

    const state = await harness.controller.ready(sender(), 'session-12345678')

    expect(state).toMatchObject({
      status: 'observing',
      error: 'VERIFICATION_FAILED',
      zkTlsFailureCode: 'PROVER_FAILED',
    })
    expect(harness.storage.session).toMatchObject({
      error: 'VERIFICATION_FAILED',
      zkTlsFailureCode: 'PROVER_FAILED',
      zkTlsQueue: [
        expect.objectContaining({ ruleId: 'rule-a', status: 'paused' }),
      ],
    })
  })

  it('returns to a retryable observing state after another submitted rule verifies', async () => {
    harness.proveZkTls.mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status: 'error',
      code: 'REQUEST_NOT_CAPTURED',
    }))
    harness.readZkTlsProgress.mockResolvedValueOnce([
      {
        ruleId: 'rule-a',
        title: 'First step',
        status: 'PENDING',
        current: null,
        target: true,
        unit: null,
      },
      {
        ruleId: 'rule-b',
        title: 'Second step',
        status: 'VERIFIED',
        current: true,
        target: true,
        unit: null,
      },
    ])

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('paused'),
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    await vi.waitFor(() =>
      expect(
        harness.storage.session?.zkTlsQueue.find(
          (item) => item.ruleId === 'rule-b',
        )?.status,
      ).toBe('submitted'),
    )

    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsync()

    expect(harness.storage.session).toMatchObject({
      status: 'observing',
      error: 'VERIFICATION_FAILED',
      verifiedRuleIds: ['rule-b'],
      zkTlsQueue: [
        expect.objectContaining({ ruleId: 'rule-a', status: 'paused' }),
      ],
    })
    expect(await harness.controller.getState()).toMatchObject({
      status: 'observing',
      error: 'VERIFICATION_FAILED',
      matchedRuleIds: ['rule-b'],
    })
  })

  it.each([
    ['pending_login', undefined, 'AUTHORIZATION_REQUIRED', true, false],
    ['error', 'PERMISSION_DENIED', 'AUTHORIZATION_REQUIRED', true, false],
    ['error', 'REQUEST_NOT_CAPTURED', 'VERIFICATION_FAILED', false, false],
    ['unsupported', undefined, 'VERIFICATION_FAILED', false, false],
    ['error', 'SESSION_EXPIRED', 'SESSION_EXPIRED', false, true],
  ] as const)('leaves %s/%s failures retryable without claiming completion', async (status, code, error, authorizationRequired, clearsSession) => {
    harness.proveZkTls.mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status,
      ...(code ? { code } : {}),
    }))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => {
      expect(harness.storage.session?.zkTlsQueue).toMatchObject([
        {
          ruleId: 'rule-a',
          status: 'paused',
          sessionId: clearsSession ? null : 'zktls-session-1',
          connectorId: clearsSession ? null : 'trusted-connector-1',
          expiresAt: clearsSession ? null : '2026-07-13T10:10:00.000Z',
        },
      ])
      expect(harness.storage.session?.error).toBe(error)
    })
    expect(await harness.controller.getState()).toMatchObject({
      status: authorizationRequired ? 'reauthorize' : 'observing',
      matchedRuleIds: [],
      error,
      authorizationRequired,
    })
  })

  it('keeps reauthorization visible while submitted work is waiting', async () => {
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )

    await expect(
      harness.controller.handleTabUpdated(7, { status: 'complete' }),
    ).resolves.toMatchObject({
      status: 'reauthorize',
      authorizationRequired: true,
      error: 'AUTHORIZATION_REQUIRED',
    })
  })

  it('resumes submitted polling after an authorized-origin start', async () => {
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )

    await harness.controller.handleTabUpdated(7, {
      status: 'complete',
      url: `${SECOND_ORIGIN}/next`,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsync()
    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(1)

    harness.activeTab.value = { id: 7, url: `${CLIENT_ORIGIN}/app/return` }
    await expect(harness.controller.start()).resolves.toMatchObject({
      status: 'submitting',
      authorizationRequired: false,
      error: null,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsync()

    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(2)
  })

  it('preserves a paused verification failure when submitted polling is reauthorized', async () => {
    harness.proveZkTls.mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status: 'error',
      code: 'PROVER_FAILED',
    }))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('paused'),
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    await vi.waitFor(() =>
      expect(
        harness.storage.session?.zkTlsQueue.find(
          (item) => item.ruleId === 'rule-b',
        )?.status,
      ).toBe('submitted'),
    )

    await harness.controller.handleTabUpdated(7, {
      status: 'complete',
      url: `${SECOND_ORIGIN}/next`,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsync()
    harness.activeTab.value = { id: 7, url: `${CLIENT_ORIGIN}/app/return` }

    await expect(harness.controller.start()).resolves.toMatchObject({
      status: 'submitting',
      authorizationRequired: false,
      error: 'VERIFICATION_FAILED',
      zkTlsFailureCode: 'PROVER_FAILED',
    })
  })

  it.each([
    'start-throw',
    'prove-throw',
    'permission-denied',
    'capture-failed',
  ] as const)('does not let a late %s replace navigation reauthorization', async (failureStage) => {
    let finishFailure: (() => void) | undefined
    if (failureStage === 'start-throw') {
      harness.startZkTls.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            finishFailure = () => reject(new Error('late setup failure'))
          }),
      )
    } else {
      harness.proveZkTls.mockImplementationOnce(
        (input) =>
          new Promise((resolve, reject) => {
            if (failureStage === 'prove-throw') {
              finishFailure = () => reject(new Error('late capture failure'))
              return
            }
            finishFailure = () =>
              resolve({
                type: 'zktls-prove-result',
                correlationId: input.correlationId,
                status: 'error',
                code:
                  failureStage === 'permission-denied'
                    ? 'PERMISSION_DENIED'
                    : 'REQUEST_NOT_CAPTURED',
              })
          }),
      )
    }

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => {
      if (failureStage === 'start-throw') {
        expect(harness.startZkTls).toHaveBeenCalledTimes(1)
      } else {
        expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
      }
    })
    await harness.controller.handleTabUpdated(7, { status: 'complete' })
    const notificationsBeforeFailure =
      harness.notifyStateChanged.mock.calls.length
    finishFailure?.()
    await vi.waitFor(() =>
      expect(harness.notifyStateChanged.mock.calls.length).toBeGreaterThan(
        notificationsBeforeFailure,
      ),
    )

    expect(harness.storage.session).toMatchObject({
      status: 'reauthorize',
      currentOriginAllowed: false,
      error: 'AUTHORIZATION_REQUIRED',
    })
    expect(await harness.controller.getState()).toMatchObject({
      status: 'reauthorize',
      authorizationRequired: true,
      error: 'AUTHORIZATION_REQUIRED',
    })
  })

  it('does not let late submitted-session expiry replace navigation reauthorization', async () => {
    harness.startZkTls.mockResolvedValueOnce({
      sessionId: 'expires-after-navigation',
      connectorId: 'trusted-connector-1',
      expiresAt: new Date(NOW).toISOString(),
    })

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )
    await harness.controller.handleTabUpdated(7, { status: 'complete' })
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsync()

    expect(harness.storage.session).toMatchObject({
      status: 'reauthorize',
      currentOriginAllowed: false,
      error: 'AUTHORIZATION_REQUIRED',
    })
    expect(await harness.controller.getState()).toMatchObject({
      status: 'reauthorize',
      authorizationRequired: true,
      error: 'AUTHORIZATION_REQUIRED',
    })
  })

  it.each([
    'PARTIAL',
    'VERIFIED',
  ] as const)('stops queued work when late backend %s arrives after reauthorization', async (backendStatus) => {
    let finishProgress:
      | ((value: ProductZkTlsRuleProgress[]) => void)
      | undefined
    const progress: ProductZkTlsRuleProgress[] = [
      {
        ruleId: 'rule-a',
        title: 'First step',
        status: backendStatus,
        current: backendStatus === 'PARTIAL' ? 1 : true,
        target: backendStatus === 'PARTIAL' ? 3 : true,
        unit: backendStatus === 'PARTIAL' ? 'days' : null,
      },
      {
        ruleId: 'rule-b',
        title: 'Second step',
        status: 'PENDING',
        current: null,
        target: true,
        unit: null,
      },
    ]
    harness.readZkTlsProgress.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProgress = resolve
        }),
    )

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )
    const pollBoundary = vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() =>
      expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(1),
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    await harness.controller.handleTabUpdated(7, { status: 'complete' })
    finishProgress?.(progress)
    await pollBoundary
    await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(1)
    expect(harness.storage.session).toMatchObject({
      status: 'reauthorize',
      currentOriginAllowed: false,
      error: 'AUTHORIZATION_REQUIRED',
      verifiedRuleIds: backendStatus === 'VERIFIED' ? ['rule-a'] : [],
      zkTlsQueue: [
        {
          ruleId: 'rule-b',
          status: 'queued',
          sessionId: null,
          connectorId: null,
          expiresAt: null,
        },
      ],
      zkTlsProgress: [
        expect.objectContaining({
          ruleId: 'rule-a',
          status: backendStatus,
        }),
        expect.objectContaining({
          ruleId: 'rule-b',
          status: 'PENDING',
        }),
      ],
    })
    expect(await harness.controller.getState()).toMatchObject({
      status: 'reauthorize',
      authorizationRequired: true,
      error: 'AUTHORIZATION_REQUIRED',
    })

    await harness.controller.start()
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))
    expect(harness.startZkTls).toHaveBeenLastCalledWith(
      expect.objectContaining({ ruleId: 'rule-b' }),
    )
  })

  it('waits for the current TEST integration check even after backend VERIFIED progress', async () => {
    await harness.controller.cancel()
    await harness.controller.saveTask(task('TEST'))
    await harness.controller.start()
    harness.readZkTlsProgress.mockResolvedValueOnce(
      rules.map((rule) => ({
        ruleId: rule.id,
        title: rule.title,
        status: 'VERIFIED' as const,
        current: true,
        target: true,
        unit: null,
      })),
    )

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKind: 'TEST' }),
    )
    expect(harness.readZkTlsProgress).toHaveBeenCalledWith(
      'campaign-product-001',
    )
    expect(await harness.controller.getState()).toMatchObject({
      status: 'submitting',
      matchedRuleIds: [],
      zkTlsFinished: false,
    })
    harness.readIntegration.mockResolvedValue({
      configVersion: 3,
      experiencePassed: true,
      experiencePassedAt: '2026-07-13T10:00:01.000Z',
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await harness.controller.getState()).toMatchObject({
      status: 'observing',
      matchedRuleIds: [],
      zkTlsFinished: true,
      zkTlsTestPassed: true,
    })
  })

  it('reuses an unexpired backend session when start resumes a failed proof', async () => {
    harness.proveZkTls
      .mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'error',
        code: 'REQUEST_NOT_CAPTURED',
      }))
      .mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'submitted',
      }))
    harness.startZkTls.mockResolvedValueOnce({
      sessionId: 'failed-session',
      connectorId: 'trusted-connector-1',
      expiresAt: '2026-07-13T10:10:00.000Z',
    })

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('queued'),
    )
    await harness.controller.start()
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'failed-session' }),
    )
  })

  it('expires a submitted attempt into a retryable fresh-session state', async () => {
    harness.startZkTls.mockResolvedValueOnce({
      sessionId: 'expired-attempt',
      connectorId: 'trusted-connector-1',
      expiresAt: new Date(NOW).toISOString(),
    })

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    expect(harness.readZkTlsProgress).not.toHaveBeenCalled()
    expect(harness.storage.session?.zkTlsQueue).toMatchObject([
      {
        ruleId: 'rule-a',
        status: 'queued',
        sessionId: null,
        connectorId: null,
        expiresAt: null,
      },
    ])
    expect(await harness.controller.getState()).toMatchObject({
      status: 'observing',
      error: 'SESSION_EXPIRED',
      matchedRuleIds: [],
    })
  })

  it.each([
    'start',
    'ready',
  ] as const)('keeps submitted work public as submitting and restores polling through %s', async (entrypoint) => {
    const session = await harness.storage.getSession()
    if (!session) throw new Error('missing session')
    session.status = 'submitting'
    session.zkTlsQueue = [
      {
        ruleId: 'rule-a',
        status: 'submitted',
        sessionId: 'submitted-session',
        connectorId: 'submitted-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      },
    ]
    await harness.storage.setSession(session)

    const state =
      entrypoint === 'start'
        ? await harness.controller.start()
        : await harness.controller.ready(sender(), 'session-12345678')

    expect(state).toMatchObject({
      status: 'submitting',
      matchedRuleIds: [],
    })
    expect(harness.storage.session?.status).toBe('submitting')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).not.toHaveBeenCalled()
  })

  it('coalesces automatic ready after start into the same submitted polling budget', async () => {
    const session = await harness.storage.getSession()
    if (!session) throw new Error('missing session')
    session.status = 'submitting'
    session.zkTlsQueue = [
      {
        ruleId: 'rule-a',
        status: 'submitted',
        sessionId: 'submitted-session',
        connectorId: 'submitted-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      },
    ]
    await harness.storage.setSession(session)

    await expect(harness.controller.start()).resolves.toMatchObject({
      status: 'submitting',
    })
    await expect(
      harness.controller.ready(sender(), 'session-12345678'),
    ).resolves.toMatchObject({ status: 'submitting' })
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsync()

    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(5)
    expect(harness.startZkTls).not.toHaveBeenCalled()
    expect(harness.proveZkTls).not.toHaveBeenCalled()
  })

  it('serially processes a genuinely new rule added while another proof is in flight', async () => {
    let finishFirst:
      | ((value: Awaited<ReturnType<typeof harness.proveZkTls>>) => void)
      | undefined
    harness.startZkTls
      .mockResolvedValueOnce({
        sessionId: 'first-session',
        connectorId: 'first-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      })
      .mockResolvedValueOnce({
        sessionId: 'second-session',
        connectorId: 'second-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      })
    harness.proveZkTls.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )
    harness.readZkTlsProgress.mockResolvedValueOnce([
      {
        ruleId: 'rule-a',
        title: 'First step',
        status: 'VERIFIED',
        current: true,
        target: true,
        unit: null,
      },
      {
        ruleId: 'rule-b',
        title: 'Second step',
        status: 'PENDING',
        current: null,
        target: true,
        unit: null,
      },
    ])

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(1))
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    finishFirst?.({
      type: 'zktls-prove-result',
      correlationId: 'first-correlation',
      status: 'submitted',
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    expect(harness.proveZkTls).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'second-session',
        connectorId: 'second-connector',
      }),
    )
  })

  it('starts a replacement session proof before the stale session flight settles', async () => {
    let finishStale:
      | ((value: Awaited<ReturnType<typeof harness.proveZkTls>>) => void)
      | undefined
    harness.proveZkTls.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStale = resolve
        }),
    )

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(1))

    harness.randomSessionId.mockReturnValue('session-replacement')
    await harness.controller.saveTask(replacementTask())
    await harness.controller.start()
    await harness.controller.handleEvidence(sender(), 'session-replacement', [
      match('rule-a'),
    ])

    await vi.waitFor(() => expect(harness.startZkTls).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))
    expect(harness.storage.session).toMatchObject({
      sessionId: 'session-replacement',
      campaignId: 'campaign-product-002',
      zkTlsQueue: [
        expect.objectContaining({ ruleId: 'rule-a', status: 'submitted' }),
      ],
    })

    finishStale?.({
      type: 'zktls-prove-result',
      correlationId: 'stale-correlation',
      status: 'error',
      code: 'REQUEST_NOT_CAPTURED',
    })
    await flushAsync()

    expect(harness.storage.session).toMatchObject({
      sessionId: 'session-replacement',
      campaignId: 'campaign-product-002',
      zkTlsQueue: [
        expect.objectContaining({ ruleId: 'rule-a', status: 'submitted' }),
      ],
      error: null,
    })
  })

  it('does not let a stale after-current helper untrack the replacement flight', async () => {
    let finishFirst:
      | ((value: Awaited<ReturnType<typeof harness.proveZkTls>>) => void)
      | undefined
    harness.proveZkTls
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve
          }),
      )
      .mockImplementationOnce(() => new Promise(() => undefined))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(1))
    await harness.controller.start()

    harness.randomSessionId.mockReturnValue('session-replacement')
    await harness.controller.saveTask(replacementTask())
    await harness.controller.start()
    await harness.controller.handleEvidence(sender(), 'session-replacement', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    finishFirst?.({
      type: 'zktls-prove-result',
      correlationId: 'stale-correlation',
      status: 'submitted',
    })
    await flushAsync()
    await flushAsync()

    await harness.controller.handleEvidence(sender(), 'session-replacement', [
      match('rule-b'),
    ])
    for (let index = 0; index < 10; index += 1) await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledTimes(2)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(2)
    expect(harness.storage.session).toMatchObject({
      sessionId: 'session-replacement',
      zkTlsQueue: [
        expect.objectContaining({ ruleId: 'rule-a', status: 'proving' }),
        expect.objectContaining({ ruleId: 'rule-b', status: 'queued' }),
      ],
    })
  })

  it('does not let a slow stale start drain overwrite the replacement flight', async () => {
    let finishInject: (() => void) | undefined
    harness.proveZkTls
      .mockImplementationOnce(async (input) => ({
        type: 'zktls-prove-result',
        correlationId: input.correlationId,
        status: 'submitted',
      }))
      .mockImplementationOnce(() => new Promise(() => undefined))

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )

    harness.inject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInject = () => resolve(undefined)
        }),
    )
    const staleStart = harness.controller.start()
    await vi.waitFor(() => expect(harness.inject).toHaveBeenCalledTimes(2))

    harness.randomSessionId.mockReturnValue('session-replacement')
    await harness.controller.saveTask(replacementTask())
    await harness.controller.start()
    await harness.controller.handleEvidence(sender(), 'session-replacement', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    finishInject?.()
    await staleStart
    await flushAsync()
    await harness.controller.handleEvidence(sender(), 'session-replacement', [
      match('rule-b'),
    ])
    for (let index = 0; index < 10; index += 1) await flushAsync()

    expect(harness.startZkTls).toHaveBeenCalledTimes(2)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(2)
    expect(harness.storage.session).toMatchObject({
      sessionId: 'session-replacement',
      zkTlsQueue: [
        expect.objectContaining({ ruleId: 'rule-a', status: 'proving' }),
        expect.objectContaining({ ruleId: 'rule-b', status: 'queued' }),
      ],
    })
  })

  it('lets a replacement drain supersede a stale follow-up flight', async () => {
    let finishFirst:
      | ((value: Awaited<ReturnType<typeof harness.proveZkTls>>) => void)
      | undefined
    harness.proveZkTls.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(1))
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])

    harness.randomSessionId.mockReturnValue('session-replacement')
    await harness.controller.saveTask(replacementTask())
    await harness.controller.start()

    const originalGetSession = harness.storage.getSession.bind(harness.storage)
    let sessionReadCount = 0
    let releaseReplacementRead: (() => void) | undefined
    let releaseStaleRead: (() => void) | undefined
    let markReplacementRead: (() => void) | undefined
    let markReplacementReadReturned: (() => void) | undefined
    let markStaleRead: (() => void) | undefined
    const replacementReadReached = new Promise<void>((resolve) => {
      markReplacementRead = resolve
    })
    const staleReadReached = new Promise<void>((resolve) => {
      markStaleRead = resolve
    })
    const replacementReadReturned = new Promise<void>((resolve) => {
      markReplacementReadReturned = resolve
    })
    const replacementReadGate = new Promise<void>((resolve) => {
      releaseReplacementRead = resolve
    })
    const staleReadGate = new Promise<void>((resolve) => {
      releaseStaleRead = resolve
    })
    harness.storage.getSession = vi.fn(async () => {
      sessionReadCount += 1
      if (sessionReadCount === 3) {
        markReplacementRead?.()
        await replacementReadGate
        const session = await originalGetSession()
        markReplacementReadReturned?.()
        return session
      }
      if (sessionReadCount === 5) {
        markStaleRead?.()
        await staleReadGate
      }
      return originalGetSession()
    })

    await harness.controller.handleEvidence(sender(), 'session-replacement', [
      match('rule-a'),
    ])
    await replacementReadReached

    finishFirst?.({
      type: 'zktls-prove-result',
      correlationId: 'stale-correlation',
      status: 'submitted',
    })
    await staleReadReached
    releaseReplacementRead?.()
    await replacementReadReturned

    try {
      await vi.waitFor(() =>
        expect(harness.proveZkTls).toHaveBeenCalledTimes(2),
      )
      expect(harness.startZkTls).toHaveBeenCalledTimes(2)
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted')
    } finally {
      releaseStaleRead?.()
    }
  })

  it('yields a submitted poll at the safe boundary for new same-session evidence', async () => {
    await harness.controller.cancel()
    harness = createHarness(true)
    harness.mintParticipant.mockResolvedValue(
      ticket({ verificationMode: 'ZKTLS' }),
    )
    await harness.controller.saveTask(task())
    await harness.controller.start()

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    expect.soft(harness.storage.session?.zkTlsDiagnostic?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'proof-queue-waiting',
          status: 'running',
          details: { ruleIds: ['rule-b'] },
        }),
      ]),
    )
    expect(harness.startZkTls).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    expect(harness.readZkTlsProgress).not.toHaveBeenCalled()
    expect(harness.startZkTls).toHaveBeenNthCalledWith(2, {
      campaignId: 'campaign-product-001',
      ruleId: 'rule-b',
      ticketKind: 'PARTICIPANT',
    })
  })

  it('resumes a yielded submitted rule after the new rule verifies', async () => {
    harness.readZkTlsProgress
      .mockResolvedValueOnce([
        {
          ruleId: 'rule-a',
          title: 'First step',
          status: 'PENDING',
          current: null,
          target: true,
          unit: null,
        },
        {
          ruleId: 'rule-b',
          title: 'Second step',
          status: 'VERIFIED',
          current: true,
          target: true,
          unit: null,
        },
      ])
      .mockResolvedValueOnce(
        rules.map((rule) => ({
          ruleId: rule.id,
          title: rule.title,
          status: 'VERIFIED' as const,
          current: true,
          target: true,
          unit: null,
        })),
      )

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.waitFor(() =>
      expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
    )
    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsync()

    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(2)
    expect(harness.startZkTls).toHaveBeenCalledTimes(2)
    expect(harness.proveZkTls).toHaveBeenCalledTimes(2)
    expect(await harness.controller.getState()).toMatchObject({
      status: 'verified',
      matchedRuleIds: ['rule-a', 'rule-b'],
    })
    expect(harness.storage.session).toBeNull()
  })

  it('lets a new rule proceed without repolling an exhausted submitted rule', async () => {
    harness.startZkTls
      .mockResolvedValueOnce({
        sessionId: 'exhausted-session',
        connectorId: 'exhausted-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      })
      .mockResolvedValueOnce({
        sessionId: 'next-session',
        connectorId: 'next-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      })

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-a'),
    ])
    await vi.advanceTimersByTimeAsync(30_000)
    await flushAsync()
    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(5)

    await harness.controller.handleEvidence(sender(), 'session-12345678', [
      match('rule-b'),
    ])
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

    expect(harness.readZkTlsProgress).toHaveBeenCalledTimes(5)
    expect(harness.startZkTls).toHaveBeenNthCalledWith(2, {
      campaignId: 'campaign-product-001',
      ruleId: 'rule-b',
      ticketKind: 'PARTICIPANT',
    })
    expect(harness.proveZkTls).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'next-session',
        connectorId: 'next-connector',
      }),
    )
  })

  it('resumes submitted and unexpired proving session IDs after restart', async () => {
    const session = await harness.storage.getSession()
    if (!session) throw new Error('missing session')
    session.zkTlsQueue = [
      {
        ruleId: 'rule-a',
        status: 'submitted',
        sessionId: 'submitted-session',
        connectorId: 'submitted-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      },
      {
        ruleId: 'rule-b',
        status: 'proving',
        sessionId: 'interrupted-session',
        connectorId: 'interrupted-connector',
        expiresAt: '2026-07-13T10:10:00.000Z',
      },
    ]
    await harness.storage.setSession(session)
    harness.readZkTlsProgress.mockResolvedValueOnce([
      {
        ruleId: 'rule-a',
        title: 'First step',
        status: 'VERIFIED',
        current: true,
        target: true,
        unit: null,
      },
      {
        ruleId: 'rule-b',
        title: 'Second step',
        status: 'PENDING',
        current: null,
        target: true,
        unit: null,
      },
    ])
    const restarted = new ProductExperienceController(harness.dependencies)
    const resumed = restarted.resumePendingSubmit()
    await flushAsync()

    await expect(resumed).resolves.toMatchObject({ status: 'submitting' })

    expect(harness.proveZkTls).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'submitted-session' }),
    )
    expect(harness.startZkTls).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsync()
    expect(harness.startZkTls).not.toHaveBeenCalled()
    expect(harness.proveZkTls).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'interrupted-session' }),
    )
  })

  it.each([
    ['expired', 'old-session', 'old-connector', '2026-07-13T09:59:59.000Z'],
    ['invalid expiry', 'old-session', 'old-connector', 'not-a-date'],
    ['missing connector', 'old-session', null, '2026-07-13T10:10:00.000Z'],
  ] as const)('starts a fresh backend session for %s proving metadata', async (_label, sessionId, connectorId, expiresAt) => {
    const session = await harness.storage.getSession()
    if (!session) throw new Error('missing session')
    session.zkTlsQueue = [
      {
        ruleId: 'rule-a',
        status: 'proving',
        sessionId,
        connectorId,
        expiresAt,
      },
    ]
    await harness.storage.setSession(session)

    const restarted = new ProductExperienceController(harness.dependencies)
    await restarted.resumePendingSubmit()
    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(1))

    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'zktls-session-1' }),
    )
  })
})

describe('product experience storage isolation', () => {
  it('removes only the two product keys and never clears engagement session state', async () => {
    const remove = vi.fn(async () => undefined)
    const clear = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', {
      storage: {
        session: { remove, clear },
      },
    })

    await clearProductExperienceStorage()

    expect(remove).toHaveBeenCalledWith([
      'activeProductExperienceTask',
      'productExperienceSession',
    ])
    expect(clear).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
