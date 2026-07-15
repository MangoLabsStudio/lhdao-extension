import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProductExperienceRule,
  ProductExperienceTaskRef,
  ProductExperienceTicket,
  ProductRuleMatch,
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

function createHarness() {
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
  const sign = vi.fn(
    async (
      _macKey: string,
      _input: Parameters<ProductExperienceControllerDependencies['sign']>[1],
    ) => 'signed-proof',
  )
  const dependencies: ProductExperienceControllerDependencies = {
    storage,
    getActiveTab: vi.fn(async () => activeTab.value),
    inject,
    mintParticipant,
    mintTest,
    submit,
    now: () => NOW,
    randomNonce: () => '00112233445566778899aabbccddeeff',
    randomSessionId: () => 'session-12345678',
    runtimeId: () => 'extension-id',
    sign,
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
    sign,
    storage,
    submit,
  }
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
      rules,
    })
    expect(JSON.stringify(response)).not.toContain('ticket-value')
    expect(JSON.stringify(response)).not.toContain('mac-key')
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
