import type {
  ProductExperienceRule,
  ProductExperienceTaskRef,
  ProductExperienceTicket,
  ProductRuleMatch,
  ProductTicketKind,
  ProductZkTlsRuleProgress,
  ProductZkTlsSession,
} from '../types/product-experience'
import type { ProductExperienceCanonicalInput } from './product-experience-proof'
import type {
  ProductExperiencePublicError,
  ProductExperiencePublicStateSource,
  ProductExperiencePublicStatus,
} from './product-experience-task-bridge'
import type {
  SubmitProductExperienceProofResult,
  SubmitProductExperienceProofVariables,
} from './queries'
import type { ZkTlsRunRequest, ZkTlsRunResult } from './zktls/runtime'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const PATH_HASH_PATTERN = /^[a-f0-9]{64}$/

export interface ProductExperienceControllerState {
  campaignId: string | null
  title: string | null
  status: ProductExperiencePublicStatus
  matchedRuleIds: string[]
  totalRuleCount: number
  authorizationRequired: boolean
  currentOriginAllowed: boolean
  error: ProductExperiencePublicError | null
}

export interface ProductExperienceSaveResult {
  saved: boolean
  state: ProductExperienceControllerState
}

export interface ProductExperienceRuntimeSender {
  extensionId?: string
  tabId?: number
  frameId?: number
  origin?: string
}

export type ProductZkTlsQueueItem = {
  ruleId: string
  status: 'queued' | 'proving' | 'submitted'
  sessionId: string | null
  connectorId: string | null
  expiresAt: string | null
}

export interface ProductExperienceSession {
  sessionId: string
  campaignId: string
  title: string
  ticketKind: ProductExperienceTaskRef['ticketKind']
  configVersion: number
  tabId: number
  authorizedOrigin: string
  currentOrigin: string
  currentOriginAllowed: boolean
  verificationMode: ProductExperienceTicket['verificationMode']
  ticket?: string
  macKey?: string
  expiresAt: string
  ruleSetVersion: number
  allowedOrigins: string[]
  completionMode: 'ALL'
  rules: ProductExperienceRule[]
  matches: ProductRuleMatch[]
  pendingSubmit?: SubmitProductExperienceProofVariables | null
  zkTlsQueue: ProductZkTlsQueueItem[]
  verifiedRuleIds: string[]
  status: 'observing' | 'reauthorize' | 'submitting'
  error: ProductExperiencePublicError | null
}

export interface ProductExperienceControllerStorage {
  getTask(): Promise<ProductExperienceTaskRef | null>
  setTask(task: ProductExperienceTaskRef): Promise<void>
  getSession(): Promise<ProductExperienceSession | null>
  setSession(session: ProductExperienceSession): Promise<void>
  clearProduct(): Promise<void>
}

export interface ProductExperienceControllerDependencies {
  storage: ProductExperienceControllerStorage
  getActiveTab(): Promise<{ id: number; url: string } | null>
  inject(tabId: number): Promise<void>
  mintParticipant(campaignId: string): Promise<ProductExperienceTicket>
  mintTest(campaignId: string): Promise<ProductExperienceTicket>
  submit(
    input: SubmitProductExperienceProofVariables,
  ): Promise<SubmitProductExperienceProofResult>
  startZkTls(input: {
    campaignId: string
    ruleId: string
    ticketKind: ProductTicketKind
  }): Promise<ProductZkTlsSession>
  proveZkTls(input: ZkTlsRunRequest): Promise<ZkTlsRunResult>
  readZkTlsProgress(campaignId: string): Promise<ProductZkTlsRuleProgress[]>
  now(): number
  randomNonce(): string
  randomSessionId(): string
  runtimeId(): string
  sign(macKey: string, input: ProductExperienceCanonicalInput): Promise<string>
  notifyStateChanged(): Promise<void> | void
}

export type ProductExperienceBootstrapResponse =
  | {
      ok: true
      sessionId: string
      ruleSetVersion: number
      allowedOrigins: string[]
      completionMode: 'ALL'
      evaluationMode: 'STRICT' | 'SELECTOR_ONLY'
      rules: ProductExperienceRule[]
    }
  | { ok: false; error: 'INVALID_SENDER' | 'NO_ACTIVE_SESSION' }

export interface ProductExperienceTabUpdate {
  status?: string
  url?: string
}

interface ProductExperienceSubmitFlight {
  key: string
  promise: Promise<ProductExperienceControllerState>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isUncertainTransportError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'uncertain' in error &&
    (error as Error & { uncertain?: unknown }).uncertain === true
  )
}

function idleState(): ProductExperienceControllerState {
  return {
    campaignId: null,
    title: null,
    status: 'idle',
    matchedRuleIds: [],
    totalRuleCount: 0,
    authorizationRequired: false,
    currentOriginAllowed: false,
    error: null,
  }
}

function safeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.username.length > 0 || parsed.password.length > 0) return null
    if (parsed.protocol === 'https:') return parsed.origin
    if (
      parsed.protocol === 'http:' &&
      LOOPBACK_HOSTNAMES.has(parsed.hostname)
    ) {
      return parsed.origin
    }
  } catch {
    // Invalid URLs fail closed.
  }
  return null
}

function normalizeAllowedOrigins(origins: readonly string[]): string[] | null {
  const normalized = new Set<string>()
  for (const value of origins) {
    const origin = safeOrigin(value)
    if (!origin || origin !== value) return null
    normalized.add(origin)
  }
  return normalized.size > 0 ? [...normalized] : null
}

