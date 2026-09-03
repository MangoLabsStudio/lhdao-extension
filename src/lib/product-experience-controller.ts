import type {
  ProductExperienceRule,
  ProductExperienceTaskRef,
  ProductExperienceTicket,
  ProductIntegrationCheck,
  ProductRuleMatch,
  ProductTicketKind,
  ProductZkTlsDiagnostic,
  ProductZkTlsDiagnosticEvent,
  ProductZkTlsRuleProgress,
  ProductZkTlsScalar,
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
import {
  appendProductZkTlsDiagnostic,
  createProductZkTlsDiagnostic,
} from './zktls/debug'
import type { ZkTlsRunRequest, ZkTlsRunResult } from './zktls/runtime'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const PATH_HASH_PATTERN = /^[a-f0-9]{64}$/

export type ProductZkTlsFailureCode =
  | 'INSUFFICIENT_DATA'
  | 'PARTIAL'
  | 'NO_REQUEST_OBSERVED'
  | 'NO_NEAR_MATCH'
  | 'REQUEST_TEMPLATE_MISMATCH'
  | 'AMBIGUOUS_REQUEST'
  | 'PROVER_BUSY'
  | 'PROVER_FAILED'
  | 'PROVER_TIMEOUT'
  | 'REQUEST_NOT_CAPTURED'
  | 'UNSUPPORTED_CONNECTOR'
  | 'ZKTLS_BUSY'
  | 'ZKTLS_CAPTURE_FAILED'
  | 'ZKTLS_SETUP_FAILED'
  | 'ZKTLS_UNKNOWN_FAILURE'

const PRODUCT_ZKTLS_FAILURE_CODES = new Set<ProductZkTlsFailureCode>([
  'NO_REQUEST_OBSERVED',
  'NO_NEAR_MATCH',
  'REQUEST_TEMPLATE_MISMATCH',
  'AMBIGUOUS_REQUEST',
  'PROVER_BUSY',
  'PROVER_FAILED',
  'PROVER_TIMEOUT',
  'REQUEST_NOT_CAPTURED',
  'UNSUPPORTED_CONNECTOR',
  'ZKTLS_BUSY',
  'ZKTLS_CAPTURE_FAILED',
  'ZKTLS_SETUP_FAILED',
])

function safeZkTlsFailureCode(
  code: string | undefined,
): ProductZkTlsFailureCode {
  return code &&
    PRODUCT_ZKTLS_FAILURE_CODES.has(code as ProductZkTlsFailureCode)
    ? (code as ProductZkTlsFailureCode)
    : 'ZKTLS_UNKNOWN_FAILURE'
}

function safeDiagnosticDifferences(
  value: unknown,
): Array<{ category: string; pointer: string }> {
  if (
    !value ||
    typeof value !== 'object' ||
    !('differences' in value) ||
    !Array.isArray(value.differences)
  )
    return []
  const categories = new Set([
    'METHOD',
    'PATH',
    'SHAPE',
    'MISSING_FIELD',
    'EXTRA_FIELD',
    'VALUE_OR_TYPE',
    'DUPLICATE_FIELD',
    'BODY_UNREADABLE',
    'DUPLICATE_HEADER',
    'MISSING_HEADER',
    'HEADER_VALUE',
    'CONTENT_TYPE',
  ])
  return value.differences.slice(0, 32).flatMap((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !categories.has(item.category) ||
      typeof item.pointer !== 'string' ||
      item.pointer.length > 512 ||
      !/^\/(?:[A-Za-z0-9_*/~-]+)$/.test(item.pointer)
    )
      return []
    return [{ category: item.category, pointer: item.pointer }]
  })
}

export interface ProductExperienceControllerState {
  campaignId: string | null
  title: string | null
  status: ProductExperiencePublicStatus
  matchedRuleIds: string[]
  totalRuleCount: number
  authorizationRequired: boolean
  currentOriginAllowed: boolean
  error: ProductExperiencePublicError | null
  zkTlsFailureCode?: ProductZkTlsFailureCode | null
  zkTlsProgress?: ProductZkTlsRuleProgress[]
  zkTlsDiagnostic?: ProductZkTlsDiagnostic
  zkTlsFinished?: boolean
  zkTlsTestPassed?: boolean
  zkTlsConditions?: ProductZkTlsCondition[]
}

export interface ProductZkTlsCondition {
  ruleId: string
  title?: string
  status:
    | 'pending'
    | 'queued'
    | 'proving'
    | 'submitted'
    | 'failed'
    | 'action_required'
    | 'verified'
    | 'verified_no'
  code: ProductZkTlsFailureCode | null
  stage: string | null
  correlationId: string | null
  details?: Array<{ category: string; pointer: string }>
  actual?: ProductZkTlsScalar
  required?: ProductZkTlsScalar
  comparator?: string | null
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
  status: 'queued' | 'paused' | 'proving' | 'submitted' | 'completed'
  sessionId: string | null
  connectorId: string | null
  expiresAt: string | null
  dependentRuleIds?: string[]
  binding?: boolean
  failureCode?: ProductZkTlsFailureCode | null
  actionRequired?: boolean
  stage?: string
  correlationId?: string
  details?: Array<{ category: string; pointer: string }>
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
  plannedExecution?: boolean
  zkTlsTestPassed?: boolean
  verifiedRuleIds: string[]
  zkTlsProgress: ProductZkTlsRuleProgress[]
  zkTlsDiagnostic?: ProductZkTlsDiagnostic
  status: 'observing' | 'reauthorize' | 'submitting'
  error: ProductExperiencePublicError | null
  zkTlsFailureCode?: ProductZkTlsFailureCode | null
}