function isExpired(session: ProductExperienceSession, now: number): boolean {
  const expiresAt = Date.parse(session.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

function isTicketExpired(
  ticket: ProductExperienceTicket,
  now: number,
): boolean {
  const expiresAt = Date.parse(ticket.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

function taskMatchesSession(
  task: ProductExperienceTaskRef,
  session: ProductExperienceSession,
): boolean {
  return (
    task.campaignId === session.campaignId &&
    task.configVersion === session.configVersion &&
    task.ticketKind === session.ticketKind
  )
}

function pendingSubmissionKey(
  session: ProductExperienceSession | null,
): string | null {
  const input = session?.pendingSubmit?.input
  if (!session || !input) return null
  return [
    session.sessionId,
    input.campaignId,
    input.ruleSetVersion,
    input.nonce,
    input.sig,
  ].join(':')
}

function isLegacySession(
  session: ProductExperienceSession,
): session is ProductExperienceSession & {
  verificationMode: 'LEGACY_DOM'
  ticket: string
  macKey: string
  pendingSubmit: SubmitProductExperienceProofVariables | null
} {
  return (
    session.verificationMode === 'LEGACY_DOM' &&
    typeof session.ticket === 'string' &&
    typeof session.macKey === 'string'
  )
}

function isZkTlsSession(
  session: ProductExperienceSession | null,
): session is ProductExperienceSession & { verificationMode: 'ZKTLS' } {
  return session?.verificationMode === 'ZKTLS'
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function sameTaskIdentity(
  left: ProductExperienceTaskRef,
  right: ProductExperienceTaskRef,
): boolean {
  return (
    left.campaignId === right.campaignId &&
    left.configVersion === right.configVersion &&
    left.ticketKind === right.ticketKind
  )
}

function asPublicSource(
  state: ProductExperienceControllerState,
): ProductExperiencePublicStateSource | null {
  if (!state.campaignId) return null
  return {
    campaignId: state.campaignId,
    status: state.status,
    matchedRuleIds: state.matchedRuleIds,
    totalRuleCount: state.totalRuleCount,
    authorizationRequired: state.authorizationRequired,
    currentOriginAllowed: state.currentOriginAllowed,
    error: state.error,
  }
}

export function controllerStateToPublicSource(
  state: ProductExperienceControllerState,
): ProductExperiencePublicStateSource | null {
  return asPublicSource(state)
}

export class ProductExperienceController {
  private lastState: ProductExperienceControllerState | null = null
  private submitInFlight: ProductExperienceSubmitFlight | null = null
  private zkTlsFlight: Promise<void> | null = null
  private zkTlsDrainRequested = false
  private zkTlsMutationQueue: Promise<void> = Promise.resolve()
  private evidenceQueue: Promise<void> = Promise.resolve()
  private generation = 0
  private readonly pendingAuthorizations = new Map<
    number,
    Map<number, number>
  >()

  constructor(
    private readonly dependencies: ProductExperienceControllerDependencies,
  ) {}

  async saveTask(
    task: ProductExperienceTaskRef,
  ): Promise<ProductExperienceSaveResult> {
    const saveGeneration = this.generation
    const [currentTask, currentSession] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (this.generation !== saveGeneration) {
      return { saved: false, state: await this.getStateWithoutRetry() }
    }
    if (currentSession?.pendingSubmit) {
      const saved = taskMatchesSession(task, currentSession)
      return { saved, state: this.stateFromSession(currentSession) }
    }
    const replacesTask = !currentTask || !sameTaskIdentity(currentTask, task)
    const replacesSession = Boolean(
      currentSession && !taskMatchesSession(task, currentSession),
    )
    const writeGeneration =
      replacesTask || replacesSession
        ? this.advanceGeneration()
        : this.generation
    if (replacesSession) {
      await this.dependencies.storage.clearProduct()
      if (this.generation !== writeGeneration) {
        return { saved: false, state: await this.getStateWithoutRetry() }
      }
    }
    await this.dependencies.storage.setTask(clone(task))
    if (this.generation !== writeGeneration) {
      return { saved: false, state: await this.getStateWithoutRetry() }
    }
    this.lastState = null
    await this.notify()
    const session = await this.dependencies.storage.getSession()
    return {
      saved: true,
      state:
        session && taskMatchesSession(task, session)
          ? this.stateFromSession(session)
          : this.readyState(task),
    }
  }

  async getState(): Promise<ProductExperienceControllerState> {
    const readGeneration = this.generation
    const [task, session] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (this.generation !== readGeneration) return this.getState()
    if (session?.pendingSubmit) return this.retryPendingSubmit()
    if (task && session) {
      const invalid = await this.ensureSessionValid(task, session)
      if (invalid) return invalid
      if (this.generation !== readGeneration) return this.getState()
      return this.stateFromSession(session)
    }
    if (
      this.lastState &&
      (!task || this.lastState.campaignId === task.campaignId)
    ) {
      return clone(this.lastState)
    }
    return task ? this.readyState(task) : idleState()
  }

  async start(): Promise<ProductExperienceControllerState> {
    const startGeneration = this.generation
    const task = await this.dependencies.storage.getTask()
    if (this.generation !== startGeneration) {
      return this.getStateWithoutRetry()
    }
    if (!task)
      return this.setTransient(this.errorState(null, 'EXTENSION_ERROR'))

    const tab = await this.dependencies.getActiveTab()
    if (this.generation !== startGeneration) {
      return this.getStateWithoutRetry()
    }
    if (!tab || !Number.isInteger(tab.id) || !tab.url) {
      return this.setTransient(this.errorState(task, 'EXTENSION_ERROR'))
    }
    const origin = safeOrigin(tab.url)
    if (!origin) {
      return this.setTransient(this.originMismatchState(task))
    }

    const existing = await this.dependencies.storage.getSession()
    if (this.generation !== startGeneration) {
      return this.getStateWithoutRetry()
    }
    if (existing && taskMatchesSession(task, existing)) {
      const invalid = await this.ensureSessionValid(task, existing)
      if (invalid) return invalid
      if (this.generation !== startGeneration) {
        return this.getStateWithoutRetry()
      }
      if (existing.pendingSubmit) return this.retryPendingSubmit()
      if (existing.tabId === tab.id) {
        const currentOriginAllowed = existing.allowedOrigins.includes(origin)
        const sessionGeneration = this.advanceGeneration()
        if (!currentOriginAllowed) {
          existing.currentOrigin = origin
          existing.currentOriginAllowed = false
          existing.status = 'reauthorize'
          existing.error = 'ORIGIN_NOT_ALLOWED'
          await this.dependencies.storage.setSession(existing)
          if (this.generation !== sessionGeneration) {
            return this.getStateWithoutRetry()
          }
          await this.notify()
          return this.stateFromSession(existing)
        }
        existing.authorizedOrigin = origin
        existing.currentOrigin = origin
        existing.currentOriginAllowed = true
        existing.status = 'observing'
        existing.error = null
        await this.dependencies.storage.setSession(existing)
        if (this.generation !== sessionGeneration) {
          return this.getStateWithoutRetry()
        }
        const state = await this.injectStoredSession(
          existing,
          'terminal',
          sessionGeneration,
        )
        if (isZkTlsSession(existing) && existing.zkTlsQueue.length > 0) {
          void this.drainZkTlsQueue()
        }
        return state
      }

      const replacementGeneration = this.advanceGeneration()
      await this.dependencies.storage.clearProduct()
      if (this.generation !== replacementGeneration) {
        return this.getStateWithoutRetry()
      }
      await this.dependencies.storage.setTask(task)
      if (this.generation !== replacementGeneration) {
        return this.getStateWithoutRetry()
      }
    }

    const mintGeneration = this.generation
    this.beginAuthorization(tab.id, mintGeneration)
    try {
      let minted: ProductExperienceTicket
      try {
        minted =
          task.ticketKind === 'TEST'
            ? await this.dependencies.mintTest(task.campaignId)
            : await this.dependencies.mintParticipant(task.campaignId)
      } catch {
        if (this.generation !== mintGeneration) {
          return this.getStateWithoutRetry()
        }
        return this.setTransient(this.errorState(task, 'EXTENSION_ERROR'))
      }

      const currentTask = await this.dependencies.storage.getTask()
      if (
        this.generation !== mintGeneration ||
        !currentTask ||
        !sameTaskIdentity(currentTask, task)
      ) {
        return this.getStateWithoutRetry()
      }

      if (minted.ruleSetVersion !== currentTask.configVersion) {
        return this.finish(this.errorState(currentTask, 'VERSION_MISMATCH'))
      }
      if (isTicketExpired(minted, this.dependencies.now())) {
        return this.finish(this.expiredState(currentTask))
      }
      const allowedOrigins = normalizeAllowedOrigins(minted.allowedOrigins)
      if (!allowedOrigins || !this.validTicketShape(minted)) {
        return this.finish(this.errorState(currentTask, 'EXTENSION_ERROR'))
      }
      if (!allowedOrigins.includes(origin)) {
        return this.setTransient(this.originMismatchState(currentTask))
      }

      const session: ProductExperienceSession = {
        sessionId: this.dependencies.randomSessionId(),
        campaignId: currentTask.campaignId,
        title: currentTask.title,
        ticketKind: currentTask.ticketKind,
        configVersion: currentTask.configVersion,
        tabId: tab.id,
        authorizedOrigin: origin,
        currentOrigin: origin,
        currentOriginAllowed: true,
        verificationMode: minted.verificationMode,
        expiresAt: minted.expiresAt,
        ruleSetVersion: minted.ruleSetVersion,
        allowedOrigins,
        completionMode: 'ALL',
        rules: clone(minted.rules),
        matches: [],
        zkTlsQueue: [],
        verifiedRuleIds: [],
        status: 'observing',
        error: null,
        ...(minted.verificationMode === 'LEGACY_DOM'
          ? {
              ticket: minted.ticket,
              macKey: minted.macKey,
              pendingSubmit: null,
            }
          : {}),
      }
      const sessionGeneration = this.advanceGeneration()
      await this.dependencies.storage.setSession(session)
      if (this.generation !== sessionGeneration) {
        return this.getStateWithoutRetry()
      }
      this.lastState = null
      return this.injectStoredSession(session, 'terminal', sessionGeneration)
    } finally {
      this.endAuthorization(tab.id, mintGeneration)
    }
  }

  async bootstrap(
    sender: ProductExperienceRuntimeSender,
  ): Promise<ProductExperienceBootstrapResponse> {
    const bootstrapGeneration = this.generation
    const [task, session] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (this.generation !== bootstrapGeneration) {
      return { ok: false, error: 'NO_ACTIVE_SESSION' }
    }
    if (!task || !session) return { ok: false, error: 'NO_ACTIVE_SESSION' }
    const invalid = await this.ensureSessionValid(task, session)
    if (invalid) return { ok: false, error: 'NO_ACTIVE_SESSION' }
    if (this.generation !== bootstrapGeneration) {
      return { ok: false, error: 'NO_ACTIVE_SESSION' }
    }
    if (!this.senderMatches(sender, session)) {
      await this.markReauthorizeForSender(session, sender)
      return { ok: false, error: 'INVALID_SENDER' }
    }
    return {
      ok: true,
      sessionId: session.sessionId,
      ruleSetVersion: session.ruleSetVersion,
      allowedOrigins: clone(session.allowedOrigins),
      completionMode: 'ALL',
      evaluationMode:
        session.ticketKind === 'TEST' ? 'SELECTOR_ONLY' : 'STRICT',
      rules: clone(session.rules),
    }
  }

  async ready(
    sender: ProductExperienceRuntimeSender,
    sessionId: string,
  ): Promise<ProductExperienceControllerState> {
    const readyGeneration = this.generation
    const [task, session] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (this.generation !== readyGeneration) return this.getState()
    if (!task || !session || session.sessionId !== sessionId) {
      return this.getState()
    }
    const invalid = await this.ensureSessionValid(task, session)
    if (invalid) return invalid
    if (this.generation !== readyGeneration) return this.getState()
    if (!this.senderMatches(sender, session)) {
      await this.markReauthorizeForSender(session, sender)
      return this.getState()
    }
    if (
      (isLegacySession(session) &&
        session.matches.length === session.rules.length) ||
      (isZkTlsSession(session) &&
        session.verifiedRuleIds.length === session.rules.length)
    ) {
      return this.stateFromSession(session)
    }
    const sessionGeneration = this.advanceGeneration()
    session.status = 'observing'
    session.error = null
    await this.dependencies.storage.setSession(session)
    if (this.generation !== sessionGeneration) {
      return this.getStateWithoutRetry()
    }
    await this.notify()
    return this.stateFromSession(session)
  }

  async handleEvidence(
    sender: ProductExperienceRuntimeSender,
    sessionId: string,
    matches: readonly ProductRuleMatch[],
  ): Promise<ProductExperienceControllerState> {
    let resolveResult!: (state: ProductExperienceControllerState) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<ProductExperienceControllerState>(
      (resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
      },
    )
    this.evidenceQueue = this.evidenceQueue.then(async () => {
      try {
        resolveResult(await this.processEvidence(sender, sessionId, matches))
      } catch (error) {
        rejectResult(error)
      }
    })
    return result
  }

  async handleTabUpdated(
    tabId: number,
    change: ProductExperienceTabUpdate,
  ): Promise<ProductExperienceControllerState> {
    const updateGeneration = this.generation
    const [task, session] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (this.generation !== updateGeneration) {
      return this.getStateWithoutRetry()
    }
    if (!task || !session || session.tabId !== tabId) {
      return this.getStateWithoutRetry()
    }
    const invalid = await this.ensureSessionValid(task, session)
    if (invalid) return invalid
    if (this.generation !== updateGeneration) {
      return this.getStateWithoutRetry()
    }
    if (change.status !== 'complete') return this.stateFromSession(session)
    if (session.pendingSubmit) return this.stateFromSession(session)

    const hasVisibleUrl =
      typeof change.url === 'string' && change.url.length > 0
    const origin = hasVisibleUrl ? safeOrigin(change.url as string) : null
    if (
      !origin ||
      origin !== session.authorizedOrigin ||
      session.status === 'reauthorize'
    ) {
      const sessionGeneration = this.advanceGeneration()
      session.currentOrigin = origin ?? ''
      session.currentOriginAllowed = Boolean(
        origin && session.allowedOrigins.includes(origin),
      )
      session.status = 'reauthorize'
      session.error = session.currentOriginAllowed
        ? 'AUTHORIZATION_REQUIRED'
        : hasVisibleUrl
          ? 'ORIGIN_NOT_ALLOWED'
          : 'AUTHORIZATION_REQUIRED'
      await this.dependencies.storage.setSession(session)
      if (this.generation !== sessionGeneration) {
        return this.getStateWithoutRetry()
      }
      await this.notify()
      return this.stateFromSession(session)
    }

    return this.injectStoredSession(session, 'reauthorize', this.generation)
  }

  async handleTabRemoved(tabId: number): Promise<void> {
    const authorizing = this.hasCurrentAuthorization(tabId)
    if (authorizing) {
      const removalGeneration = this.advanceGeneration()
      await this.dependencies.storage.clearProduct()
      if (this.generation !== removalGeneration) return
      this.lastState = null
      await this.notify()
      return
    }

    const readGeneration = this.generation
    const session = await this.dependencies.storage.getSession()
    if (this.generation !== readGeneration) return
    if (!session || session.tabId !== tabId) return
    const removalGeneration = this.advanceGeneration()
    await this.dependencies.storage.clearProduct()
    if (this.generation !== removalGeneration) return
    this.lastState = null
    await this.notify()
  }

  async cancel(): Promise<ProductExperienceControllerState> {
    const cancelGeneration = this.advanceGeneration()
    await this.dependencies.storage.clearProduct()
    if (this.generation !== cancelGeneration) {
      return this.getStateWithoutRetry()
    }
    this.lastState = idleState()
    await this.notify()
    return idleState()
  }

  async resumePendingSubmit(): Promise<ProductExperienceControllerState> {
    const session = await this.dependencies.storage.getSession()
    if (!session) return this.getState()
    if (session.pendingSubmit) return this.retryPendingSubmit()
    if (!isZkTlsSession(session)) return this.getState()
    const resumed = await this.mutateZkTlsSession(
      session.sessionId,
      (current) => {
        for (const item of current.zkTlsQueue) {
          if (item.status !== 'proving') continue
          item.status = 'queued'
          item.sessionId = null
          item.connectorId = null
          item.expiresAt = null
        }
        current.status = current.zkTlsQueue.some(
          (item) => item.status === 'submitted',
        )
          ? 'submitting'
          : 'observing'
      },
    )
    if (!resumed) return this.getStateWithoutRetry()
    void this.drainZkTlsQueue()
    return this.stateFromSession(resumed)
  }

  private async processEvidence(
    sender: ProductExperienceRuntimeSender,
    sessionId: string,
    incomingMatches: readonly ProductRuleMatch[],
  ): Promise<ProductExperienceControllerState> {
    const messageGeneration = this.generation
    const [task, session] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (this.generation !== messageGeneration) return this.getState()
    if (!task || !session) return this.getState()
    const invalid = await this.ensureSessionValid(task, session)
    if (invalid) return invalid
    if (this.generation !== messageGeneration) return this.getState()
    if (session.sessionId !== sessionId) {
      return this.stateFromSession(session)
    }
    if (!this.senderMatches(sender, session)) {
      await this.markReauthorizeForSender(session, sender)
      const latest = await this.dependencies.storage.getSession()
      return latest ? this.stateFromSession(latest) : this.getState()
    }
    if (session.status === 'reauthorize') return this.stateFromSession(session)
    if (session.pendingSubmit) return this.retryPendingSubmit()

    const sanitized = this.validateEvidence(incomingMatches, session, sender)
    if (!sanitized) return this.stateFromSession(session)

    if (isZkTlsSession(session)) {
      const queued = await this.mutateZkTlsSession(
        session.sessionId,
        (current) => {
          const known = new Set([
            ...current.verifiedRuleIds,
            ...current.zkTlsQueue.map((item) => item.ruleId),
          ])
          for (const evidence of sanitized) {
            if (known.has(evidence.ruleId)) continue
            known.add(evidence.ruleId)
            current.zkTlsQueue.push({
              ruleId: evidence.ruleId,
              status: 'queued',
              sessionId: null,
              connectorId: null,
              expiresAt: null,
            })
          }
          current.error = null
        },
      )
      if (!queued) return this.getStateWithoutRetry()
      await this.notify()
      void this.drainZkTlsQueue()
      return this.stateFromSession(queued)
    }

    if (!isLegacySession(session)) {
      return this.finish(this.errorState(task, 'EXTENSION_ERROR'))
    }

    const byRuleId = new Map(
      session.matches.map((existing) => [existing.ruleId, existing]),
    )
    for (const evidence of sanitized) {
      if (!byRuleId.has(evidence.ruleId))
        byRuleId.set(evidence.ruleId, evidence)
    }
    session.matches = session.rules.flatMap((rule) => {
      const evidence = byRuleId.get(rule.id)
      return evidence ? [evidence] : []
    })
    const evidenceGeneration = this.advanceGeneration()
    await this.dependencies.storage.setSession(session)
    if (this.generation !== evidenceGeneration) {
      return this.getStateWithoutRetry()
    }
    await this.notify()
    if (this.generation !== evidenceGeneration) {
      return this.getStateWithoutRetry()
    }

    if (session.matches.length !== session.rules.length) {
      return this.stateFromSession(session)
    }

    const signingSession = await this.currentSessionForGeneration(
      session,
      evidenceGeneration,
    )
    if (!signingSession || !isLegacySession(signingSession)) {
      return this.getStateWithoutRetry()
    }

    const canonicalInput: ProductExperienceCanonicalInput = {
      version: 'product-experience-v1',
      campaignId: signingSession.campaignId,
      ruleSetVersion: signingSession.ruleSetVersion,
      nonce: this.dependencies.randomNonce(),
      ts: Math.floor(this.dependencies.now() / 1000),
      ruleMatches: clone(signingSession.matches),
    }
    let sig: string
    try {
      sig = await this.dependencies.sign(signingSession.macKey, canonicalInput)
    } catch {
      if (
        !(await this.currentSessionForGeneration(
          signingSession,
          evidenceGeneration,
        ))
      ) {
        return this.getStateWithoutRetry()
      }
      return this.finish(this.errorState(task, 'VERIFICATION_FAILED'))
    }
    const currentSession = await this.currentSessionForGeneration(
      signingSession,
      evidenceGeneration,
    )
    if (!currentSession || !isLegacySession(currentSession)) {
      return this.getStateWithoutRetry()
    }

    currentSession.pendingSubmit = {
      input: {
        ...canonicalInput,
        ticket: currentSession.ticket,
        sig,
      },
    }
    currentSession.status = 'submitting'
    const pendingGeneration = this.advanceGeneration()
    await this.dependencies.storage.setSession(currentSession)
    if (this.generation !== pendingGeneration) {
      return this.getStateWithoutRetry()
    }
    await this.notify()
    if (this.generation !== pendingGeneration) {
      return this.getStateWithoutRetry()
    }
    return this.retryPendingSubmit()
  }

  private async mutateZkTlsSession(
    sessionId: string,
    mutate: (
      session: ProductExperienceSession & { verificationMode: 'ZKTLS' },
    ) => void,
  ): Promise<
    (ProductExperienceSession & { verificationMode: 'ZKTLS' }) | null
  > {
    let result:
      | (ProductExperienceSession & { verificationMode: 'ZKTLS' })
      | null = null
    const operation = this.zkTlsMutationQueue.then(async () => {
      const [task, stored] = await Promise.all([
        this.dependencies.storage.getTask(),
        this.dependencies.storage.getSession(),
      ])
      if (
        !task ||
        !isZkTlsSession(stored) ||
        stored.sessionId !== sessionId ||
        !taskMatchesSession(task, stored)
      ) {
        return
      }
      const next = clone(stored)
      mutate(next)
      await this.dependencies.storage.setSession(next)
      result = next
    })
    this.zkTlsMutationQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    await operation
    return result
  }

  private drainZkTlsQueue(): Promise<void> {
    if (this.zkTlsFlight) {
      this.zkTlsDrainRequested = true
      return this.zkTlsFlight
    }
    const flight = this.runZkTlsQueue().finally(() => {
      if (this.zkTlsFlight !== flight) return
      this.zkTlsFlight = null
      if (this.zkTlsDrainRequested) {
        this.zkTlsDrainRequested = false
        void this.drainZkTlsQueue()
      }
    })
    this.zkTlsFlight = flight
    return flight
  }

  private async runZkTlsQueue(): Promise<void> {
    while (true) {
      const session = await this.dependencies.storage.getSession()
      if (!isZkTlsSession(session)) return
      const item =
        session.zkTlsQueue.find((entry) => entry.status === 'submitted') ??
        session.zkTlsQueue.find((entry) => entry.status !== 'submitted')
      if (!item) return

      if (item.status === 'submitted') {
        if (!(await this.pollZkTlsProgress(session.sessionId, item.ruleId))) {
          return
        }
        continue
      }

      if (item.status === 'proving') {
        const reset = await this.mutateZkTlsSession(
          session.sessionId,
          (current) => {
            const interrupted = current.zkTlsQueue.find(
              (entry) => entry.ruleId === item.ruleId,
            )
            if (!interrupted || interrupted.status !== 'proving') return
            interrupted.status = 'queued'
            interrupted.sessionId = null
            interrupted.connectorId = null
            interrupted.expiresAt = null
          },
        )
        if (!reset) return
      }

      let started: ProductZkTlsSession
      try {
        started = await this.dependencies.startZkTls({
          campaignId: session.campaignId,
          ruleId: item.ruleId,
          ticketKind: session.ticketKind,
        })
      } catch {
        await this.resetZkTlsItem(session.sessionId, item.ruleId)
        return
      }

      const proving = await this.mutateZkTlsSession(
        session.sessionId,
        (current) => {
          const queued = current.zkTlsQueue.find(
            (entry) => entry.ruleId === item.ruleId,
          )
          if (!queued || queued.status !== 'queued') return
          queued.status = 'proving'
          queued.sessionId = started.sessionId
          queued.connectorId = started.connectorId
          queued.expiresAt = started.expiresAt
          current.status = 'submitting'
          current.error = null
        },
      )
      const provingItem = proving?.zkTlsQueue.find(
        (entry) => entry.ruleId === item.ruleId,
      )
      if (!provingItem || provingItem.status !== 'proving') return

      let result: ZkTlsRunResult
      try {
        result = await this.dependencies.proveZkTls({
          sessionId: started.sessionId,
          connectorId: started.connectorId,
          correlationId: this.dependencies.randomSessionId(),
        })
      } catch {
        await this.resetZkTlsItem(session.sessionId, item.ruleId)
        return
      }

      if (result.status !== 'submitted') {
        await this.resetZkTlsItem(
          session.sessionId,
          item.ruleId,
          result.status === 'pending_login' ||
            result.code === 'PERMISSION_DENIED'
            ? 'AUTHORIZATION_REQUIRED'
            : 'VERIFICATION_FAILED',
        )
        return
      }

      const submitted = await this.mutateZkTlsSession(
        session.sessionId,
        (current) => {
          const provingEntry = current.zkTlsQueue.find(
            (entry) => entry.ruleId === item.ruleId,
          )
          if (
            !provingEntry ||
            provingEntry.status !== 'proving' ||
            provingEntry.sessionId !== started.sessionId
          ) {
            return
          }
          provingEntry.status = 'submitted'
          current.status = 'submitting'
          current.error = null
        },
      )
      if (!submitted) return
    }
  }

  private async resetZkTlsItem(
    sessionId: string,
    ruleId: string,
    error: ProductExperiencePublicError = 'VERIFICATION_FAILED',
  ): Promise<void> {
    const reset = await this.mutateZkTlsSession(sessionId, (current) => {
      const item = current.zkTlsQueue.find((entry) => entry.ruleId === ruleId)
      if (!item) return
      item.status = 'queued'
      item.sessionId = null
      item.connectorId = null
      item.expiresAt = null
      current.status = 'observing'
      current.error = error
    })
    if (reset) await this.notify()
  }

  private async pollZkTlsProgress(
    sessionId: string,
    activeRuleId: string,
  ): Promise<boolean> {
    for (const delayMs of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await wait(delayMs)
      const beforePoll = await this.dependencies.storage.getSession()
      if (!isZkTlsSession(beforePoll) || beforePoll.sessionId !== sessionId) {
        return false
      }
      const active = beforePoll.zkTlsQueue.find(
        (item) => item.ruleId === activeRuleId,
      )
      if (!active || active.status !== 'submitted') return true
      if (
        !active.expiresAt ||
        Date.parse(active.expiresAt) <= this.dependencies.now()
      ) {
        await this.resetZkTlsItem(sessionId, activeRuleId, 'SESSION_EXPIRED')
        return false
      }

      let progress: ProductZkTlsRuleProgress[]
      try {
        progress = await this.dependencies.readZkTlsProgress(
          beforePoll.campaignId,
        )
      } catch {
        continue
      }
      const verified = new Set(
        progress
          .filter((entry) => entry.status === 'VERIFIED')
          .map((entry) => entry.ruleId),
      )
      const updated = await this.mutateZkTlsSession(sessionId, (current) => {
        const durableVerified = new Set([
          ...current.verifiedRuleIds,
          ...verified,
        ])
        current.verifiedRuleIds = current.rules
          .map((rule) => rule.id)
          .filter((ruleId) => durableVerified.has(ruleId))
        current.zkTlsQueue = current.zkTlsQueue.filter(
          (item) => !durableVerified.has(item.ruleId),
        )
      })
      if (!updated) return false
      if (updated.verifiedRuleIds.length === updated.rules.length) {
        await this.finish({
          campaignId: updated.campaignId,
          title: updated.title,
          status: 'verified',
          matchedRuleIds: clone(updated.verifiedRuleIds),
          totalRuleCount: updated.rules.length,
          authorizationRequired: false,
          currentOriginAllowed: true,
          error: null,
        })
        return false
      }
      if (updated.verifiedRuleIds.includes(activeRuleId)) return true
    }
    return false
  }

  private async retryPendingSubmit(): Promise<ProductExperienceControllerState> {
    const session = await this.dependencies.storage.getSession()
    const key = pendingSubmissionKey(session)
    if (!key) return this.getStateWithoutRetry()

    const activeFlight = this.submitInFlight
    if (activeFlight) {
      // A flight owns the drain step: after its own input settles it checks
      // storage and submits a different durable key exactly once.
      return activeFlight.promise
    }

    const flight = {} as ProductExperienceSubmitFlight
    flight.key = key
    flight.promise = this.runSubmissionFlight(flight)
    this.submitInFlight = flight
    return flight.promise
  }

  private async runSubmissionFlight(
    flight: ProductExperienceSubmitFlight,
  ): Promise<ProductExperienceControllerState> {
    let result: ProductExperienceControllerState
    try {
      result = await this.performPendingSubmit(flight.key)
    } finally {
      if (this.submitInFlight === flight) this.submitInFlight = null
    }

    const latestSession = await this.dependencies.storage.getSession()
    const latestKey = pendingSubmissionKey(latestSession)
    if (latestKey && latestKey !== flight.key) {
      return this.retryPendingSubmit()
    }
    return result
  }

  private async performPendingSubmit(
    expectedKey: string,
  ): Promise<ProductExperienceControllerState> {
    const submitGeneration = this.generation
    const [task, session] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (this.generation !== submitGeneration) {
      return this.getStateWithoutRetry()
    }
    if (!task || !session?.pendingSubmit || !isLegacySession(session)) {
      return this.getStateWithoutRetry()
    }
    if (pendingSubmissionKey(session) !== expectedKey) {
      return this.getStateWithoutRetry()
    }
    // An uncertain request may already have committed on the server. Preserve
    // the exact signed input and retry it even when the local ticket expires;
    // the backend durable receipt is authoritative for an identical replay.
    if (
      !taskMatchesSession(task, session) ||
      session.ruleSetVersion !== task.configVersion
    ) {
      return this.finish(this.errorState(task, 'VERSION_MISMATCH'))
    }

    const durableInput = clone(session.pendingSubmit)
    try {
      const result = await this.dependencies.submit(durableInput)
      if (this.generation !== submitGeneration) {
        return this.getStateWithoutRetry()
      }
      const currentSession = await this.currentPendingSession(
        session,
        durableInput,
      )
      if (this.generation !== submitGeneration || !currentSession) {
        return this.getStateWithoutRetry()
      }
      const proof = result.submitProductExperienceProof
      if (
        !proof.accepted ||
        proof.campaignId !== session.campaignId ||
        proof.configVersion !== session.ruleSetVersion ||
        proof.verificationKind !== 'EXPERIENCE'
      ) {
        return this.finish(this.errorState(task, 'VERIFICATION_FAILED'))
      }
      return this.finish({
        campaignId: task.campaignId,
        title: task.title,
        status: 'verified',
        matchedRuleIds: session.matches.map((match) => match.ruleId),
        totalRuleCount: session.rules.length,
        authorizationRequired: false,
        currentOriginAllowed: true,
        error: null,
      })
    } catch (error) {
      if (this.generation !== submitGeneration) {
        return this.getStateWithoutRetry()
      }
      const latest = await this.currentPendingSession(session, durableInput)
      if (this.generation !== submitGeneration) {
        return this.getStateWithoutRetry()
      }
      if (!latest) return this.getStateWithoutRetry()
      if (isUncertainTransportError(error)) {
        const pendingGeneration = this.advanceGeneration()
        latest.pendingSubmit = durableInput
        latest.status = 'submitting'
        await this.dependencies.storage.setSession(latest)
        if (this.generation !== pendingGeneration) {
          return this.getStateWithoutRetry()
        }
        await this.notify()
        return this.generation === pendingGeneration
          ? this.stateFromSession(latest)
          : this.getStateWithoutRetry()
      }
      return this.finish(this.errorState(task, 'VERIFICATION_FAILED'))
    }
  }

  private async currentPendingSession(
    submittedSession: ProductExperienceSession,
    durableInput: SubmitProductExperienceProofVariables,
  ): Promise<ProductExperienceSession | null> {
    const [task, currentSession] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (
      !task ||
      !currentSession ||
      currentSession.sessionId !== submittedSession.sessionId ||
      currentSession.campaignId !== submittedSession.campaignId ||
      currentSession.configVersion !== submittedSession.configVersion ||
      currentSession.ruleSetVersion !== submittedSession.ruleSetVersion ||
      currentSession.ticket !== submittedSession.ticket ||
      !taskMatchesSession(task, currentSession) ||
      JSON.stringify(currentSession.pendingSubmit) !==
        JSON.stringify(durableInput)
    ) {
      return null
    }
    return currentSession
  }

  private async currentSessionForGeneration(
    expectedSession: ProductExperienceSession,
    expectedGeneration: number,
  ): Promise<ProductExperienceSession | null> {
    if (this.generation !== expectedGeneration) return null
    const [task, currentSession] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (
      this.generation !== expectedGeneration ||
      !task ||
      !currentSession ||
      currentSession.sessionId !== expectedSession.sessionId ||
      currentSession.campaignId !== expectedSession.campaignId ||
      currentSession.configVersion !== expectedSession.configVersion ||
      currentSession.ruleSetVersion !== expectedSession.ruleSetVersion ||
      currentSession.ticket !== expectedSession.ticket ||
      !taskMatchesSession(task, currentSession)
    ) {
      return null
    }
    return currentSession
  }

  private async getStateWithoutRetry(): Promise<ProductExperienceControllerState> {
    const [task, session] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (task && session) return this.stateFromSession(session)
    if (this.lastState) return clone(this.lastState)
    return task ? this.readyState(task) : idleState()
  }

  private validateEvidence(
    matches: readonly ProductRuleMatch[],
    session: ProductExperienceSession,
    sender: ProductExperienceRuntimeSender,
  ): ProductRuleMatch[] | null {
    if (!Array.isArray(matches) || matches.length > session.rules.length) {
      return null
    }
    const allowedRuleIds = new Set(session.rules.map((rule) => rule.id))
    const seen = new Set<string>()
    const sanitized: ProductRuleMatch[] = []
    for (const value of matches) {
      if (
        !value ||
        typeof value.ruleId !== 'string' ||
        !allowedRuleIds.has(value.ruleId) ||
        seen.has(value.ruleId) ||
        typeof value.matchedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.matchedAt)) ||
        typeof value.origin !== 'string' ||
        value.origin !== sender.origin ||
        !session.allowedOrigins.includes(value.origin) ||
        typeof value.urlPathHash !== 'string' ||
        !PATH_HASH_PATTERN.test(value.urlPathHash)
      ) {
        return null
      }
      seen.add(value.ruleId)
      sanitized.push({
        ruleId: value.ruleId,
        matchedAt: new Date(value.matchedAt).toISOString(),
        origin: value.origin,
        urlPathHash: value.urlPathHash,
      })
    }
    return sanitized
  }

  private senderMatches(
    sender: ProductExperienceRuntimeSender,
    session: ProductExperienceSession,
  ): boolean {
    return (
      sender.extensionId === this.dependencies.runtimeId() &&
      sender.tabId === session.tabId &&
      sender.frameId === 0 &&
      sender.origin === session.authorizedOrigin &&
      session.currentOrigin === session.authorizedOrigin &&
      session.currentOriginAllowed
    )
  }

  private async markReauthorizeForSender(
    session: ProductExperienceSession,
    sender: ProductExperienceRuntimeSender,
  ): Promise<void> {
    if (
      sender.extensionId !== this.dependencies.runtimeId() ||
      sender.tabId !== session.tabId ||
      sender.frameId !== 0
    ) {
      return
    }
    const origin = sender.origin ? safeOrigin(sender.origin) : null
    if (!origin || origin === session.authorizedOrigin) return
    session.currentOrigin = origin
    session.currentOriginAllowed = session.allowedOrigins.includes(origin)
    session.status = 'reauthorize'
    session.error = session.currentOriginAllowed
      ? 'AUTHORIZATION_REQUIRED'
      : 'ORIGIN_NOT_ALLOWED'
    const sessionGeneration = this.advanceGeneration()
    await this.dependencies.storage.setSession(session)
    if (this.generation !== sessionGeneration) return
    await this.notify()
  }

  private async ensureSessionValid(
    task: ProductExperienceTaskRef,
    session: ProductExperienceSession,
  ): Promise<ProductExperienceControllerState | null> {
    if (
      !taskMatchesSession(task, session) ||
      session.ruleSetVersion !== task.configVersion
    ) {
      return this.finish(this.errorState(task, 'VERSION_MISMATCH'))
    }
    // Once a signed request is durable, an identical replay may resolve an
    // already-committed backend receipt even after the local ticket expires.
    if (
      !session.pendingSubmit &&
      !session.zkTlsQueue.some((item) => item.status === 'submitted') &&
      isExpired(session, this.dependencies.now())
    ) {
      return this.finish(this.expiredState(task))
    }
    return null
  }

  private validTicketShape(ticket: ProductExperienceTicket): boolean {
    return (
      ticket.completionMode === 'ALL' &&
      typeof ticket.ticket === 'string' &&
      ticket.ticket.length > 0 &&
      typeof ticket.macKey === 'string' &&
      ticket.macKey.length > 0 &&
      Array.isArray(ticket.rules) &&
      ticket.rules.length > 0 &&
      new Set(ticket.rules.map((rule) => rule.id)).size === ticket.rules.length
    )
  }

  private async injectStoredSession(
    session: ProductExperienceSession,
    failureMode: 'reauthorize' | 'terminal' = 'terminal',
    expectedGeneration = this.generation,
  ): Promise<ProductExperienceControllerState> {
    if (this.generation !== expectedGeneration) {
      return this.getStateWithoutRetry()
    }
    try {
      await this.dependencies.inject(session.tabId)
      if (this.generation !== expectedGeneration) {
        return this.getStateWithoutRetry()
      }
      await this.notify()
      return this.generation === expectedGeneration
        ? this.stateFromSession(session)
        : this.getStateWithoutRetry()
    } catch {
      if (this.generation !== expectedGeneration) {
        return this.getStateWithoutRetry()
      }
      if (failureMode === 'reauthorize') {
        const sessionGeneration = this.advanceGeneration()
        session.status = 'reauthorize'
        session.error = 'AUTHORIZATION_REQUIRED'
        await this.dependencies.storage.setSession(session)
        if (this.generation !== sessionGeneration) {
          return this.getStateWithoutRetry()
        }
        await this.notify()
        return this.stateFromSession(session)
      }
      const task = await this.dependencies.storage.getTask()
      if (this.generation !== expectedGeneration) {
        return this.getStateWithoutRetry()
      }
      return this.finish(this.errorState(task, 'EXTENSION_ERROR'))
    }
  }

  private stateFromSession(
    session: ProductExperienceSession,
  ): ProductExperienceControllerState {
    return {
      campaignId: session.campaignId,
      title: session.title,
      status: session.status,
      matchedRuleIds: isZkTlsSession(session)
        ? clone(session.verifiedRuleIds)
        : session.matches.map((match) => match.ruleId),
      totalRuleCount: session.rules.length,
      authorizationRequired:
        session.status === 'reauthorize' ||
        session.error === 'AUTHORIZATION_REQUIRED',
      currentOriginAllowed: session.currentOriginAllowed,
      error: session.error,
    }
  }

  private readyState(
    task: ProductExperienceTaskRef,
  ): ProductExperienceControllerState {
    return {
      campaignId: task.campaignId,
      title: task.title,
      status: 'ready',
      matchedRuleIds: [],
      totalRuleCount: 0,
      authorizationRequired: true,
      currentOriginAllowed: false,
      error: null,
    }
  }

  private errorState(
    task: ProductExperienceTaskRef | null,
    error: ProductExperiencePublicError,
  ): ProductExperienceControllerState {
    return {
      campaignId: task?.campaignId ?? null,
      title: task?.title ?? null,
      status: 'error',
      matchedRuleIds: [],
      totalRuleCount: 0,
      authorizationRequired: false,
      currentOriginAllowed: false,
      error,
    }
  }

  private expiredState(
    task: ProductExperienceTaskRef,
  ): ProductExperienceControllerState {
    return {
      campaignId: task.campaignId,
      title: task.title,
      status: 'expired',
      matchedRuleIds: [],
      totalRuleCount: 0,
      authorizationRequired: true,
      currentOriginAllowed: false,
      error: 'SESSION_EXPIRED',
    }
  }

  private originMismatchState(
    task: ProductExperienceTaskRef,
  ): ProductExperienceControllerState {
    return {
      campaignId: task.campaignId,
      title: task.title,
      status: 'origin-mismatch',
      matchedRuleIds: [],
      totalRuleCount: 0,
      authorizationRequired: true,
      currentOriginAllowed: false,
      error: 'ORIGIN_NOT_ALLOWED',
    }
  }

  private async setTransient(
    state: ProductExperienceControllerState,
  ): Promise<ProductExperienceControllerState> {
    this.lastState = clone(state)
    await this.notify()
    return state
  }

  private async finish(
    state: ProductExperienceControllerState,
  ): Promise<ProductExperienceControllerState> {
    const finishGeneration = this.advanceGeneration()
    await this.dependencies.storage.clearProduct()
    if (this.generation !== finishGeneration) {
      return this.getStateWithoutRetry()
    }
    this.lastState = clone(state)
    await this.notify()
    return state
  }

  private async notify(): Promise<void> {
    try {
      await this.dependencies.notifyStateChanged()
    } catch {
      // Popup or page listeners are often absent; state durability is primary.
    }
  }

  private advanceGeneration(): number {
    this.generation += 1
    return this.generation
  }

  private beginAuthorization(tabId: number, generation: number): void {
    const authorizations =
      this.pendingAuthorizations.get(tabId) ?? new Map<number, number>()
    authorizations.set(generation, (authorizations.get(generation) ?? 0) + 1)
    this.pendingAuthorizations.set(tabId, authorizations)
  }

  private endAuthorization(tabId: number, generation: number): void {
    const authorizations = this.pendingAuthorizations.get(tabId)
    if (!authorizations) return
    const count = authorizations.get(generation) ?? 0
    if (count <= 1) authorizations.delete(generation)
    else authorizations.set(generation, count - 1)
    if (authorizations.size === 0) this.pendingAuthorizations.delete(tabId)
  }

  private hasCurrentAuthorization(tabId: number): boolean {
    return (
      (this.pendingAuthorizations.get(tabId)?.get(this.generation) ?? 0) > 0
    )
  }
}