export interface ProductExperienceControllerStorage {
  getTask(): Promise<ProductExperienceTaskRef | null>
  setTask(task: ProductExperienceTaskRef): Promise<void>
  getSession(): Promise<ProductExperienceSession | null>
  setSession(session: ProductExperienceSession): Promise<void>
  clearProduct(): Promise<void>
}

export interface ProductExperienceControllerDependencies {
  diagnosticsEnabled: boolean
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
  readIntegration?(campaignId: string): Promise<ProductIntegrationCheck>
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

interface ProductExperienceZkTlsFlight {
  sessionId: string
  drainRequested: boolean
  promise: Promise<void>
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

function reusableZkTlsSession(
  item: ProductZkTlsQueueItem,
  now: number,
): ProductZkTlsSession | null {
  if (!item.sessionId || !item.connectorId || !item.expiresAt) return null
  const expiresAt = Date.parse(item.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  return {
    sessionId: item.sessionId,
    connectorId: item.connectorId,
    expiresAt: item.expiresAt,
  }
}

function terminalRuleIds(session: ProductExperienceSession): Set<string> {
  return new Set([
    ...session.verifiedRuleIds,
    ...session.zkTlsProgress
      .filter(
        (item) => item.status === 'VERIFIED' || item.status === 'VERIFIED_NO',
      )
      .map((item) => item.ruleId),
  ])
}

function allZkTlsConditionsFinished(
  session: ProductExperienceSession,
): boolean {
  if (session.ticketKind === 'TEST' && session.zkTlsTestPassed) return true
  const terminal = terminalRuleIds(session)
  return (
    session.rules.length > 0 &&
    session.rules.every((rule) => terminal.has(rule.id))
  )
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
    ...(state.zkTlsConditions
      ? {
          conditions: state.zkTlsConditions,
          finished: state.zkTlsFinished === true,
          testPassed: state.zkTlsTestPassed === true,
        }
      : {}),
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
  private zkTlsFlight: ProductExperienceZkTlsFlight | null = null
  private readonly exhaustedZkTlsPolls = new Set<string>()
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

  private beginZkTlsDiagnostic(session: ProductExperienceSession): void {
    if (!this.dependencies.diagnosticsEnabled || !isZkTlsSession(session))
      return
    const now = this.dependencies.now()
    session.zkTlsDiagnostic = appendProductZkTlsDiagnostic(
      createProductZkTlsDiagnostic(this.dependencies.randomSessionId(), now),
      {
        at: now,
        stage: 'start-request-received',
        status: 'passed',
      },
    )
  }

  private appendZkTlsDiagnostic(
    session: ProductExperienceSession,
    event: ProductZkTlsDiagnosticEvent,
  ): void {
    if (!this.dependencies.diagnosticsEnabled || !session.zkTlsDiagnostic)
      return
    session.zkTlsDiagnostic = appendProductZkTlsDiagnostic(
      session.zkTlsDiagnostic,
      event,
    )
  }

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

  async start(
    options: { executePlan?: boolean } = {},
  ): Promise<ProductExperienceControllerState> {
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
      if (isZkTlsSession(existing) && allZkTlsConditionsFinished(existing))
        return this.stateFromSession(existing)
      if (isZkTlsSession(existing) && existing.plannedExecution) {
        await this.mutateZkTlsSession(existing.sessionId, (current) => {
          current.status = 'observing'
          current.error = null
          current.zkTlsFailureCode = null
        })
        void this.drainZkTlsQueueAfterCurrentFlight(existing.sessionId)
        return this.getStateWithoutRetry()
      }
      if (existing.tabId === tab.id) {
        const currentOriginAllowed = existing.allowedOrigins.includes(origin)
        const awaitingBackend =
          isZkTlsSession(existing) &&
          existing.zkTlsQueue.some((item) => item.status === 'submitted')
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
        existing.status = awaitingBackend ? 'submitting' : 'observing'
        const hasPausedFailure =
          isZkTlsSession(existing) &&
          existing.zkTlsQueue.some((item) => item.status === 'paused') &&
          existing.zkTlsFailureCode !== null
        existing.error = hasPausedFailure ? 'VERIFICATION_FAILED' : null
        if (!hasPausedFailure) existing.zkTlsFailureCode = null
        if (!awaitingBackend) this.beginZkTlsDiagnostic(existing)
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
          if (awaitingBackend) void this.drainZkTlsQueue(existing.sessionId)
          else void this.drainZkTlsQueueAfterCurrentFlight(existing.sessionId)
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
      let prepared: ProductZkTlsSession | null = null
      if (
        (options.executePlan || !allowedOrigins.includes(origin)) &&
        minted.verificationMode === 'ZKTLS'
      ) {
        try {
          prepared = await this.dependencies.startZkTls({
            campaignId: currentTask.campaignId,
            ruleId: minted.rules[0].id,
            ticketKind: currentTask.ticketKind,
          })
        } catch {
          return this.setTransient(
            this.errorState(currentTask, 'VERIFICATION_FAILED'),
          )
        }
        if (this.generation !== mintGeneration)
          return this.getStateWithoutRetry()
        if (!prepared.executionPlan) prepared = null
      }
      if (!allowedOrigins.includes(origin) && !prepared) {
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
        currentOriginAllowed: allowedOrigins.includes(origin),
        verificationMode: minted.verificationMode,
        expiresAt: minted.expiresAt,
        ruleSetVersion: minted.ruleSetVersion,
        allowedOrigins,
        completionMode: 'ALL',
        rules: clone(minted.rules),
        matches: [],
        zkTlsQueue: [],
        verifiedRuleIds: [],
        zkTlsProgress: [],
        status: 'observing',
        error: null,
        zkTlsFailureCode: null,
        ...(minted.verificationMode === 'LEGACY_DOM'
          ? {
              ticket: minted.ticket,
              macKey: minted.macKey,
              pendingSubmit: null,
            }
          : {}),
      }
      if (prepared?.executionPlan) {
        session.plannedExecution = true
        if (prepared.executionPlan.steps.length === 0) {
          try {
            session.zkTlsProgress = await this.dependencies.readZkTlsProgress(
              currentTask.campaignId,
            )
            session.verifiedRuleIds = session.rules
              .filter((rule) =>
                session.zkTlsProgress.some(
                  (entry) =>
                    entry.ruleId === rule.id && entry.status === 'VERIFIED',
                ),
              )
              .map((rule) => rule.id)
            if (
              currentTask.ticketKind === 'TEST' &&
              this.dependencies.readIntegration
            ) {
              const check = await this.dependencies.readIntegration(
                currentTask.campaignId,
              )
              session.zkTlsTestPassed =
                check.configVersion === session.configVersion &&
                check.experiencePassed
            }
          } catch {
            session.error = 'VERIFICATION_FAILED'
          }
          if (this.generation !== mintGeneration)
            return this.getStateWithoutRetry()
        } else {
          const step = prepared.executionPlan.steps.find(
            (item) => item.connectorId === prepared.connectorId,
          )
          if (
            !step?.dependentRuleIds.includes(minted.rules[0].id) ||
            step.dependentRuleIds.some(
              (id) => !minted.rules.some((rule) => rule.id === id),
            )
          )
            return this.setTransient(
              this.errorState(currentTask, 'EXTENSION_ERROR'),
            )
          session.zkTlsQueue = [
            {
              ruleId: minted.rules[0].id,
              status: 'queued',
              sessionId: prepared.sessionId,
              connectorId: prepared.connectorId,
              expiresAt: prepared.expiresAt,
              dependentRuleIds: step.dependentRuleIds,
              binding: step.dependentFactIds.length === 0,
            },
          ]
          for (const next of prepared.executionPlan.steps) {
            if (
              next.connectorId === prepared.connectorId ||
              next.dependentFactIds.length === 0
            )
              continue
            const ruleId = next.dependentRuleIds.find((id) =>
              minted.rules.some((rule) => rule.id === id),
            )
            if (ruleId && !step.dependentRuleIds.includes(ruleId))
              session.zkTlsQueue.push({
                ruleId,
                status: 'queued',
                sessionId: null,
                connectorId: null,
                expiresAt: null,
              })
          }
        }
      }
      this.beginZkTlsDiagnostic(session)
      const sessionGeneration = this.advanceGeneration()
      await this.dependencies.storage.setSession(session)
      if (this.generation !== sessionGeneration) {
        return this.getStateWithoutRetry()
      }
      this.lastState = null
      if (session.plannedExecution) {
        void this.drainZkTlsQueue(session.sessionId)
        return this.stateFromSession(session)
      }
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
    this.appendZkTlsDiagnostic(session, {
      at: this.dependencies.now(),
      stage: 'watcher-bootstrapped',
      status: 'passed',
    })
    await this.dependencies.storage.setSession(session)
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
      isZkTlsSession(session) &&
      session.zkTlsQueue.some((item) => item.status === 'submitted')
    ) {
      session.status = 'submitting'
      const sessionGeneration = this.advanceGeneration()
      await this.dependencies.storage.setSession(session)
      if (this.generation !== sessionGeneration) {
        return this.getStateWithoutRetry()
      }
      await this.notify()
      void this.drainZkTlsQueue(session.sessionId)
      return this.stateFromSession(session)
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
    if (
      !isZkTlsSession(session) ||
      !session.zkTlsQueue.some((item) => item.status === 'paused')
    ) {
      session.error = null
      session.zkTlsFailureCode = null
    }
    this.appendZkTlsDiagnostic(session, {
      at: this.dependencies.now(),
      stage: 'watcher-ready',
      status: 'passed',
    })
    await this.dependencies.storage.setSession(session)
    if (this.generation !== sessionGeneration) {
      return this.getStateWithoutRetry()
    }
    await this.notify()
    return this.stateFromSession(session)
  }

  async handleDiagnostic(
    sender: ProductExperienceRuntimeSender,
    sessionId: string,
    event: ProductZkTlsDiagnosticEvent,
  ): Promise<ProductExperienceControllerState> {
    if (
      !this.dependencies.diagnosticsEnabled ||
      !['rule-evaluated', 'evidence-sent'].includes(event.stage) ||
      !Number.isFinite(event.at) ||
      !['running', 'passed', 'failed'].includes(event.status)
    )
      return this.getState()
    const stored = await this.dependencies.storage.getSession()
    if (
      !stored ||
      stored.sessionId !== sessionId ||
      !this.senderMatches(sender, stored)
    )
      return this.getState()
    const next = await this.mutateZkTlsSession(sessionId, (current) => {
      this.appendZkTlsDiagnostic(current, {
        ...event,
        at: this.dependencies.now(),
      })
    })
    if (!next) return this.getState()
    await this.notify()
    return this.stateFromSession(next)
  }

  async handleProofDiagnostic(
    proofSessionId: string,
    connectorId: string,
    correlationId: string,
    event: ProductZkTlsDiagnosticEvent,
  ): Promise<ProductExperienceControllerState> {
    if (
      !event.stage ||
      !/^[a-z0-9-]{1,100}$/.test(event.stage) ||
      !Number.isFinite(event.at) ||
      !['running', 'passed', 'failed'].includes(event.status)
    )
      return this.getState()
    const stored = await this.dependencies.storage.getSession()
    if (
      !stored ||
      !isZkTlsSession(stored) ||
      !stored.zkTlsQueue.some(
        (item) =>
          item.status === 'proving' &&
          item.sessionId === proofSessionId &&
          item.correlationId === correlationId &&
          item.connectorId === connectorId,
      )
    )
      return this.getState()
    const next = await this.mutateZkTlsSession(stored.sessionId, (current) => {
      const item = current.zkTlsQueue.find(
        (entry) =>
          entry.sessionId === proofSessionId &&
          entry.connectorId === connectorId &&
          entry.correlationId === correlationId,
      )
      if (!item || item.status !== 'proving') return false
      item.stage = event.stage
      item.details = safeDiagnosticDifferences(event.error)
      this.appendZkTlsDiagnostic(current, {
        ...event,
        at: this.dependencies.now(),
      })
    })
    if (!next) return this.getState()
    await this.notify()
    return this.stateFromSession(next)
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
      if (
        !isZkTlsSession(session) ||
        !session.zkTlsQueue.some((item) => item.status === 'paused')
      ) {
        session.zkTlsFailureCode = null
      }
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
    const [task, session] = await Promise.all([
      this.dependencies.storage.getTask(),
      this.dependencies.storage.getSession(),
    ])
    if (!task || !session) return this.getState()
    const invalid = await this.ensureSessionValid(task, session)
    if (invalid) return invalid
    if (session.pendingSubmit) return this.retryPendingSubmit()
    if (!isZkTlsSession(session)) return this.getState()
    const resumed = await this.mutateZkTlsSession(
      session.sessionId,
      (current) => {
        for (const item of current.zkTlsQueue) {
          if (item.status !== 'proving') continue
          item.status = 'queued'
          if (!reusableZkTlsSession(item, this.dependencies.now())) {
            item.sessionId = null
            item.connectorId = null
            item.expiresAt = null
          }
        }
        current.status = current.zkTlsQueue.some(
          (item) => item.status === 'submitted',
        )
          ? 'submitting'
          : 'observing'
      },
    )
    if (!resumed) return this.getStateWithoutRetry()
    void this.drainZkTlsQueue(resumed.sessionId)
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
      let added = false
      let rearmedPollKey: string | null = null
      const queued = await this.mutateZkTlsSession(
        session.sessionId,
        (current) => {
          const verified = terminalRuleIds(current)
          for (const evidence of sanitized) {
            if (verified.has(evidence.ruleId)) continue
            const existing = current.zkTlsQueue.find((item) =>
              (item.dependentRuleIds ?? [item.ruleId]).includes(
                evidence.ruleId,
              ),
            )
            if (existing) {
              if (existing.status === 'paused') {
                if (existing.dependentRuleIds) continue
                existing.status = 'queued'
                added = true
                continue
              }
              const pollKey = this.zkTlsPollKey(
                current.sessionId,
                evidence.ruleId,
              )
              const exhaustedSubmission =
                !existing.dependentRuleIds &&
                existing.status === 'submitted' &&
                this.exhaustedZkTlsPolls.has(pollKey)
              if (exhaustedSubmission || existing.status === 'queued') {
                if (exhaustedSubmission) {
                  existing.status = 'queued'
                  existing.sessionId = null
                  existing.connectorId = null
                  existing.expiresAt = null
                  rearmedPollKey = pollKey
                }
                added = true
              }
              continue
            }
            added = true
            current.zkTlsQueue.push({
              ruleId: evidence.ruleId,
              status: 'queued',
              sessionId: null,
              connectorId: null,
              expiresAt: null,
            })
          }
          if (!added) return false
          this.appendZkTlsDiagnostic(current, {
            at: this.dependencies.now(),
            stage: 'evidence-accepted',
            status: 'passed',
            details: { ruleIds: sanitized.map((match) => match.ruleId) },
          })
          if (this.zkTlsFlight?.sessionId === current.sessionId) {
            this.appendZkTlsDiagnostic(current, {
              at: this.dependencies.now(),
              stage: 'proof-queue-waiting',
              status: 'running',
              details: { ruleIds: sanitized.map((match) => match.ruleId) },
            })
          }
          if (!current.zkTlsQueue.some((item) => item.status === 'paused')) {
            current.error = null
            current.zkTlsFailureCode = null
          }
          return true
        },
      )
      if (!queued) return this.getStateWithoutRetry()
      if (!added) return this.stateFromSession(queued)
      if (rearmedPollKey) this.exhaustedZkTlsPolls.delete(rearmedPollKey)
      await this.notify()
      void this.drainZkTlsQueue(queued.sessionId, true)
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
    ) => unknown,
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
      if (mutate(next) === false) {
        result = clone(stored)
        return
      }
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

  async retryRule(
    campaignId: string,
    ruleId: string,
  ): Promise<ProductExperienceControllerState> {
    const task = await this.dependencies.storage.getTask()
    const session = await this.dependencies.storage.getSession()
    if (
      !task ||
      !isZkTlsSession(session) ||
      task.campaignId !== campaignId ||
      !taskMatchesSession(task, session)
    )
      return this.getStateWithoutRetry()
    const invalid = await this.ensureSessionValid(task, session)
    if (invalid) return invalid
    if (
      !session.rules.some((rule) => rule.id === ruleId) ||
      terminalRuleIds(session).has(ruleId)
    )
      return this.stateFromSession(session)
    const resumed = await this.mutateZkTlsSession(
      session.sessionId,
      (current) => {
        const item = current.zkTlsQueue.find(
          (entry) =>
            entry.status === 'paused' &&
            (entry.dependentRuleIds ?? [entry.ruleId]).includes(ruleId),
        )
        if (
          !item ||
          current.status === 'reauthorize' ||
          (!current.currentOriginAllowed && !current.plannedExecution)
        )
          return false
        item.status = 'queued'
        item.failureCode = null
        item.actionRequired = false
        if (!current.zkTlsQueue.some((entry) => entry.status === 'paused')) {
          current.error = null
          current.zkTlsFailureCode = null
        }
        return true
      },
    )
    if (resumed) void this.drainZkTlsQueue(session.sessionId, true)
    return this.getStateWithoutRetry()
  }

  private async drainZkTlsQueueAfterCurrentFlight(
    sessionId: string,
  ): Promise<void> {
    const active = this.zkTlsFlight
    if (active?.sessionId === sessionId) await active.promise
    const session = await this.mutateZkTlsSession(sessionId, (current) => {
      let resumed = false
      for (const item of current.zkTlsQueue) {
        if (item.status !== 'paused') continue
        item.status = 'queued'
        resumed = true
      }
      if (!resumed) return false
      current.error = null
      current.zkTlsFailureCode = null
      return true
    })
    if (!session) return
    await this.drainZkTlsQueue(sessionId)
  }

  private async drainZkTlsQueue(
    sessionId: string,
    hasNewQueuedWork = false,
  ): Promise<void> {
    const active = this.zkTlsFlight
    if (active?.sessionId === sessionId) {
      if (hasNewQueuedWork) active.drainRequested = true
      return active.promise
    }
    if (active) {
      const session = await this.dependencies.storage.getSession()
      if (!isZkTlsSession(session) || session.sessionId !== sessionId) return
      const current = this.zkTlsFlight
      if (current?.sessionId === sessionId) {
        if (hasNewQueuedWork) current.drainRequested = true
        return current.promise
      }
    }
    const flight: ProductExperienceZkTlsFlight = {
      sessionId,
      drainRequested: false,
      promise: Promise.resolve(),
    }
    flight.promise = this.runZkTlsQueue(sessionId, flight).finally(() => {
      if (this.zkTlsFlight !== flight) return
      this.zkTlsFlight = null
      if (flight.drainRequested) void this.drainZkTlsQueue(sessionId)
    })
    this.zkTlsFlight = flight
    return flight.promise
  }

  private async runZkTlsQueue(
    sessionId: string,
    flight: ProductExperienceZkTlsFlight,
  ): Promise<void> {
    while (true) {
      const session = await this.dependencies.storage.getSession()
      if (!isZkTlsSession(session) || session.sessionId !== sessionId) return
      if (
        session.status === 'reauthorize' ||
        (!session.currentOriginAllowed && !session.plannedExecution) ||
        session.error === 'AUTHORIZATION_REQUIRED'
      )
        return
      const item =
        session.zkTlsQueue.find(
          (entry) =>
            entry.binding &&
            entry.status === 'submitted' &&
            !this.exhaustedZkTlsPolls.has(
              this.zkTlsPollKey(session.sessionId, entry.ruleId),
            ),
        ) ??
        session.zkTlsQueue.find(
          (entry) => entry.status === 'queued' || entry.status === 'proving',
        ) ??
        session.zkTlsQueue.find(
          (entry) =>
            entry.status === 'submitted' &&
            !this.exhaustedZkTlsPolls.has(
              this.zkTlsPollKey(session.sessionId, entry.ruleId),
            ),
        )
      if (!item) return

      if (item.status === 'submitted') {
        if (
          !(await this.pollZkTlsProgress(
            session.sessionId,
            item.ruleId,
            flight,
          ))
        ) {
          // One submitted attempt gets one bounded polling lifecycle. New DOM
          // rules remain durable, but they must not restart an exhausted poll.
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
            if (!reusableZkTlsSession(interrupted, this.dependencies.now())) {
              interrupted.sessionId = null
              interrupted.connectorId = null
              interrupted.expiresAt = null
            }
          },
        )
        if (!reset) return
      }

      let started = reusableZkTlsSession(item, this.dependencies.now())
      if (!started) {
        if (this.dependencies.diagnosticsEnabled) {
          const requesting = await this.mutateZkTlsSession(
            session.sessionId,
            (current) => {
              const queued = current.zkTlsQueue.find(
                (entry) => entry.ruleId === item.ruleId,
              )
              if (!queued || queued.status !== 'queued') return false
              this.appendZkTlsDiagnostic(current, {
                at: this.dependencies.now(),
                stage: 'proof-session-requested',
                status: 'running',
                details: { ruleId: item.ruleId },
              })
              return true
            },
          )
          if (!requesting) return
          await this.notify()
        }
        try {
          started = await this.dependencies.startZkTls({
            campaignId: session.campaignId,
            ruleId: item.ruleId,
            ticketKind: session.ticketKind,
          })
        } catch (error) {
          await this.resetZkTlsItem(
            session.sessionId,
            item.ruleId,
            'VERIFICATION_FAILED',
            true,
            null,
            'paused',
            error,
          )
          flight.drainRequested = true
          return
        }
      }

      const correlationId =
        session.zkTlsDiagnostic?.correlationId ??
        this.dependencies.randomSessionId()
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
          queued.correlationId = correlationId
          queued.stage = 'proof-session-ready'
          queued.details = undefined
          if (started.executionPlan) {
            const step = started.executionPlan.steps.find(
              (entry) => entry.connectorId === started.connectorId,
            )
            if (
              !step?.dependentRuleIds.includes(queued.ruleId) ||
              step.dependentRuleIds.some(
                (id) => !current.rules.some((rule) => rule.id === id),
              )
            ) {
              queued.status = 'paused'
              queued.failureCode = 'UNSUPPORTED_CONNECTOR'
              current.error = 'VERIFICATION_FAILED'
              return
            }
            queued.dependentRuleIds = [...step.dependentRuleIds]
            queued.binding = step.dependentFactIds.length === 0
            current.zkTlsQueue = current.zkTlsQueue.filter(
              (entry) =>
                entry === queued ||
                !step.dependentRuleIds.includes(entry.ruleId),
            )
            if (!queued.binding) {
              for (const next of started.executionPlan.steps) {
                if (next.dependentFactIds.length === 0) continue
                const ruleId = next.dependentRuleIds.find(
                  (id) =>
                    current.rules.some((rule) => rule.id === id) &&
                    !terminalRuleIds(current).has(id),
                )
                if (
                  !ruleId ||
                  current.zkTlsQueue.some((entry) =>
                    (entry.dependentRuleIds ?? [entry.ruleId]).includes(ruleId),
                  )
                )
                  continue
                current.zkTlsQueue.push({
                  ruleId,
                  status: 'queued',
                  sessionId: null,
                  connectorId: null,
                  expiresAt: null,
                })
              }
            }
          }
          queued.failureCode = null
          queued.actionRequired = false
          current.status = 'submitting'
          if (!current.zkTlsQueue.some((item) => item.status === 'paused')) {
            current.error = null
            current.zkTlsFailureCode = null
          }
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
          correlationId,
          expiresAt: started.expiresAt,
          onDiagnostic: async (event) => {
            await this.handleProofDiagnostic(
              started.sessionId,
              started.connectorId,
              correlationId,
              event,
            )
          },
        })
      } catch {
        await this.resetZkTlsItem(
          session.sessionId,
          item.ruleId,
          'VERIFICATION_FAILED',
          false,
          'ZKTLS_UNKNOWN_FAILURE',
          'paused',
        )
        flight.drainRequested = true
        return
      }

      if (result.status !== 'submitted') {
        const publicError =
          result.status === 'pending_login' ||
          result.code === 'PERMISSION_DENIED'
            ? 'AUTHORIZATION_REQUIRED'
            : result.code === 'SESSION_EXPIRED'
              ? 'SESSION_EXPIRED'
              : 'VERIFICATION_FAILED'
        await this.resetZkTlsItem(
          session.sessionId,
          item.ruleId,
          publicError,
          result.code === 'SESSION_EXPIRED',
          publicError === 'VERIFICATION_FAILED'
            ? safeZkTlsFailureCode(result.code)
            : null,
          'paused',
          undefined,
          result.status === 'action_required',
        )
        flight.drainRequested = true
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
          if (!current.zkTlsQueue.some((item) => item.status === 'paused')) {
            current.error = null
            current.zkTlsFailureCode = null
          }
        },
      )
      if (!submitted) return
    }
  }

  private async resetZkTlsItem(
    sessionId: string,
    ruleId: string,
    error: ProductExperiencePublicError = 'VERIFICATION_FAILED',
    clearSession = true,
    failureCode: ProductZkTlsFailureCode | null = null,
    queueStatus: 'queued' | 'paused' = 'queued',
    diagnosticError?: unknown,
    actionRequired = false,
  ): Promise<void> {
    const reset = await this.mutateZkTlsSession(sessionId, (current) => {
      const item = current.zkTlsQueue.find((entry) => entry.ruleId === ruleId)
      if (!item) return
      const authorizationRequired =
        current.status === 'reauthorize' ||
        (!current.currentOriginAllowed && !current.plannedExecution) ||
        current.error === 'AUTHORIZATION_REQUIRED'
      item.status = queueStatus
      item.failureCode = failureCode ?? 'ZKTLS_UNKNOWN_FAILURE'
      item.actionRequired = actionRequired
      if (clearSession) {
        item.sessionId = null
        item.connectorId = null
        item.expiresAt = null
      }
      current.status =
        authorizationRequired || error === 'AUTHORIZATION_REQUIRED'
          ? 'reauthorize'
          : 'observing'
      current.error = authorizationRequired ? 'AUTHORIZATION_REQUIRED' : error
      current.zkTlsFailureCode =
        !authorizationRequired && error === 'VERIFICATION_FAILED'
          ? (failureCode ?? 'ZKTLS_UNKNOWN_FAILURE')
          : null
      if (diagnosticError !== undefined) {
        this.appendZkTlsDiagnostic(current, {
          at: this.dependencies.now(),
          stage: 'proof-session-failed',
          status: 'failed',
          details: { ruleId },
          error: diagnosticError,
        })
      }
    })
    if (reset) await this.notify()
  }

  private async pollZkTlsProgress(
    sessionId: string,
    activeRuleId: string,
    flight: ProductExperienceZkTlsFlight,
  ): Promise<boolean> {
    const pollKey = this.zkTlsPollKey(sessionId, activeRuleId)
    this.exhaustedZkTlsPolls.delete(pollKey)
    for (const delayMs of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await wait(delayMs)
      if (flight.drainRequested) {
        return false
      }
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
        if (
          beforePoll.ticketKind === 'TEST' &&
          this.dependencies.readIntegration
        ) {
          const check = await this.dependencies.readIntegration(
            beforePoll.campaignId,
          )
          if (
            check.configVersion === beforePoll.configVersion &&
            check.experiencePassed
          ) {
            const completed = await this.mutateZkTlsSession(
              sessionId,
              (current) => {
                current.zkTlsTestPassed = true
                current.zkTlsQueue = []
                current.status = 'observing'
                current.error = null
                current.zkTlsFailureCode = null
              },
            )
            if (completed) await this.notify()
            return false
          }
        }
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
      const activeProgress = progress.find(
        (entry) => entry.ruleId === activeRuleId,
      )
      const attemptFinishedWithoutVerification =
        activeProgress?.status === 'PARTIAL' ||
        activeProgress?.status === 'INSUFFICIENT_DATA'
      const updated = await this.mutateZkTlsSession(sessionId, (current) => {
        const authorizationRequired =
          current.status === 'reauthorize' ||
          (!current.currentOriginAllowed && !current.plannedExecution) ||
          current.error === 'AUTHORIZATION_REQUIRED'
        const terminal = terminalRuleIds(current)
        current.zkTlsProgress = current.rules.flatMap((rule) => {
          const previous = current.zkTlsProgress.find(
            (entry) => entry.ruleId === rule.id,
          )
          const next = terminal.has(rule.id)
            ? previous
            : (progress.find((entry) => entry.ruleId === rule.id) ?? previous)
          return next ? [clone(next)] : []
        })
        const durableVerified = new Set([
          ...current.verifiedRuleIds,
          ...verified,
        ])
        current.verifiedRuleIds = current.rules
          .map((rule) => rule.id)
          .filter((ruleId) => durableVerified.has(ruleId))
        current.zkTlsQueue = current.zkTlsQueue.filter((item) => {
          if (
            !(item.dependentRuleIds ?? [item.ruleId]).every((id) =>
              terminalRuleIds(current).has(id),
            )
          )
            return true
          if (!item.dependentRuleIds) return false
          item.status = 'completed'
          item.stage = 'backend-confirmed'
          item.failureCode = null
          return true
        })
        if (attemptFinishedWithoutVerification) {
          const completed = current.zkTlsQueue.find(
            (item) => item.ruleId === activeRuleId,
          )
          if (completed?.binding && activeProgress?.status === 'PARTIAL') {
            completed.status = 'queued'
            completed.sessionId = null
            completed.connectorId = null
            completed.expiresAt = null
            completed.binding = false
          } else if (completed?.dependentRuleIds) {
            completed.status = 'paused'
            completed.actionRequired = true
            completed.failureCode =
              activeProgress?.status === 'INSUFFICIENT_DATA'
                ? 'INSUFFICIENT_DATA'
                : 'PARTIAL'
            completed.stage = 'backend-progress'
            completed.sessionId = null
            completed.connectorId = null
            completed.expiresAt = null
          } else {
            current.zkTlsQueue = current.zkTlsQueue.filter(
              (item) => item.ruleId !== activeRuleId,
            )
          }
        }
        if (!authorizationRequired) {
          const hasActive = current.zkTlsQueue.some(
            (item) => item.status === 'submitted' || item.status === 'proving',
          )
          const hasPaused = current.zkTlsQueue.some(
            (item) => item.status === 'paused',
          )
          current.status = hasActive ? 'submitting' : 'observing'
          if (hasPaused) {
            current.error ??= 'VERIFICATION_FAILED'
            current.zkTlsFailureCode ??= 'ZKTLS_UNKNOWN_FAILURE'
          } else {
            current.error = null
            current.zkTlsFailureCode = null
          }
        }
      })
      if (!updated) return false
      if (updated.verifiedRuleIds.length === updated.rules.length) {
        if (
          updated.plannedExecution ||
          updated.zkTlsQueue.some((item) => item.dependentRuleIds)
        ) {
          await this.notify()
          return false
        }
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
      if (
        updated.status === 'reauthorize' ||
        (!updated.currentOriginAllowed && !updated.plannedExecution) ||
        updated.error === 'AUTHORIZATION_REQUIRED'
      ) {
        await this.notify()
        return false
      }
      if (attemptFinishedWithoutVerification) {
        await this.notify()
        return true
      }
      if (allZkTlsConditionsFinished(updated)) {
        await this.notify()
        return false
      }
      if (!updated.zkTlsQueue.some((item) => item.ruleId === activeRuleId))
        return true
    }
    this.exhaustedZkTlsPolls.add(pollKey)
    return false
  }

  private zkTlsPollKey(sessionId: string, ruleId: string): string {
    return `${sessionId}\u0000${ruleId}`
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
    if (
      !isZkTlsSession(session) ||
      !session.zkTlsQueue.some((item) => item.status === 'paused')
    ) {
      session.zkTlsFailureCode = null
    }
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
      this.appendZkTlsDiagnostic(session, {
        at: this.dependencies.now(),
        stage: 'page-watcher-injected',
        status: 'passed',
      })
      await this.dependencies.storage.setSession(session)
      await this.notify()
      return this.generation === expectedGeneration
        ? this.stateFromSession(session)
        : this.getStateWithoutRetry()
    } catch (error) {
      if (this.generation !== expectedGeneration) {
        return this.getStateWithoutRetry()
      }
      if (failureMode === 'reauthorize') {
        const sessionGeneration = this.advanceGeneration()
        session.status = 'reauthorize'
        session.error = 'AUTHORIZATION_REQUIRED'
        session.zkTlsFailureCode = null
        this.appendZkTlsDiagnostic(session, {
          at: this.dependencies.now(),
          stage: 'page-watcher-injected',
          status: 'failed',
          error,
        })
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
    const authorizationRequired =
      session.status === 'reauthorize' ||
      session.error === 'AUTHORIZATION_REQUIRED'
    const status =
      isZkTlsSession(session) &&
      allZkTlsConditionsFinished(session) &&
      session.verifiedRuleIds.length === session.rules.length
        ? 'verified'
        : authorizationRequired
          ? 'reauthorize'
          : isZkTlsSession(session) &&
              session.zkTlsQueue.some((item) => item.status === 'submitted')
            ? 'submitting'
            : session.status
    return {
      campaignId: session.campaignId,
      title: session.title,
      status,
      matchedRuleIds: isZkTlsSession(session)
        ? clone(session.verifiedRuleIds)
        : session.matches.map((match) => match.ruleId),
      totalRuleCount: session.rules.length,
      authorizationRequired,
      currentOriginAllowed: session.currentOriginAllowed,
      error: session.error,
      zkTlsFailureCode: isZkTlsSession(session)
        ? (session.zkTlsFailureCode ?? null)
        : null,
      ...(isZkTlsSession(session)
        ? {
            zkTlsProgress: clone(session.zkTlsProgress),
            zkTlsFinished: allZkTlsConditionsFinished(session),
            ...(session.zkTlsTestPassed ? { zkTlsTestPassed: true } : {}),
            zkTlsConditions: session.rules.map(
              (rule): ProductZkTlsCondition => {
                const progress = session.zkTlsProgress.find(
                  (entry) => entry.ruleId === rule.id,
                )
                const item = session.zkTlsQueue.find((entry) =>
                  (entry.dependentRuleIds ?? [entry.ruleId]).includes(rule.id),
                )
                return {
                  ruleId: rule.id,
                  title: rule.title,
                  status:
                    progress?.status === 'VERIFIED_NO'
                      ? 'verified_no'
                      : session.verifiedRuleIds.includes(rule.id)
                        ? 'verified'
                        : item?.status === 'paused'
                          ? item.actionRequired
                            ? 'action_required'
                            : 'failed'
                          : item?.status === 'completed'
                            ? 'verified'
                            : (item?.status ?? 'pending'),
                  code: item?.failureCode ?? null,
                  stage: item?.stage ?? null,
                  correlationId: item?.correlationId ?? null,
                  ...(item?.details?.length
                    ? { details: clone(item.details) }
                    : {}),
                  ...(progress?.status === 'VERIFIED_NO'
                    ? {
                        actual: progress.actual ?? progress.current,
                        required: progress.required ?? progress.target,
                        comparator: progress.comparator ?? null,
                      }
                    : {}),
                }
              },
            ),
          }
        : {}),
      ...(session.zkTlsDiagnostic
        ? { zkTlsDiagnostic: clone(session.zkTlsDiagnostic) }
        : {}),
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
